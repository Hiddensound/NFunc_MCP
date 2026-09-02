/**
 * Cross-run arithmetic.
 *
 * This module owns every number that describes the audit as a whole, because
 * that is precisely where reading JSON by hand goes wrong. The manual Five
 * Below report got "TBT fails on 22/22 pages" right and the direction of the
 * CrUX CLS disagreement backwards, in the same document — the first is a count
 * and the second is a comparison, and a human doing 26 files will eventually
 * miss one. Everything here is computed so the report can quote rather than
 * derive.
 *
 * It also owns the two redundancy rules, because both need the page set in
 * view. A single-URL audit should still report every failing metric; the
 * repetition only exists across a set.
 */

import type { Finding, Priority } from "../types.js";
import type { LabMetrics, ParsedCrux, WebVital } from "../utils/psiParser.js";
import { classifyVital, formatVitalValue, vitalLabel } from "./webVitalsMapper.js";
import type { MetricComparison } from "./labFieldComparator.js";

export interface RunResult {
  template: string;
  label: string;
  url: string;
  strategy: string;
  runs: number;
  scores: Record<string, number>;
  lab: LabMetrics;
  field: ParsedCrux | null;
  comparisons: MetricComparison[];
  findings: Finding[];
  report_file: string;
}

/** A vital failing on at least this share of runs is a candidate for collapse. */
const SYSTEMIC_THRESHOLD = 0.8;

/**
 * ...but only if it also varies little between pages.
 *
 * Ubiquity alone is not enough, and the first implementation of this rule got
 * it wrong: it collapsed CLS, which fails on 25 of 25 Five Below runs but
 * ranges 0.18 to 0.85 — a 4.7x spread that is the single most page-specific
 * signal in the dataset. Collapsing it would have deleted the finding the
 * whole tool exists to surface.
 *
 * A shared-code characteristic looks the same everywhere: INP fails on every
 * page within a 2.1x band. A per-page defect that happens to be widespread
 * does not. So collapse requires both — fails nearly everywhere *and* barely
 * moves between pages.
 */
const SYSTEMIC_MAX_SPREAD = 2.5;

/** Lab-only metrics with no field counterpart, needed for the universal-failure counts. */
const LAB_THRESHOLDS: Record<string, { label: string; good: number; unit: "ms" | "score" }> = {
  tbtMs: { label: "Total Blocking Time", good: 200, unit: "ms" },
};

const PRIORITY_RANK: Record<Priority, number> = { P1: 0, P2: 1, P3: 2 };

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : Math.round(values.reduce((a, b) => a + b, 0) / values.length);
}

/**
 * Rule 2 — component suppression.
 *
 * FCP is a component of LCP: if the largest element paints late, the first one
 * usually did too. Across the Five Below batch the two co-occurred on 17 of 25
 * runs and FCP never once reached P1, so an FCP finding alongside an LCP
 * finding is two tickets describing one defect. The FCP measurement is kept as
 * evidence on the LCP finding rather than discarded.
 *
 * TTFB is deliberately *not* treated this way. It fired on one run out of 25,
 * which is the signature of a metric carrying independent information.
 */
export function suppressComponentFindings(findings: Finding[]): Finding[] {
  const lcp = findings.find((f) => f.evidence.audit_id === "crux.lcp");
  const fcp = findings.find((f) => f.evidence.audit_id === "crux.fcp");
  if (!lcp || !fcp) return findings;

  lcp.evidence = {
    ...lcp.evidence,
    supporting_fcp: fcp.evidence.value,
    note: "First Contentful Paint is also below target; it is a component of this metric, not a separate defect.",
  };
  return findings.filter((f) => f !== fcp);
}

export interface SystemicResult {
  findings: Finding[];
  /** Vitals whose per-page findings this replaces. */
  collapsedVitals: WebVital[];
}

/**
 * Rule 1 — systemic collapse.
 *
 * A vital rated below "good" on 80%+ of runs is describing the site, not any
 * one page. INP failed on 25 of 25 Five Below runs with a 2.1x spread and a
 * 316 ms median: twenty-five findings that each say "fix this page" when the
 * true statement is "this site's interaction handling is uniformly mediocre".
 *
 * The threshold is deliberately well above a simple majority — a vital failing
 * on half the pages is discriminating between them, and that is information
 * worth keeping per page.
 *
 * Priority is the worst observed, not an average: a vital that is poor
 * everywhere is not less urgent for being ubiquitous.
 */
