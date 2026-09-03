/**
 * WCAG 2.1 success criteria, their conformance levels, and how to get from a
 * pa11y finding back to one.
 *
 * Levels are transcribed from the specification (https://www.w3.org/TR/WCAG21/)
 * rather than inferred, because the whole priority scheme now rests on them: a
 * criterion placed at the wrong level moves a finding between "blocks
 * conformance" and "enhancement beyond the committed target", which is the
 * difference between a release blocker and a backlog item.
 *
 * Levels are cumulative. AA conformance requires every Level A criterion *and*
 * every Level AA one, so a single Level A failure makes AA conformance
 * impossible no matter how clean the AA-specific criteria are. That is why a
 * Level A failure outranks everything else here.
 */

export type WcagConformanceLevel = "A" | "AA" | "AAA";
export type TargetLevel = WcagConformanceLevel;

export interface Criterion {
  number: string;
  name: string;
  level: WcagConformanceLevel;
}

/** All 78 WCAG 2.1 success criteria. */
const CRITERIA: Criterion[] = [
  { number: "1.1.1", name: "Non-text Content", level: "A" },
  { number: "1.2.1", name: "Audio-only and Video-only (Prerecorded)", level: "A" },
  { number: "1.2.2", name: "Captions (Prerecorded)", level: "A" },
  { number: "1.2.3", name: "Audio Description or Media Alternative (Prerecorded)", level: "A" },
  { number: "1.2.4", name: "Captions (Live)", level: "AA" },
  { number: "1.2.5", name: "Audio Description (Prerecorded)", level: "AA" },
  { number: "1.2.6", name: "Sign Language (Prerecorded)", level: "AAA" },
  { number: "1.2.7", name: "Extended Audio Description (Prerecorded)", level: "AAA" },
  { number: "1.2.8", name: "Media Alternative (Prerecorded)", level: "AAA" },
  { number: "1.2.9", name: "Audio-only (Live)", level: "AAA" },
  { number: "1.3.1", name: "Info and Relationships", level: "A" },
  { number: "1.3.2", name: "Meaningful Sequence", level: "A" },
  { number: "1.3.3", name: "Sensory Characteristics", level: "A" },
  { number: "1.3.4", name: "Orientation", level: "AA" },
  { number: "1.3.5", name: "Identify Input Purpose", level: "AA" },
  { number: "1.3.6", name: "Identify Purpose", level: "AAA" },
  { number: "1.4.1", name: "Use of Color", level: "A" },
  { number: "1.4.2", name: "Audio Control", level: "A" },
  { number: "1.4.3", name: "Contrast (Minimum)", level: "AA" },
  { number: "1.4.4", name: "Resize Text", level: "AA" },
  { number: "1.4.5", name: "Images of Text", level: "AA" },
  { number: "1.4.6", name: "Contrast (Enhanced)", level: "AAA" },
  { number: "1.4.7", name: "Low or No Background Audio", level: "AAA" },
  { number: "1.4.8", name: "Visual Presentation", level: "AAA" },
  { number: "1.4.9", name: "Images of Text (No Exception)", level: "AAA" },
  { number: "1.4.10", name: "Reflow", level: "AA" },
  { number: "1.4.11", name: "Non-text Contrast", level: "AA" },
  { number: "1.4.12", name: "Text Spacing", level: "AA" },
  { number: "1.4.13", name: "Content on Hover or Focus", level: "AA" },
  { number: "2.1.1", name: "Keyboard", level: "A" },
  { number: "2.1.2", name: "No Keyboard Trap", level: "A" },
  { number: "2.1.3", name: "Keyboard (No Exception)", level: "AAA" },
  { number: "2.1.4", name: "Character Key Shortcuts", level: "A" },
  { number: "2.2.1", name: "Timing Adjustable", level: "A" },
  { number: "2.2.2", name: "Pause, Stop, Hide", level: "A" },
  { number: "2.2.3", name: "No Timing", level: "AAA" },
  { number: "2.2.4", name: "Interruptions", level: "AAA" },
  { number: "2.2.5", name: "Re-authenticating", level: "AAA" },
  { number: "2.2.6", name: "Timeouts", level: "AAA" },
  { number: "2.3.1", name: "Three Flashes or Below Threshold", level: "A" },
  { number: "2.3.2", name: "Three Flashes", level: "AAA" },
  { number: "2.3.3", name: "Animation from Interactions", level: "AAA" },
  { number: "2.4.1", name: "Bypass Blocks", level: "A" },
  { number: "2.4.2", name: "Page Titled", level: "A" },
  { number: "2.4.3", name: "Focus Order", level: "A" },
  { number: "2.4.4", name: "Link Purpose (In Context)", level: "A" },
  { number: "2.4.5", name: "Multiple Ways", level: "AA" },
  { number: "2.4.6", name: "Headings and Labels", level: "AA" },
  { number: "2.4.7", name: "Focus Visible", level: "AA" },
  { number: "2.4.8", name: "Location", level: "AAA" },
  { number: "2.4.9", name: "Link Purpose (Link Only)", level: "AAA" },
  { number: "2.4.10", name: "Section Headings", level: "AAA" },
  { number: "2.5.1", name: "Pointer Gestures", level: "A" },
  { number: "2.5.2", name: "Pointer Cancellation", level: "A" },
  { number: "2.5.3", name: "Label in Name", level: "A" },
  { number: "2.5.4", name: "Motion Actuation", level: "A" },
  { number: "2.5.5", name: "Target Size", level: "AAA" },
  { number: "2.5.6", name: "Concurrent Input Mechanisms", level: "AAA" },
  { number: "3.1.1", name: "Language of Page", level: "A" },
  { number: "3.1.2", name: "Language of Parts", level: "AA" },
  { number: "3.1.3", name: "Unusual Words", level: "AAA" },
  { number: "3.1.4", name: "Abbreviations", level: "AAA" },
  { number: "3.2.1", name: "On Focus", level: "A" },
  { number: "3.2.2", name: "On Input", level: "A" },
  { number: "3.2.3", name: "Consistent Navigation", level: "AA" },
  { number: "3.2.4", name: "Consistent Identification", level: "AA" },
  { number: "3.2.5", name: "Change on Request", level: "AAA" },
  { number: "3.3.1", name: "Error Identification", level: "A" },
  { number: "3.3.2", name: "Labels or Instructions", level: "A" },
  { number: "3.3.3", name: "Error Suggestion", level: "AA" },
  { number: "3.3.4", name: "Error Prevention (Legal, Financial, Data)", level: "AA" },
  { number: "3.3.5", name: "Help", level: "AAA" },
  { number: "3.3.6", name: "Error Prevention (All)", level: "AAA" },
  { number: "4.1.1", name: "Parsing", level: "A" },
  { number: "4.1.2", name: "Name, Role, Value", level: "A" },
  { number: "4.1.3", name: "Status Messages", level: "AA" },
];

