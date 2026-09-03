/**
 * Before-and-after comparison of two runs.
 *
 * A snapshot answers "what is wrong with this page". A developer about to open
 * a PR has a different question: "did my fix work, and did I break anything?"
 * Those are not the same question, and a count cannot distinguish them.
 *
 * Measured case, from a page where an `alt` attribute and an `aria-label` were
 * added to fix a missing-alt-text blocker:
 *
 *   before: 2 violations — image-alt (P1), color-contrast (P3)
 *   after:  2 violations — aria-valid-attr-value (P2), color-contrast (P3)
 *
 * Identical totals. The P1 was genuinely fixed, and the fix introduced a new
 * defect, because the aria-labelledby it added pointed at an id that did not
 * exist. Anyone reading "2 before, 2 after" concludes the change did nothing.
 * `newly_introduced` is the half of this module that earns its keep.
 */

import type { Priority } from "../types.js";

/** One defect, identified the same way in both runs. */
export interface DefectRef {
  url: string;
  variant: string;
  /** Rule code for accessibility, audit id for Lighthouse. */
  id: string;
  priority: Priority;
  title?: string;
}

export type ComparisonVerdict =
  | "clean"        // nothing failing now
  | "improved"     // fixed things, broke nothing
  | "mixed"        // fixed things AND broke things
  | "regression"   // broke things, fixed nothing
  | "unchanged";

export interface ScoreChange {
  url: string;
  variant: string;
  category: string;
  before: number;
  after: number;
  delta: number;
}

export interface ComparisonResult {
  baseline_dir: string;
  baseline_runs: number;
  current_runs: number;
  verdict: ComparisonVerdict;
  summary: string;
  fixed: Array<{ url: string; variant: string; id: string; was: Priority; title?: string }>;
  still_failing: Array<{ url: string; variant: string; id: string; priority: Priority; title?: string }>;
  newly_introduced: Array<{ url: string; variant: string; id: string; priority: Priority; title?: string }>;
  score_changes?: ScoreChange[];
  /** Runs present now but absent from the baseline — not comparable. */
  not_in_baseline: string[];
  /** Runs in the baseline that this run did not cover — silently uncompared otherwise. */
  not_in_current: string[];
  warnings: string[];
}

const key = (d: { url: string; variant: string; id: string }): string =>
  `${d.url}|${d.variant}|${d.id}`;
const runKey = (d: { url: string; variant: string }): string => `${d.url}|${d.variant}`;

const RANK: Record<Priority, number> = { P1: 0, P2: 1, P3: 2 };

function worst(items: Array<{ priority: Priority }>): Priority | null {
  if (items.length === 0) return null;
  return items.reduce<Priority>((acc, i) => (RANK[i.priority] < RANK[acc] ? i.priority : acc), "P3");
}

function describe(
  verdict: ComparisonVerdict,
  fixed: number,
  broke: number,
  remaining: number,
  worstNew: Priority | null,
): string {
  // The "totals hid it" warning only belongs where the totals actually hid it.
  // Claiming a count looked unchanged when it went 6 to 2 is the same kind of
  // imprecision this module exists to remove.
  const before = fixed + remaining;
  const after = remaining + broke;
  const totalsMask = before === after;
  switch (verdict) {
    case "clean":
      return fixed > 0
        ? `All clear — ${fixed} defect(s) fixed and nothing failing now.`
        : "All clear — nothing failing in either run.";
    case "improved":
      return `${fixed} defect(s) fixed, none introduced. ${remaining} still failing.`;
    case "mixed":
      return (
        `${fixed} defect(s) fixed, but ${broke} newly introduced` +
        `${worstNew ? ` (worst: ${worstNew})` : ""}. ` +
        (totalsMask
          ? `The total is unchanged at ${after}, so the count alone would suggest nothing happened — ` +
            `check newly_introduced before treating this as a clean fix.`
          : `Total went ${before} to ${after}; the drop is real but incomplete — ` +
            `check newly_introduced before treating this as a clean fix.`)
      );
    case "regression":
      return (
        `${broke} defect(s) newly introduced` +
        `${worstNew ? ` (worst: ${worstNew})` : ""} and none fixed. This change made things worse.`
      );
    case "unchanged":
      return `No change — ${remaining} defect(s) failing in both runs.`;
  }
}

/**
 * Compare two defect sets.
 *
 * Comparison is per (url, variant, defect id). A defect that moved priority
 * between runs counts as still failing rather than as fixed-and-reintroduced,
 * since it is the same defect on the same element — the priority shift shows up
 * in `still_failing`.
 */
