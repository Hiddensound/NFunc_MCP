/**
 * Core Web Vitals field data → priorities and defect prose.
 *
 * The lab side of a PSI response goes through the existing
 * `formatLighthouseFinding` path unchanged. This module handles the CrUX half,
 * where the inputs are 75th-percentile measurements from real users rather
 * than audit scores, so neither the impact-weight mapping nor the WCAG
 * technique table applies.
 *
 * Field findings are written to read differently from lab findings on purpose.
 * A lab finding says the page did something under simulation; a field finding
 * says a measurable share of real people already experienced it. That
 * distinction is the whole reason to call PSI, and it should survive into the
 * defect ticket.
 */

import type { Finding, Priority } from "../types.js";
import type { CruxMetric, WebVital } from "../utils/psiParser.js";

export type VitalRating = "good" | "needs-improvement" | "poor";

interface VitalSpec {
  label: string;
  /** Upper bound of "good", and of "needs improvement". Units match CruxMetric.p75. */
  good: number;
  needsImprovement: number;
  /**
   * Core Web Vitals affect Google ranking and gate a release. FCP and TTFB are
   * diagnostics that explain *why* a vital fails; letting them reach P1 repeats
   * the Phase 13 mistake of ranking supporting metrics level with headline
   * ones, so they cap at P2.
   */
  isCoreVital: boolean;
}

/** Google's official p75 boundaries. */
const VITALS: Record<WebVital, VitalSpec> = {
  lcp: { label: "Largest Contentful Paint", good: 2500, needsImprovement: 4000, isCoreVital: true },
  inp: { label: "Interaction to Next Paint", good: 200, needsImprovement: 500, isCoreVital: true },
  cls: { label: "Cumulative Layout Shift", good: 0.1, needsImprovement: 0.25, isCoreVital: true },
  fcp: { label: "First Contentful Paint", good: 1800, needsImprovement: 3000, isCoreVital: false },
  ttfb: { label: "Time to First Byte", good: 800, needsImprovement: 1800, isCoreVital: false },
};

export function vitalLabel(vital: WebVital): string {
  return VITALS[vital].label;
}

/**
 * LCP, INP and CLS gate a release and affect ranking; FCP and TTFB explain
 * them. Exported because the priority cap has to hold everywhere a priority is
 * decided, not just where one is first assigned.
 */
export function isCoreVital(vital: WebVital): boolean {
  return VITALS[vital].isCoreVital;
}

/**
 * Rate a p75 value against Google's thresholds.
 *
 * PSI also returns its own FAST/AVERAGE/SLOW `category` per metric, and the two
 * agree in practice. We classify from the published thresholds anyway, so that
 * the boundary a finding was raised at is a documented number in this file
 * rather than a verdict from an opaque field — and so origin-level and
 * URL-level metrics are graded identically.
 */
export function classifyVital(vital: WebVital, p75: number): VitalRating {
  const spec = VITALS[vital];
  if (p75 <= spec.good) return "good";
  if (p75 <= spec.needsImprovement) return "needs-improvement";
  return "poor";
}

/**
 * Poor → P1, needs improvement → P2, good → no finding (never report a passing
 * check). Non-core diagnostics cap at P2.
 */
export function fieldVitalToPriority(
  vital: WebVital,
  p75: number,
): Priority | null {
  const rating = classifyVital(vital, p75);
  if (rating === "good") return null;
  if (rating === "needs-improvement") return "P2";
  return VITALS[vital].isCoreVital ? "P1" : "P2";
}

/** Human-readable measurement. CLS is unitless; everything else is milliseconds. */
export function formatVitalValue(vital: WebVital, value: number): string {
  if (vital === "cls") return value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
  return value >= 1000 ? `${(value / 1000).toFixed(1)} s` : `${Math.round(value)} ms`;
}

/** "7 in 10 users" reads more concretely in a ticket than "0.7019". */
function shareOfUsers(proportion: number): string {
  const pct = Math.round(proportion * 100);
  return `${pct}% of real users`;
}

type FieldTemplater = (m: CruxMetric, value: string, poor: string) => string;

/**
 * Defect prose for each vital, in the register `defectFormatter.ts` established:
 * what the user experiences, not what the metric is called.
 *
 * Every template states the share of real users in the poor bucket. A p75 alone
 * invites the reply "that's just the tail" — naming the proportion answers it
 * before it is asked, and the number is already in the response.
 */
const FIELD_DESCRIPTIONS: Record<WebVital, FieldTemplater> = {
  lcp: (_m, value, poor) =>
    `Real users wait ${value} for the main page content to appear (75th percentile, trailing 28 days). ${poor} experience a load slow enough to be rated poor, well past the point where visitors begin abandoning the page.`,
  inp: (_m, value, poor) =>
    `The page takes ${value} to respond visibly after a real user taps or clicks (75th percentile, trailing 28 days). ${poor} experience responsiveness rated poor — taps appear to do nothing, so users tap again and trigger duplicate actions.`,
  cls: (_m, value, poor) =>
    `Real users see the layout shift by ${value} while the page loads (75th percentile, trailing 28 days). ${poor} experience shifting rated poor, which causes mis-taps on the wrong control and loss of reading position.`,
  fcp: (_m, value, poor) =>
    `Real users stare at a blank screen for ${value} before anything paints (75th percentile, trailing 28 days). ${poor} experience a first paint rated poor. This is a diagnostic for the slow Largest Contentful Paint rather than a defect to fix on its own.`,
  ttfb: (_m, value, poor) =>
    `The server takes ${value} to return the first byte for real users (75th percentile, trailing 28 days). ${poor} experience a response rated poor; every downstream resource waits on this, so it caps how fast the rest of the page can possibly be.`,
};

/**
 * One field metric → a Finding, or null when real users are having a fine time.
 *
 * `source` reaches the evidence deliberately. An origin-level metric describes
 * the whole site, not this page, and a reader deciding whether to act on the
 * finding needs to know which they are looking at.
 */
export function formatFieldFinding(
  vital: WebVital,
  metric: CruxMetric,
): Finding | null {
  const priority = fieldVitalToPriority(vital, metric.p75);
  if (!priority) return null;

  const value = formatVitalValue(vital, metric.p75);
  const poor = shareOfUsers(metric.distribution.poor);
  const spec = VITALS[vital];
  const scope = metric.source === "origin" ? " (site-wide data)" : "";

  return {
    priority,
    title: `${spec.label} is ${classifyVital(vital, metric.p75) === "poor" ? "poor" : "below target"} for real users${scope}`,
    description:
      FIELD_DESCRIPTIONS[vital](metric, value, poor) +
      (metric.source === "origin"
        ? " This URL has too little traffic for its own field data, so these figures describe the whole origin and may not reflect this page."
        : ""),
    evidence: {
      audit_id: `crux.${vital}`,
      value,
      threshold: formatVitalValue(vital, spec.good),
      field_source: metric.source,
      users_affected_pct: Math.round(metric.distribution.poor * 100),
    },
  };
}

/** Every failing field metric in a parsed CrUX block, unsorted. */
export function formatFieldFindings(
  metrics: Partial<Record<WebVital, CruxMetric>>,
): Finding[] {
  const findings: Finding[] = [];
  for (const [vital, metric] of Object.entries(metrics) as Array<
    [WebVital, CruxMetric]
  >) {
    const finding = formatFieldFinding(vital, metric);
    if (finding) findings.push(finding);
  }
  return findings;
}