const BY_NUMBER = new Map(CRITERIA.map((c) => [c.number, c]));

export function criterionByNumber(number: string): Criterion | null {
  return BY_NUMBER.get(number) ?? null;
}

/**
 * axe rule id → the success criterion it tests.
 *
 * pa11y's axe output carries `impact` and `needsFurtherReview` but **not** the
 * WCAG tags axe itself attaches, so the mapping has to live here. Rules axe
 * classifies as best-practice rather than as a WCAG criterion are mapped to
 * null deliberately: reporting a best-practice rule as a conformance failure
 * would overstate the legal position, which is the one thing a compliance
 * report must not do.
 *
 * axe rule ids are identical to Lighthouse's accessibility audit ids, because
 * Lighthouse runs axe internally — so this table serves both engines.
 */
const AXE_RULE_TO_CRITERION: Record<string, string | null> = {
  // 1.1.1 Non-text Content
  "image-alt": "1.1.1",
  "input-image-alt": "1.1.1",
  "area-alt": "1.1.1",
  "object-alt": "1.1.1",
  "svg-img-alt": "1.1.1",
  "role-img-alt": "1.1.1",
  "image-redundant-alt": null, // best practice

  // 1.2.x media
  "video-caption": "1.2.2",
  "audio-caption": "1.2.1",

  // 1.3.1 Info and Relationships
  "aria-required-children": "1.3.1",
  "aria-required-parent": "1.3.1",
  list: "1.3.1",
  listitem: "1.3.1",
  "definition-list": "1.3.1",
  dlitem: "1.3.1",
  "td-headers-attr": "1.3.1",
  "th-has-data-cells": "1.3.1",
  "table-fake-caption": "1.3.1",
  "td-has-header": "1.3.1",

  // 1.3.4 / 1.3.5
  "css-orientation-lock": "1.3.4",
  "autocomplete-valid": "1.3.5",

  // 1.4.x contrast and text
  "link-in-text-block": "1.4.1",
  "color-contrast": "1.4.3",
  "color-contrast-enhanced": "1.4.6",
  "meta-viewport": "1.4.4",
  "meta-viewport-large": null, // best practice
  "avoid-inline-spacing": "1.4.12",

  // 2.1.x keyboard
  accesskeys: null, // best practice
  "scrollable-region-focusable": "2.1.1",
  "frame-focusable-content": "2.1.1",
  "server-side-image-map": "2.1.1",

  // 2.2.x timing
  "meta-refresh": "2.2.1",
  "meta-refresh-no-exceptions": "2.2.4",
  marquee: "2.2.2",
  blink: "2.2.2",

  // 2.4.x navigation
  bypass: "2.4.1",
  "document-title": "2.4.2",
  "link-name": "2.4.4",
  "frame-title": "4.1.2",
  "frame-title-unique": "4.1.2",
  "landmark-one-main": null, // best practice
  region: null, // best practice
  "page-has-heading-one": null, // best practice
  "heading-order": null, // best practice
  "empty-heading": null, // best practice
  "identical-links-same-purpose": "2.4.9",

  // 2.5.x input modality
  "label-content-name-mismatch": "2.5.3",
  "target-size": "2.5.5", // AAA in WCAG 2.1 — see note in levelForAxeRule

  // 3.1.x language
  "html-has-lang": "3.1.1",
  "html-lang-valid": "3.1.1",
  "html-xml-lang-mismatch": "3.1.1",
  "valid-lang": "3.1.2",

  // 3.3.x forms
  "form-field-multiple-labels": "3.3.2",
  label: "4.1.2",
  "label-title-only": null, // best practice

  // 4.1.x robust
  "duplicate-id": "4.1.1",
  "duplicate-id-active": "4.1.1",
  "duplicate-id-aria": "4.1.1",
  "aria-allowed-attr": "4.1.2",
  "aria-allowed-role": null, // best practice
  "aria-prohibited-attr": "4.1.2",
  "aria-required-attr": "4.1.2",
  "aria-roles": "4.1.2",
  "aria-valid-attr": "4.1.2",
  "aria-valid-attr-value": "4.1.2",
  "aria-hidden-body": "4.1.2",
  "aria-hidden-focus": "4.1.2",
  "aria-input-field-name": "4.1.2",
  "aria-toggle-field-name": "4.1.2",
  "aria-command-name": "4.1.2",
  "aria-meter-name": "4.1.2",
  "aria-progressbar-name": "4.1.2",
  "aria-tooltip-name": "4.1.2",
  "aria-dialog-name": "4.1.2",
  "aria-text": "4.1.2",
  "aria-treeitem-name": "4.1.2",
  "button-name": "4.1.2",
  "select-name": "4.1.2",
  "input-button-name": "4.1.2",
  "nested-interactive": "4.1.2",
  "presentation-role-conflict": null, // best practice
  "aria-braille-equivalent": null, // best practice
  "empty-table-header": null, // best practice
  "frame-tested": null, // not a criterion
  "aria-status": "4.1.3",
};

