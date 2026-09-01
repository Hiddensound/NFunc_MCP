import type { Finding, Priority } from "../types.js";

/**
 * Composite health score.
 *
 * The previous formula was a single global subtraction — 100 minus 15 per P1,
 * 7 per P2, 3 per P3 — which had two structural faults:
 *
 *  1. No resolution. Seven P1 findings floored it at 0, so a mediocre page and
 *     a catastrophic one were indistinguishable. Real pages routinely exceed
 *     that within a single tool.
 *  2. Running more tools lowered the score, because every tool fed the same
 *     running subtraction. A url-only run was not comparable to a url+path run,
 *     which is exactly backwards: broader checking should not look like worse
 *     health.
 *
 * Both are fixed by scoring each tool to its own 0–100 sub-score and taking a
 * weighted mean over only the tools that actually ran.
 */

const SEVERITY_DAMAGE: Record<Priority, number> = { P1: 10, P2: 3, P3: 1 };

/**
 * Saturating decay. Never reaches 0, always preserves ordering, and each
 * additional finding costs less than the one before — which matches how the
 * information actually behaves: the twentieth P1 tells you far less about the
 * page than the first did.
 *
 * K sets where the curve has resolution. At K = 90 a single P1 scores 89, five
 * P1s score 57, and fifteen P1s score 19 — spread across the range real pages
 * occupy instead of collapsing onto the floor.
 */
function decay(damage: number, k: number): number {
  return Math.round(100 * Math.exp(-damage / k));
}

function damageOf(findings: Finding[]): number {
  return findings.reduce((sum, f) => sum + SEVERITY_DAMAGE[f.priority], 0);
}

// Tuned so a page's sub-score lands where a human triager would put it. Static
// analysis decays faster because code defects are fewer and more directly
// actionable than page-level accessibility violations.
const A11Y_K = 90;
const STATIC_K = 60;

/**
 * Relative weights of the Lighthouse categories inside the Lighthouse
 * sub-score. Lighthouse publishes per-audit weights but no cross-category
 * weighting, so this is our judgement: performance and accessibility carry the
 * most user impact, SEO and best-practices matter but less directly.
 *
 * Categories not listed here — currently the experimental "agentic-browsing" —
 * get UNKNOWN_CATEGORY_WEIGHT so a new or volatile category cannot dominate the
 * score, while still being visible in the breakdown.
 */
const CATEGORY_WEIGHTS: Record<string, number> = {
  performance: 0.3,
  accessibility: 0.3,
  "best-practices": 0.2,
  seo: 0.2,
};
const UNKNOWN_CATEGORY_WEIGHT = 0.05;

/**
 * Lighthouse's own category scores ARE a calibrated 0–100 health signal, with
 * per-audit weighting Google already tuned. Re-deriving one by counting
 * findings throws that away and double-counts besides: total-blocking-time,
 * bootup-time, mainthread-work-breakdown, interactive and max-potential-fid are
 * five findings describing one overloaded main thread, and the old formula
 * charged 75 points for it. So use the category scores directly.
 */
export function lighthouseSubScore(
  categoryScores: Record<string, number>,
): number | null {
  const entries = Object.entries(categoryScores);
  if (entries.length === 0) return null;

  let weighted = 0;
  let totalWeight = 0;
  for (const [name, score] of entries) {
    const w = CATEGORY_WEIGHTS[name] ?? UNKNOWN_CATEGORY_WEIGHT;
    weighted += w * score;
    totalWeight += w;
  }
  return totalWeight > 0 ? Math.round(weighted / totalWeight) : null;
}

export function a11ySubScore(findings: Finding[]): number {
  return decay(damageOf(findings), A11Y_K);
}

export function staticSubScore(findings: Finding[]): number {
  return decay(damageOf(findings), STATIC_K);
}

export interface SubScores {
  lighthouse: number | null;
  pa11y: number | null;
  static: number | null;
}

// How much each tool contributes to the composite. Static analysis is weighted
// lowest because a clean scan of a small directory returns 100 and would
// otherwise flatter a run whose real problems are all in the browser.
const TOOL_WEIGHTS = { lighthouse: 0.4, pa11y: 0.4, static: 0.2 };

/**
 * Weighted mean over the tools that produced a score. Weights are renormalised
 * across whatever ran, so a url-only run and a url+path run are on the same
 * scale. Returns null when nothing scored.
 */
export function compositeScore(sub: SubScores): number | null {
  const parts: Array<[number, number]> = [];
  if (sub.lighthouse !== null) parts.push([sub.lighthouse, TOOL_WEIGHTS.lighthouse]);
  if (sub.pa11y !== null) parts.push([sub.pa11y, TOOL_WEIGHTS.pa11y]);
  if (sub.static !== null) parts.push([sub.static, TOOL_WEIGHTS.static]);
  if (parts.length === 0) return null;

  const totalWeight = parts.reduce((s, [, w]) => s + w, 0);
  const weighted = parts.reduce((s, [v, w]) => s + v * w, 0);
  return Math.round(weighted / totalWeight);
}