export function compareRuns(
  baselineDir: string,
  baseline: DefectRef[],
  current: DefectRef[],
  options: {
    baselineRuns?: number;
    currentRuns?: number;
    baselineScores?: Map<string, Record<string, number>>;
    currentScores?: Map<string, Record<string, number>>;
  } = {},
): ComparisonResult {
  const warnings: string[] = [];

  const baseByKey = new Map(baseline.map((d) => [key(d), d]));
  const curByKey = new Map(current.map((d) => [key(d), d]));

  // Only compare runs both sides actually covered; anything else would report
  // a "fix" that is really an absence of measurement.
  const baseRuns = new Set(baseline.map(runKey));
  const curRuns = new Set(current.map(runKey));
  const comparableRuns = new Set([...curRuns].filter((r) => baseRuns.has(r)));

  const notInBaseline = [...curRuns].filter((r) => !baseRuns.has(r));
  const notInCurrent = [...baseRuns].filter((r) => !curRuns.has(r));

  const fixed: ComparisonResult["fixed"] = [];
  const stillFailing: ComparisonResult["still_failing"] = [];
  const newlyIntroduced: ComparisonResult["newly_introduced"] = [];

  for (const [k, d] of baseByKey) {
    if (!comparableRuns.has(runKey(d))) continue;
    if (curByKey.has(k)) {
      const now = curByKey.get(k) as DefectRef;
      stillFailing.push({ url: d.url, variant: d.variant, id: d.id, priority: now.priority, title: now.title });
    } else {
      fixed.push({ url: d.url, variant: d.variant, id: d.id, was: d.priority, title: d.title });
    }
  }
  for (const [k, d] of curByKey) {
    if (!comparableRuns.has(runKey(d))) continue;
    if (!baseByKey.has(k)) {
      newlyIntroduced.push({ url: d.url, variant: d.variant, id: d.id, priority: d.priority, title: d.title });
    }
  }

  const sortByPriority = <T extends { priority?: Priority; was?: Priority }>(items: T[]): T[] =>
    items.sort((a, b) => RANK[(a.priority ?? a.was) as Priority] - RANK[(b.priority ?? b.was) as Priority]);
  sortByPriority(fixed);
  sortByPriority(stillFailing);
  sortByPriority(newlyIntroduced);

  let verdict: ComparisonVerdict;
  if (newlyIntroduced.length > 0 && fixed.length > 0) verdict = "mixed";
  else if (newlyIntroduced.length > 0) verdict = "regression";
  else if (fixed.length > 0) verdict = stillFailing.length === 0 ? "clean" : "improved";
  else verdict = stillFailing.length === 0 ? "clean" : "unchanged";

  if (notInBaseline.length > 0) {
    warnings.push(
      `${notInBaseline.length} run(s) have no baseline to compare against and were excluded. ` +
        "Their findings are in the report but not in this comparison.",
    );
  }
  if (notInCurrent.length > 0) {
    warnings.push(
      `${notInCurrent.length} run(s) in the baseline were not re-tested. A defect can only be ` +
        "counted as fixed if the page was measured again.",
    );
  }
  if (comparableRuns.size === 0) {
    warnings.push(
      "No run appears in both the baseline and this run, so nothing could be compared. " +
        "Check that baseline_dir points at an index for the same URLs.",
    );
  }

  // Score deltas, where the tool supplies them. Only for comparable runs, and
  // only where both sides scored the category.
  let scoreChanges: ScoreChange[] | undefined;
  if (options.baselineScores && options.currentScores) {
    scoreChanges = [];
    for (const runId of comparableRuns) {
      const before = options.baselineScores.get(runId);
      const after = options.currentScores.get(runId);
      if (!before || !after) continue;
      const [url, variant] = runId.split("|");
      for (const [category, afterScore] of Object.entries(after)) {
        const beforeScore = before[category];
        if (typeof beforeScore !== "number" || beforeScore === afterScore) continue;
        scoreChanges.push({
          url,
          variant,
          category,
          before: beforeScore,
          after: afterScore,
          delta: afterScore - beforeScore,
        });
      }
    }
    scoreChanges.sort((a, b) => a.delta - b.delta);
    if (scoreChanges.length === 0) scoreChanges = undefined;
  }

  return {
    baseline_dir: baselineDir,
    baseline_runs: baseRuns.size,
    current_runs: curRuns.size,
    verdict,
    summary: describe(
      verdict,
      fixed.length,
      newlyIntroduced.length,
      stillFailing.length,
      worst(newlyIntroduced),
    ),
    fixed,
    still_failing: stillFailing,
    newly_introduced: newlyIntroduced,
    ...(scoreChanges ? { score_changes: scoreChanges } : {}),
    not_in_baseline: notInBaseline,
    not_in_current: notInCurrent,
    warnings,
  };
}