/**
 * Pull the criterion out of an HTML_CodeSniffer code.
 *
 * htmlcs encodes it directly: "WCAG2AA.Principle1.Guideline1_1.1_1_1.H37"
 * carries "1_1_1", which is criterion 1.1.1. Note the "WCAG2AA" prefix names
 * the *standard being tested against*, not the criterion's level — reading it
 * as a level is a mistake that would mark every finding AA.
 */
export function criterionFromHtmlcsCode(code: string): Criterion | null {
  const match = /Guideline\d+_\d+\.(\d+)_(\d+)_(\d+)/.exec(code);
  if (!match) return null;
  return criterionByNumber(`${match[1]}.${match[2]}.${match[3]}`);
}

export function criterionFromAxeRule(ruleId: string): Criterion | null {
  const number = AXE_RULE_TO_CRITERION[ruleId];
  if (!number) return null;
  return criterionByNumber(number);
}

/** Resolve whichever engine produced the finding to a criterion. */
export function criterionFor(code: string, runner: "htmlcs" | "axe"): Criterion | null {
  return runner === "axe" ? criterionFromAxeRule(code) : criterionFromHtmlcsCode(code);
}

const ORDER: Record<WcagConformanceLevel, number> = { A: 0, AA: 1, AAA: 2 };

/** True when the criterion must be met to claim conformance at `target`. */
export function isRequiredFor(level: WcagConformanceLevel, target: TargetLevel): boolean {
  return ORDER[level] <= ORDER[target];
}

