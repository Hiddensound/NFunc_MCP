import type { Finding, Priority } from "../types.js";
import {
  isRequiredFor,
  type TargetLevel,
  type WcagConformanceLevel,
} from "./wcagLevels.js";

export type { Priority };

const PRIORITY_ORDER: Record<Priority, number> = { P1: 0, P2: 1, P3: 2 };

export function lighthouseScoreToPriority(score: number): Priority | null {
  if (score < 50) return "P1";
  if (score < 80) return "P2";
  if (score < 90) return "P3";
  return null;
}

/**
 * Priority from an audit's actual impact on its Lighthouse category score.
 *
 * Scoring on `score` alone made every failing binary audit a P1: binary audits
 * score exactly 0 when they fail, so a missing llms.txt ranked level with a
 * 30-second Time to Interactive. On a real commerce page that produced 24
 * Lighthouse P1s, 18 of them binary — and 19 of the 35 failing audits carried
 * weight 0, meaning Lighthouse itself counts them toward no category score at
 * all.
 *
 * `weight * (1 - score)` is the number of category points the audit actually
 * costs — the same quantity Lighthouse uses to compute the category score. It
 * ranks a weight-30 metric failing outright (30) above a weight-25 metric
 * scoring 78 (5.5) above a weight-1 SEO check (1), which is the ordering a
 * human triager would pick.
 *
 * Weight-0 diagnostics stay reportable but never block: they are supporting
 * detail for the weighted metrics, and counting them again is double-counting
 * (unused-javascript, bootup-time and mainthread-work-breakdown all describe
 * the same overloaded main thread that total-blocking-time already charges for).
 *
 * `weight` undefined means the audit belongs to no category, which is not the
 * same as weight 0 — fall back to the score-only mapping there.
 */
export function lighthouseImpactToPriority(
  score: number,
  weight: number | undefined,
): Priority | null {
  if (score >= 90) return null;
  if (weight === undefined) return lighthouseScoreToPriority(score);

  const impact = weight * (1 - score / 100);
  if (impact >= 10) return "P1";
  if (impact >= 3) return "P2";
  return "P3";
}

// Pass "notice" (or "warning" / "unknown") to suppress the finding.
export function wcagLevelToPriority(level: string): Priority | null {
  if (level === "A") return "P1";
  if (level === "AA") return "P2";
  if (level === "AAA") return "P3";
  return null;
}

/**
 * Priority for a pa11y violation, keyed on the WCAG technique rather than the
 * conformance level.
 *
 * Level is not impact. Almost everything a WCAG2AA scan detects is Level A, so
 * mapping A→P1 made all 17 pa11y findings on a real page P1 and left the tier
 * doing no discrimination. Technique says what actually breaks: an unlabelled
 * input stops a screen-reader user completing a form, while a duplicate id
 * degrades an experience that still works.
 *
 * Keys are matched by the progressive-narrowing rule used for descriptions —
 * "H91.InputText.Name" falls back to "H91" — and anything unlisted falls back
 * to the conformance-level mapping.
 */
const TECHNIQUE_PRIORITY: Record<string, Priority> = {
  // P1 — blocks a user from completing a task.
  H91: "P1", // no accessible name on an interactive element
  F68: "P1", // form control with no label
  H44: "P1", // label not associated with its control
  ARIA6: "P1", // empty/invalid aria-label
  ARIA9: "P1", // aria-labelledby pointing at missing ids
  H32: "P1", // form with no submit mechanism
  H37: "P1", // img with no alt
  F65: "P1", // img with neither alt nor title
  H30: "P1", // link whose only content is an unlabelled image
  H36: "P1", // image submit button with no alt
  H53: "P1", // object with no fallback content
  G202: "P1", // keyboard focus trapped or invisible
  F54: "P1", // mouse-only interaction
  F55: "P1", // focus stolen on hover
  G18: "P1", // body text below 4.5:1 contrast
  G145: "P1", // large text below 3:1 contrast

  // P2 — degrades the experience without blocking it.
  F77: "P2", // duplicate id
  H93: "P2", // duplicate id (label/for variant)
  G141: "P2", // heading levels skipped
  H42: "P2", // text styled as a heading but not marked up
  H25: "P2", // missing page title
  F89: "P2", // empty page title
  H57: "P2", // missing lang on <html>
  H58: "P2", // unmarked language change
  H64: "P2", // iframe with no title
  H67: "P2", // decorative img carrying meaning
  G94: "P2", // inaccurate alt text
  "G1,G123,G124": "P2", // link to a named anchor that does not exist
  H85: "P2", // ungrouped select options
  G174: "P2", // no higher-contrast alternative
  F40: "P2", // meta refresh with delay
  F41: "P2", // auto-refresh with no user control

  // P3 — advisory.
  F92: "P3", // role="presentation" hiding real semantics
  ARIA4: "P3", // role inappropriate for the content
  H49: "P3", // emphasis conveyed only visually
  F2: "P3", // meaning conveyed by formatting alone
  G14: "P3", // meaning conveyed by colour alone
};