export function collapseSystemicFindings(runs: RunResult[]): SystemicResult {
  const findings: Finding[] = [];
  const collapsedVitals: WebVital[] = [];
  if (runs.length < 3) return { findings, collapsedVitals };

  const vitals: WebVital[] = ["lcp", "inp", "cls", "fcp", "ttfb"];

  for (const vital of vitals) {
    // Only URL-level measurements can support a site-wide conclusion.
    //
    // Origin-level CrUX is *the same number* repeated for every page that falls
    // back to it, so both tests below are guaranteed to pass on it: the failure
    // rate is 100% and the spread is exactly 1.0x. That manufactured a
    // "fails everywhere and varies little between pages" finding from what was
    // literally one measurement copied across three runs. The spread gate is
    // only meaningful over independent per-page data.
    const measured = runs.filter((r) => r.field?.metrics[vital]?.source === "url");
    if (measured.length < 3) continue;

    // Count runs that still carry a finding for this vital, not runs whose raw
    // metric is below target. The two rules have to compose: FCP is folded into
    // LCP by component suppression, and counting raw metrics resurrected it as
    // a site-wide finding that per-page reporting had deliberately dropped.
    const failing = measured.filter((r) =>
      r.findings.some((f) => f.evidence.audit_id === `crux.${vital}`),
    );
    if (failing.length / measured.length < SYSTEMIC_THRESHOLD) continue;

    const values = failing.map((r) => r.field?.metrics[vital]?.p75 ?? 0);

    // Spread gate. Guard against a zero floor, which would make any spread
    // infinite and suppress the collapse for the wrong reason.
    const low = Math.min(...values);
    const high = Math.max(...values);
    if (low > 0 && high / low > SYSTEMIC_MAX_SPREAD) continue;

    const worst = failing
      .flatMap((r) => r.findings.filter((f) => f.evidence.audit_id === `crux.${vital}`))
      .reduce<Priority>(
        (acc, f) => (PRIORITY_RANK[f.priority] < PRIORITY_RANK[acc] ? f.priority : acc),
        "P3",
      );

    const med = median(values);
    const min = low;
    const max = high;

    collapsedVitals.push(vital);
    findings.push({
      priority: worst,
      title: `${vitalLabel(vital)} is below target site-wide (${failing.length}/${measured.length} runs)`,
      description:
        `Real users are below Google's ${vitalLabel(vital)} target on ` +
        `${failing.length} of ${measured.length} audited page/device runs, with a median of ` +
        `${formatVitalValue(vital, med)} and a range of ${formatVitalValue(vital, min)} to ` +
        `${formatVitalValue(vital, max)}. Because it fails almost everywhere and varies little ` +
        `between pages, this is a characteristic of the site's shared code rather than a defect ` +
        `on any one template — fixing individual pages will not move it. Investigate the common ` +
        `layer: the shared bundle, the third-party tags loaded on every page, or the base template.`,
      evidence: {
        audit_id: `crux.${vital}.systemic`,
        value: formatVitalValue(vital, med),
        failing_runs: failing.length,
        total_runs: measured.length,
        range: `${formatVitalValue(vital, min)}–${formatVitalValue(vital, max)}`,
      },
    });
  }

  return { findings, collapsedVitals };
}

export interface PsiAggregate {
  run_count: number;
  pages: number;
  captured_at: string;
  by_strategy: Record<string, { performance: { mean: number; min: number; max: number } }>;
  by_template: Array<{
    template: string;
    label: string;
    sampled: number;
    performance_mean: Record<string, number>;
    worst_url: string;
  }>;
  /**
   * Lab metrics failing across the audited runs. Renamed from
   * `universal_failures`, which was a lie on any site where a metric failed on
   * some pages but not others — it reported a 25% failure rate under a name the
   * report spec told the agent to treat as a headline finding. `universal` now
   * says explicitly whether the "fails on essentially every page" claim holds.
   */
  lab_metric_failures: Array<{
    metric: string;
    label: string;
    failing: number;
    of: number;
    pct: number;
    universal: boolean;
    range: string;
    threshold: string;
  }>;
  cwv_verdicts: { pass: number; needs_improvement: number; fail: number };
  lab_vs_field_summary: {
    worse_in_field: Array<{ metric: string; runs: number }>;
    worse_in_lab: Array<{ metric: string; runs: number }>;
    confirmed: Array<{ metric: string; runs: number }>;
    no_field_data: number;
  };
  outliers: Array<{
    url: string;
    strategy: string;
    metric: string;
    value: string;
    vs_median_multiple: number;
    confidence: string;
  }>;
}

/** Core Web Vitals verdict per run, field-first, matching the manual report's tiers. */
function cwvVerdict(run: RunResult): "pass" | "needs_improvement" | "fail" {
  const core: WebVital[] = ["lcp", "inp", "cls"];
  let failing = 0;
  for (const vital of core) {
    const fieldMetric = run.field?.metrics[vital];
    if (fieldMetric) {
      if (classifyVital(vital, fieldMetric.p75) !== "good") failing++;
      continue;
    }
    // INP has no lab fallback, so a run with no field INP is scored on what exists.
    const labValue = vital === "lcp" ? run.lab.lcpMs : vital === "cls" ? run.lab.cls : null;
    if (labValue !== null && classifyVital(vital, labValue) !== "good") failing++;
  }
  if (failing === 0) return "pass";
  return failing === 1 ? "needs_improvement" : "fail";
}