export function levelRank(level: WcagConformanceLevel): number {
  return ORDER[level];
}

export { CRITERIA };


// --- Conformance summary ---------------------------------------------------

export interface FailedCriterion {
  criterion: string;
  name: string;
  level: WcagConformanceLevel;
  findings: number;
  blocks_target: boolean;
}

export interface ConformanceSummary {
  target_level: TargetLevel;
  conformant: boolean;
  /** Distinct criteria failing, by level. Findings can be many per criterion. */
  failing_criteria: Record<WcagConformanceLevel, number>;
  /** Criteria above the committed target — enhancements, not gaps. */
  beyond_target: number;
  /** Findings that map to no success criterion at all. */
  best_practice_only: number;
  failed_criteria: FailedCriterion[];
  summary: string;
}

interface FindingLike {
  evidence: Record<string, unknown>;
}

/**
 * Roll findings up into a conformance verdict.
 *
 * The unit is the **criterion**, not the finding. Twelve findings against one
 * criterion is one thing to fix and one line in a conformance statement; the
 * finding count answers "how much work", the criterion count answers "are we
 * conformant". Reporting only the former is how a report ends up saying a page
 * has 22 accessibility issues when it fails five criteria.
 */
export function summariseConformance(
  findings: FindingLike[],
  target: TargetLevel,
): ConformanceSummary {
  const byCriterion = new Map<string, FailedCriterion>();
  let bestPracticeOnly = 0;

  for (const finding of findings) {
    const number = finding.evidence["wcag_criterion"];
    if (typeof number !== "string") {
      bestPracticeOnly++;
      continue;
    }
    const criterion = criterionByNumber(number);
    if (!criterion) {
      bestPracticeOnly++;
      continue;
    }
    const existing = byCriterion.get(number);
    if (existing) existing.findings++;
    else
      byCriterion.set(number, {
        criterion: number,
        name: criterion.name,
        level: criterion.level,
        findings: 1,
        blocks_target: isRequiredFor(criterion.level, target),
      });
  }

  const failed = [...byCriterion.values()].sort(
    (a, b) => ORDER[a.level] - ORDER[b.level] || a.criterion.localeCompare(b.criterion),
  );
  const blocking = failed.filter((f) => f.blocks_target);
  const failing: Record<WcagConformanceLevel, number> = { A: 0, AA: 0, AAA: 0 };
  for (const f of blocking) failing[f.level]++;
  const beyond = failed.length - blocking.length;

  const conformant = blocking.length === 0;
  const criteria = (n: number): string => (n === 1 ? "criterion" : "criteria");
  let summary: string;
  if (conformant) {
    summary =
      `No Level ${target} conformance failures detected by automated testing. ` +
      `This is not the same as being conformant — automated tools cover roughly a third of ` +
      `WCAG criteria, and the rest need manual verification.`;
  } else if (failing.A > 0) {
    summary =
      `Not Level ${target} conformant. ${failing.A} Level A ${criteria(failing.A)} ` +
      `${failing.A === 1 ? "fails" : "fail"}` +
      (failing.AA > 0 ? `, plus ${failing.AA} at Level AA` : "") +
      `. Level A is the floor — while any Level A criterion fails, Level ${target} conformance is ` +
      `unreachable no matter how the remaining criteria score, so fix those first.`;
  } else {
    summary =
      `Not Level ${target} conformant. Level A is fully met, but ${failing.AA} Level AA ` +
      `${criteria(failing.AA)} ${failing.AA === 1 ? "fails" : "fail"}.`;
  }
  if (beyond > 0) {
    summary += ` ${beyond} ${criteria(beyond)} above Level ${target} also failed; those are enhancements, not gaps.`;
  }

  return {
    target_level: target,
    conformant,
    failing_criteria: failing,
    beyond_target: beyond,
    best_practice_only: bestPracticeOnly,
    failed_criteria: failed,
    summary,
  };
}