/**
 * Priority for an axe finding, from axe's own impact rating.
 *
 * Same principle as using Lighthouse's audit weight: the tool has already
 * graded severity, so grade with it rather than inventing a parallel scheme.
 * axe's ladder is critical > serious > moderate > minor.
 *
 * `needsFurtherReview` marks a rule that could not decide on its own and wants
 * a human to confirm. Those are demoted one tier — a maybe should not gate a
 * release with the same force as a definite.
 */
export function axeImpactToPriority(
  impact: string | undefined,
  needsReview: boolean | undefined,
): Priority | null {
  const base: Priority =
    impact === "critical" ? "P1"
    : impact === "serious" ? "P2"
    : impact === "moderate" ? "P3"
    : impact === "minor" ? "P3"
    : "P3"; // unrated: report, never block

  if (!needsReview) return base;
  return base === "P1" ? "P2" : "P3";
}

export function a11yTechniqueToPriority(
  technique: string,
  wcagLevel: string,
): Priority | null {
  let key = technique;
  while (key) {
    const p = TECHNIQUE_PRIORITY[key];
    if (p) return p;
    const lastDot = key.lastIndexOf(".");
    if (lastDot < 0) break;
    key = key.slice(0, lastDot);
  }
  return wcagLevelToPriority(wcagLevel);
}

export function staticAnalysisToPriority(
  source: "eslint" | "semgrep",
  severity: number | string,
  category?: string,
): Priority | null {
  // Security findings always win regardless of severity level.
  if (source === "semgrep" && category === "security") return "P1";
  if (source === "eslint" && severity === 2) return "P2";
  if (source === "semgrep" && (severity === "warning" || severity === "error")) return "P2";
  if (source === "eslint" && severity === 1) return "P3";
  // "info" or anything unrecognised → suppress
  return null;
}

/**
 * Severity-only fallback for a Trivy vulnerability.
 *
 * Used when the PkgID join onto Packages[] missed, so `relationship` and `dev`
 * are unknown. Same role as `lighthouseScoreToPriority` inside
 * `lighthouseImpactToPriority`: the richer signal is unavailable, so fall back
 * to the coarse one rather than inventing a value for the missing field.
 *
 * CRITICAL still reaches P1 here. Guessing "indirect" to be safe would quietly
 * demote a genuine emergency, and a silent demotion is worse than a coarse
 * ranking — the finding is marked `relationship_unknown` so the caller can see
 * which rung it was priced on.
 */
export function trivySeverityToPriority(severity: string): Priority {
  if (severity === "CRITICAL") return "P1";
  if (severity === "HIGH") return "P2";
  return "P3";
}

export interface TrivyVulnSignals {
  severity: string;
  /** Trivy states no upstream fix exists, or none was offered. */
  unfixable: boolean;
  relationship: string;
  dev: boolean;
  /** Whether relationship/dev came from a successful package join. */
  joined: boolean;
}

/**
 * Priority for a dependency vulnerability, from remediability rather than
 * severity.
 *
 * Severity alone is the same failure `lighthouseImpactToPriority` was written
 * to fix: on a real Node tree most CRITICALs are transitive, unfixable, or
 * confined to devDependencies, so ranking on `Severity` puts an unfixable CVE
 * in a build-time package above a one-line bump of a direct runtime
 * dependency. What a triager wants first is the fix they can land today.
 *
 *   CRITICAL/HIGH + fix + direct    → P1   severe, yours, one version bump
 *   CRITICAL/HIGH + fix + indirect  → P2   same severity, an override to land
 *   MEDIUM        + fix + direct    → P2   worth the sprint, not the hotfix
 *   MEDIUM        + fix + indirect  → P3
 *   LOW / UNKNOWN                   → P3   reportable, never blocking
 *   devDependency                   → demoted one tier; it does not ship
 *
 * Unfixable vulnerabilities never reach this function. They are a decision
 * queue rather than a work queue — blocking a release on something nobody can
 * fix is a gate that can never pass — so the tool routes them to `unfixable`
 * instead of assigning them a tier here.
 */
