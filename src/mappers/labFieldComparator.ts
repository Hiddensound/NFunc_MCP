/**
 * Lab versus field disagreement — the reason this tool exists.
 *
 * A Lighthouse run is a simulation on one machine under one throttling
 * profile. CrUX is what actually happened to real people. When the two agree,
 * confidence is high. When they disagree, the direction of the disagreement is
 * itself the finding, and it is not available from any other tool in this MCP.
 *
 * The Five Below homepage is the canonical case: lab CLS 0 against field CLS
 * 0.55, and lab LCP 11.6 s against field LCP 2.8 s — both metrics inverted, in
 * opposite directions, on one page. A report built on the lab numbers alone
 * led with an LCP emergency real users were not experiencing and missed a
 * layout-shift failure that 70% of them were.
 */

import type { Priority } from "../types.js";
import type { CruxMetric, LabMetrics, ParsedCrux, WebVital } from "../utils/psiParser.js";
import { classifyVital, formatVitalValue, isCoreVital, vitalLabel } from "./webVitalsMapper.js";

export type LabFieldVerdict =
  | "confirmed"        // both fail — highest confidence
  | "worse_in_field"   // lab passes, field fails — the test environment is lying
  | "worse_in_lab"     // lab fails, field passes — over-throttled relative to the real audience
  | "both_pass";

export interface MetricComparison {
  metric: WebVital;
  label: string;
  lab: number | null;
  lab_display: string | null;
  field_p75: number;
  field_display: string;
  field_source: CruxMetric["source"];
  verdict: LabFieldVerdict;
  note: string;
}

/**
 * Lab audits that measure the same thing as a field metric.
 *
 * INP is deliberately absent, and its absence is load-bearing. Lighthouse
 * cannot produce an INP value at all — INP requires a real interaction, and a
 * lab run never interacts with the page. Total Blocking Time is a *proxy* for
 * responsiveness, not the same measurement, so comparing them would manufacture
 * agreement or disagreement out of two different quantities. INP field findings
 * therefore pass through the comparator untouched, which is why the systemic
 * collapse rule in the aggregator has to exist.
 */
const LAB_EQUIVALENT: Partial<Record<WebVital, keyof LabMetrics>> = {
  lcp: "lcpMs",
  cls: "cls",
  fcp: "fcpMs",
  ttfb: "ttfbMs",
};

/** Lighthouse audit ids, for matching a lab finding back to the vital it measures. */
export const AUDIT_TO_VITAL: Record<string, WebVital> = {
  "largest-contentful-paint": "lcp",
  "cumulative-layout-shift": "cls",
  "first-contentful-paint": "fcp",
  "server-response-time": "ttfb",
};

function noteFor(
  verdict: LabFieldVerdict,
  vital: WebVital,
  labDisplay: string | null,
  fieldDisplay: string,
): string {
  const name = vitalLabel(vital);
  switch (verdict) {
    case "confirmed":
      return `${name} fails in the lab (${labDisplay}) and for real users (${fieldDisplay}). Confirmed by two independent measurements — treat as real and fix.`;
    case "worse_in_field":
      return `The lab run passed ${name} at ${labDisplay}, but real users are at ${fieldDisplay}. The test environment is not reproducing what people actually experience — a real-world network, device class, geography or a third-party script that only loads in production. This is the highest-value finding type here, because no local tool can surface it.`;
    case "worse_in_lab":
      return `${name} fails in the lab (${labDisplay}) but real users are at ${fieldDisplay}, which passes. The lab profile is harsher than this page's actual audience. Treat the lab number as a stress signal rather than a user-experienced defect, and prioritise accordingly.`;
    case "both_pass":
      return `${name} is within target in both the lab (${labDisplay}) and the field (${fieldDisplay}).`;
  }
}

/**
 * Compare every field metric that has a lab counterpart.
 *
 * `both_pass` rows are returned rather than filtered, because the comparison
 * table in the report is a statement about coverage — a reader needs to see
 * that LCP was checked and agreed, not infer it from an absence.
 */
export function compareLabField(
  lab: LabMetrics,
  field: ParsedCrux | null,
): MetricComparison[] {
  if (!field) return [];

  const comparisons: MetricComparison[] = [];
  for (const [vital, labKey] of Object.entries(LAB_EQUIVALENT) as Array<
    [WebVital, keyof LabMetrics]
  >) {
    const fieldMetric = field.metrics[vital];
    if (!fieldMetric) continue;

    const labValue = lab[labKey];
    const fieldFails = classifyVital(vital, fieldMetric.p75) !== "good";
    // No lab reading is not a pass; it is an unknown, and the field number
    // stands on its own.
    const labFails = labValue === null ? fieldFails : classifyVital(vital, labValue) !== "good";

    const verdict: LabFieldVerdict =
      labFails && fieldFails ? "confirmed"
      : !labFails && fieldFails ? "worse_in_field"
      : labFails && !fieldFails ? "worse_in_lab"
      : "both_pass";

    const labDisplay = labValue === null ? null : formatVitalValue(vital, labValue);
    const fieldDisplay = formatVitalValue(vital, fieldMetric.p75);

    comparisons.push({
      metric: vital,
      label: vitalLabel(vital),
      lab: labValue,
      lab_display: labDisplay,
      field_p75: fieldMetric.p75,
      field_display: fieldDisplay,
      field_source: fieldMetric.source,
      verdict,
      note: noteFor(verdict, vital, labDisplay, fieldDisplay),
    });
  }

  return comparisons;
}

const UP: Record<Priority, Priority> = { P1: "P1", P2: "P1", P3: "P2" };
const DOWN: Record<Priority, Priority> = { P1: "P2", P2: "P3", P3: "P3" };

/**
 * Promote, but never past a diagnostic's ceiling.
 *
 * `webVitalsMapper` caps FCP and TTFB at P2 because they explain a Core Web
 * Vital rather than being one. Field confirmation makes a finding more
 * certain, not more important, so an unguarded promotion quietly defeated that
 * cap and put FCP at P1 above the LCP it was describing.
 */
export function promote(priority: Priority, vital?: WebVital): Priority {
  const promoted = UP[priority];
  if (vital && !isCoreVital(vital) && promoted === "P1") return "P2";
  return promoted;
}

export function demote(priority: Priority): Priority {
  return DOWN[priority];
}

/**
 * How a verdict should move a finding's priority.
 *
 * Field observation outranks simulation, so the two adjustments are not
 * symmetric in what they mean: a promotion says "real users confirm this", a
 * demotion says "only the simulation saw this". A demoted finding is tagged
 * rather than dropped — the lab number is still true, it just is not evidence
 * of user harm, and silently deleting it would hide a genuine regression
 * signal from anyone comparing runs over time.
 */
export function adjustmentFor(verdict: LabFieldVerdict): {
  direction: "promote" | "demote" | "none";
  tag?: string;
} {
  switch (verdict) {
    case "confirmed":
      return { direction: "promote", tag: "field_confirmed" };
    case "worse_in_field":
      return { direction: "promote", tag: "field_only" };
    case "worse_in_lab":
      return { direction: "demote", tag: "lab_only" };
    default:
      return { direction: "none" };
  }
}