export function aggregate(runs: RunResult[]): PsiAggregate {
  const strategies = [...new Set(runs.map((r) => r.strategy))];

  const by_strategy: PsiAggregate["by_strategy"] = {};
  for (const strategy of strategies) {
    const scores = runs
      .filter((r) => r.strategy === strategy)
      .map((r) => r.scores.performance)
      .filter((n): n is number => typeof n === "number");
    if (scores.length === 0) continue;
    by_strategy[strategy] = {
      performance: { mean: mean(scores), min: Math.min(...scores), max: Math.max(...scores) },
    };
  }

  const templateIds = [...new Set(runs.map((r) => r.template))];
  const by_template = templateIds.map((template) => {
    const group = runs.filter((r) => r.template === template);
    const performance_mean: Record<string, number> = {};
    for (const strategy of strategies) {
      const scores = group
        .filter((r) => r.strategy === strategy)
        .map((r) => r.scores.performance)
        .filter((n): n is number => typeof n === "number");
      if (scores.length > 0) performance_mean[strategy] = mean(scores);
    }
    const worst = [...group].sort(
      (a, b) => (a.scores.performance ?? 100) - (b.scores.performance ?? 100),
    )[0];
    return {
      template,
      label: group[0].label,
      sampled: new Set(group.map((r) => r.url)).size,
      performance_mean,
      worst_url: worst?.url ?? "",
    };
  });

  // Lab metrics failing across the runs. At 100% this is the "22/22 fail TBT"
  // line — the strongest sentence in the manual report, and the one most likely
  // to be miscounted by hand. Below 80% it is not a headline; `universal` says
  // which case a reader is looking at.
  const lab_metric_failures: PsiAggregate["lab_metric_failures"] = [];
  for (const [key, spec] of Object.entries(LAB_THRESHOLDS)) {
    const values = runs
      .map((r) => r.lab[key as keyof LabMetrics])
      .filter((v): v is number => typeof v === "number");
    if (values.length === 0) continue;
    const failing = values.filter((v) => v > spec.good);
    if (failing.length === 0) continue;
    const pct = Math.round((failing.length / values.length) * 100);
    lab_metric_failures.push({
      metric: key,
      label: spec.label,
      failing: failing.length,
      of: values.length,
      pct,
      universal: pct >= 80,
      range: `${Math.round(Math.min(...failing))} ms–${Math.round(Math.max(...failing))} ms`,
      threshold: `${spec.good} ms`,
    });
  }

  const cwv_verdicts = { pass: 0, needs_improvement: 0, fail: 0 };
  for (const run of runs) cwv_verdicts[cwvVerdict(run)]++;

  const tally = (verdict: string): Array<{ metric: string; runs: number }> => {
    const counts = new Map<string, number>();
    for (const run of runs) {
      for (const c of run.comparisons) {
        if (c.verdict !== verdict) continue;
        counts.set(c.metric, (counts.get(c.metric) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .map(([metric, n]) => ({ metric, runs: n }))
      .sort((a, b) => b.runs - a.runs);
  };

  // Outliers: a value far above the median for its own strategy. With
  // runs_per_url = 1 there is nothing to check it against, so it is reported
  // as unconfirmed rather than asserted — the manual report had to make this
  // caveat in prose for its 9.97 s TBT reading.
  const outliers: PsiAggregate["outliers"] = [];
  for (const strategy of strategies) {
    const group = runs.filter((r) => r.strategy === strategy);
    for (const key of Object.keys(LAB_THRESHOLDS) as Array<keyof LabMetrics>) {
      const values = group
        .map((r) => r.lab[key])
        .filter((v): v is number => typeof v === "number");
      if (values.length < 4) continue;
      const med = median(values);
      if (med <= 0) continue;
      for (const run of group) {
        const value = run.lab[key];
        if (typeof value !== "number" || value / med < 3) continue;
        outliers.push({
          url: run.url,
          strategy,
          metric: String(key),
          value: `${Math.round(value)} ms`,
          vs_median_multiple: Number((value / med).toFixed(1)),
          confidence: run.runs > 1 ? `median_of_${run.runs}` : "unconfirmed_single_run",
        });
      }
    }
  }

  return {
    run_count: runs.length,
    pages: new Set(runs.map((r) => r.url)).size,
    captured_at: new Date().toISOString(),
    by_strategy,
    by_template,
    lab_metric_failures,
    cwv_verdicts,
    lab_vs_field_summary: {
      worse_in_field: tally("worse_in_field"),
      worse_in_lab: tally("worse_in_lab"),
      confirmed: tally("confirmed"),
      no_field_data: runs.filter((r) => !r.field).length,
    },
    outliers,
  };
}