export function trivyVulnToPriority(signals: TrivyVulnSignals): Priority {
  const { severity, relationship, dev, joined } = signals;

  let priority: Priority;
  if (!joined) {
    priority = trivySeverityToPriority(severity);
  } else {
    // root and workspace are the scanned project itself: as directly yours as
    // a direct dependency, and fixable on the same terms.
    const isDirect =
      relationship === "direct" ||
      relationship === "root" ||
      relationship === "workspace";

    if (severity === "CRITICAL" || severity === "HIGH") {
      priority = isDirect ? "P1" : "P2";
    } else if (severity === "MEDIUM") {
      priority = isDirect ? "P2" : "P3";
    } else {
      priority = "P3";
    }
  }

  return dev ? DEMOTE[priority] : priority;
}

/**
 * Priority for an infrastructure misconfiguration.
 *
 * Capped at P2 on purpose. A misconfiguration is a statement about declared
 * configuration, not an observed failure, and the evidence that it actually
 * bites is the browser-side symptom — a missing header showing up as a
 * Lighthouse `csp-xss` failure. Promotion to P1 belongs with that correlation,
 * not here, so this tier stays honest when the scanner runs alone.
 */
export function trivyMisconfigToPriority(severity: string): Priority {
  if (severity === "CRITICAL" || severity === "HIGH") return "P2";
  return "P3";
}

export function sortFindingsByPriority<T extends Finding>(findings: T[]): T[] {
  return findings.sort(
    (a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority],
  );
}


const DEMOTE: Record<Priority, Priority> = { P1: "P2", P2: "P3", P3: "P3" };

export interface ConformancePriority {
  priority: Priority | null;
  /** True when this failure prevents conformance at the committed target. */
  blocksTarget: boolean;
}

/**
 * Priority from WCAG conformance rather than from a technique table.
 *
 * The levels are cumulative: claiming AA requires meeting every Level A
 * criterion as well, so a Level A failure is not merely "one more issue" — it
 * puts the committed target out of reach entirely until it is fixed. A page
 * with three Level A failures cannot be AA conformant no matter how clean its
 * AA-specific criteria are, and the priority scheme should say so.
 *
 *   Level A failure   → P1   blocks the floor; conformance impossible
 *   Level AA failure  → P2   blocks an AA commitment
 *   Above the target  → P3   an enhancement, not a gap (see below)
 *   No criterion      → P3   best-practice rule; never blocks a release
 *
 * This replaces the Phase 13 technique table, which ranked findings by how bad
 * the defect felt rather than by what it does to a conformance claim. That
 * table existed because mapping level → priority naively made almost everything
 * P1; the answer here is not to flatten the levels but to report the count of
 * *distinct failing criteria* alongside, so "7 findings" reads as "5 Level A
 * criteria failing" instead of an undifferentiated wall of P1s.
 *
 * Criteria above the target are deliberately not failures. Orium's checklist
 * makes the same point: AAA findings against an AA commitment are enhancement
 * opportunities, and counting them as gaps overstates the compliance position.
 * `target_size` is the one that bites in practice — it is 2.5.5, Level AAA in
 * WCAG 2.1, so it should not fail an AA audit.
 *
 * Two demotions apply afterwards. axe's `needsFurtherReview` marks a rule that
 * could not decide on its own, and a maybe should not gate a release as hard as
 * a certainty. An axe impact of `minor` marks a real but negligible defect —
 * the "very minor AA issue" tier.
 */
export function wcagConformanceToPriority(
  level: WcagConformanceLevel | "unknown",
  target: TargetLevel,
  options: { axeImpact?: string; needsReview?: boolean } = {},
): ConformancePriority {
  if (level === "unknown") {
    return { priority: "P3", blocksTarget: false };
  }

  const blocksTarget = isRequiredFor(level, target);
  let priority: Priority;

  if (!blocksTarget) {
    priority = "P3"; // beyond the committed level
  } else if (level === "A") {
    priority = "P1";
  } else if (level === "AA") {
    priority = "P2";
  } else {
    priority = "P2"; // AAA, only when AAA is the committed target
  }

  if (options.needsReview) priority = DEMOTE[priority];
  if (options.axeImpact === "minor") priority = DEMOTE[priority];

  return { priority, blocksTarget };
}
