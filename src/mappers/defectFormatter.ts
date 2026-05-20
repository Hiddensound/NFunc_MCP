import type {
  LighthouseAuditRef,
  Pa11yViolation,
} from "../utils/outputParsers.js";
import {
  lighthouseScoreToPriority,
  wcagLevelToPriority,
  staticAnalysisToPriority,
} from "./priorityMapper.js";
import type { Finding } from "../types.js";

type Templater = (a: LighthouseAuditRef) => string;

const QA_DESCRIPTIONS: Record<string, Templater> = {
  "first-contentful-paint": (a) =>
    `Users see the first piece of content ${a.displayValue} after navigation, which is slower than the recommended threshold for a smooth perceived load.`,
  "largest-contentful-paint": (a) =>
    `Users see the main page content ${a.displayValue} after navigation, above the recommended threshold for a responsive feel.`,
  "speed-index": (a) =>
    `The page takes ${a.displayValue} to visually populate, which feels sluggish to users on first load.`,
  "total-blocking-time": (a) =>
    `The page is unresponsive to user input for ${a.displayValue} during load, causing noticeable input lag.`,
  "cumulative-layout-shift": (a) =>
    `The page layout shifts unexpectedly during load (CLS ${a.displayValue}), causing users to misclick or lose their reading place.`,
  interactive: (a) =>
    `The page takes ${a.displayValue} before it can reliably respond to user input.`,
  "server-response-time": (a) =>
    `The server takes ${a.displayValue} to respond to the initial request, delaying every downstream load step.`,
  "render-blocking-resources": (a) =>
    `Render-blocking scripts or styles are delaying the first paint (${a.displayValue}); users stare at a blank page longer than necessary.`,
  "unused-javascript": (a) =>
    `The page ships JavaScript that is never executed (${a.displayValue}), inflating load time on slower connections.`,
  "unused-css-rules": (a) =>
    `The page ships CSS rules that go unused (${a.displayValue}), wasting bytes on every visit.`,
  "uses-responsive-images": (a) =>
    `Images larger than their displayed size are being served (${a.displayValue}), wasting bandwidth on mobile users.`,
  "uses-optimized-images": (a) =>
    `Images are not optimally compressed (${a.displayValue}); users on slower networks wait longer than necessary.`,
  "color-contrast": () =>
    `Text on the page does not have sufficient contrast against its background, making it hard to read for users with low vision.`,
  "image-alt": () =>
    `One or more images are missing alt text; screen-reader users cannot understand what the image conveys.`,
  label: () =>
    `Form fields are missing accessible labels; assistive-tech users cannot tell what each field is for.`,
  "link-name": () =>
    `One or more links have no discernible text; screen-reader users hear "link" with no destination.`,
  "document-title": () =>
    `The page is missing a <title>; users see a meaningless tab label and screen readers announce no page name.`,
  "html-has-lang": () =>
    `The <html> element has no lang attribute; screen readers may mispronounce content.`,
  "meta-description": () =>
    `The page is missing a meta description; search results show no preview snippet to users.`,
  "is-on-https": () =>
    `The page is served over HTTP rather than HTTPS; browsers warn users that the connection is not secure.`,
  viewport: () =>
    `The page has no viewport meta tag; on mobile, content renders at desktop width and users must pinch-zoom to read.`,
};

function fallbackDescription(audit: LighthouseAuditRef): string {
  const detail = audit.displayValue ? ` (current: ${audit.displayValue})` : "";
  return `The "${audit.title}" check did not meet the recommended quality threshold${detail}.`;
}

export function formatLighthouseFinding(
  audit: LighthouseAuditRef,
): Finding | null {
  const priority = lighthouseScoreToPriority(audit.score);
  if (!priority) return null;
  const describe = QA_DESCRIPTIONS[audit.id];
  const description = describe ? describe(audit) : fallbackDescription(audit);
  return {
    priority,
    title: audit.title,
    description,
    evidence: {
      audit_id: audit.id,
      value: audit.displayValue ?? "",
    },
  };
}

type A11yTemplater = (v: Pa11yViolation) => string;

// Keyed by the technique-plus-variant suffix of the pa11y rule code
// (e.g. "H91.InputText.Name" from
// "WCAG2AA.Principle4.Guideline4_1.4_1_2.H91.InputText.Name"). Lookup is
// progressive: the formatter tries the full suffix first, then strips trailing
// segments until a template matches. So a row keyed "H91" will catch any
// H91.* variant that isn't explicitly handled. Phrasing is deliberately
// user-impact-first so descriptions read like defect tickets.
const A11Y_DESCRIPTIONS: Record<string, A11yTemplater> = {
  // Images
  H37: () =>
    `Image is missing an alt attribute; screen-reader users cannot tell what the image conveys or whether it is decorative.`,
  H67: () =>
    `An image marked as decorative carries meaningful content; assistive-tech users miss information sighted users rely on.`,
  F65: () =>
    `An image is missing both alt and title; screen-reader users hear no description of the content.`,
  G94: () =>
    `Alt text does not accurately describe the image; screen-reader users get a misleading description of what is shown.`,

  // Links
  H30: () =>
    `A link contains only a non-text element with no accessible name; screen-reader users hear "link" with no destination.`,
  "H91.A.NoContent": () =>
    `A link has no visible text or accessible name; screen-reader users hear "link" with no indication of where it leads.`,
  "H91.A.Name": () =>
    `A link is missing an accessible name; screen-reader users cannot tell where it goes.`,
  "H91.A.EmptyNoId": () =>
    `An anchor has no href, text, or id; it is unreachable and unannounced to keyboard and screen-reader users.`,

  // Buttons
  "H91.Button.Name": () =>
    `A button has no accessible name; screen-reader users hear "button" with no description of its action.`,
  "H91.Button.Value": () =>
    `An input button has no value or accessible name; screen-reader users cannot tell what action it triggers.`,

  // Form fields (H91 input family)
  "H91.InputText.Name": () =>
    `A text input has no accessible label; screen-reader users cannot tell what data to enter in the field.`,
  "H91.InputPassword.Name": () =>
    `A password field has no accessible label; screen-reader users cannot tell that it expects a password.`,
  "H91.InputEmail.Name": () =>
    `An email input has no accessible label; screen-reader users cannot tell what data to enter.`,
  "H91.InputSearch.Name": () =>
    `A search input has no accessible label; screen-reader users cannot tell it is a search field.`,
  "H91.InputTel.Name": () =>
    `A telephone input has no accessible label; screen-reader users cannot tell that a phone number is expected.`,
  "H91.InputNumber.Name": () =>
    `A number input has no accessible label; screen-reader users cannot tell what numeric value is expected.`,
  "H91.InputUrl.Name": () =>
    `A URL input has no accessible label; screen-reader users cannot tell that a web address is expected.`,
  "H91.InputCheckbox.Name": () =>
    `A checkbox has no accessible label; screen-reader users cannot tell what option they are toggling.`,
  "H91.InputRadio.Name": () =>
    `A radio button has no accessible label; screen-reader users cannot tell which option it represents.`,
  "H91.InputFile.Name": () =>
    `A file-upload control has no accessible label; screen-reader users cannot tell what kind of file is expected.`,
  "H91.Select.Name": () =>
    `A dropdown has no accessible label; screen-reader users cannot tell what is being selected.`,
  "H91.Textarea.Name": () =>
    `A multi-line text area has no accessible label; screen-reader users cannot tell what content to enter.`,

  // H91 catch-all for any input/element variant not explicitly listed above.
  H91: () =>
    `An interactive element has no accessible name available to assistive tech; screen-reader users cannot tell what it is or what it does.`,

  // Form/label structure
  H32: () =>
    `A form has no submit mechanism; keyboard and assistive-tech users have no reliable way to complete and send the form.`,
  H44: () =>
    `A form control is not programmatically associated with a label; screen-reader users cannot tell what data the field expects.`,
  H85: () =>
    `Grouped options in a dropdown are not wrapped in optgroup; screen-reader users miss the grouping that sighted users see.`,
  F68: () =>
    `A form input has no accessible label; screen-reader users cannot identify what data to enter.`,
  ARIA6: () =>
    `An element uses aria-label, but it is empty or invalid; assistive tech receives no usable name for the element.`,
  ARIA9: () =>
    `An element references aria-labelledby ids that do not exist; assistive tech cannot resolve a name and announces nothing.`,

  // Headings / structure / emphasis
  H42: () =>
    `Text is styled to look like a heading but is not marked up as one; screen-reader users cannot use heading navigation to scan the page.`,
  H49: () =>
    `Emphasis is conveyed only by visual styling; screen-reader users do not receive the same emphasis cue.`,
  G141: () =>
    `Heading levels skip a step (e.g. h2 jumps to h4); screen-reader users navigating by headings get a broken outline of the page.`,

  // Language / page-level
  H57: () =>
    `The <html> element has no lang attribute; screen readers may use the wrong pronunciation profile for the page.`,
  H58: () =>
    `A passage in another language is not marked with lang; screen readers pronounce it using the page's default language.`,
  H25: () =>
    `The page has no <title>; users see a meaningless tab label and screen readers announce no page name.`,
  F89: () =>
    `The page <title> is empty; users see a meaningless tab label and screen readers announce no page name.`,

  // Frames
  H64: () =>
    `An <iframe> has no title; screen-reader users hear "frame" with no description of its contents.`,

  // Identifiers / aria references
  H93: () =>
    `Two elements share the same id; assistive tech may target the wrong element when users follow label/for or aria references.`,
  F77: () =>
    `Duplicate id detected; label/for and aria-* references resolve to the wrong element for assistive-tech users.`,

  // Presentation role misuse
  "F92,ARIA4": () =>
    `An element marked role="presentation" still contains child elements with semantic meaning; the role hides that meaning from screen-reader users.`,
  F92: () =>
    `An element marked role="presentation" still contains child elements with semantic meaning; the role hides that meaning from screen-reader users.`,
  ARIA4: () =>
    `An element uses an ARIA role inappropriate for its content; assistive tech announces the element with the wrong semantics.`,

  // Color / contrast
  G18: () =>
    `Text does not meet the minimum 4.5:1 contrast ratio against its background; low-vision users may be unable to read it.`,
  G145: () =>
    `Large text fails the minimum 3:1 contrast ratio; low-vision users may not be able to distinguish it from the background.`,
  "G18.Fail": () =>
    `Text does not meet the minimum 4.5:1 contrast ratio against its background; low-vision users may be unable to read it.`,
  "G145.Fail": () =>
    `Large text fails the minimum 3:1 contrast ratio; low-vision users may not be able to distinguish it from the background.`,
  G174: () =>
    `A mechanism to switch to a higher-contrast version is missing; users who need stronger contrast cannot read the page.`,

  // Information conveyed by sensory cues alone
  F2: () =>
    `Information is conveyed by text formatting (bold, italic, color) alone; users who cannot perceive that formatting miss the meaning.`,
  G14: () =>
    `Information is conveyed by color alone; users who cannot distinguish colors miss the meaning that color carries.`,

  // Timing / refresh
  F40: () =>
    `The page uses a meta refresh with a delay; users on assistive tech may be moved away before they can finish reading.`,
  F41: () =>
    `The page auto-refreshes without a user-controllable mechanism; assistive-tech users lose their place without warning.`,

  // Keyboard / focus
  G202: () =>
    `Keyboard focus is trapped or not visible on an element; keyboard-only users cannot tell where they are or escape the component.`,
  F54: () =>
    `Interactivity depends on a mouse-only event; keyboard-only users cannot trigger the same action.`,
  F55: () =>
    `An interactive element steals focus on hover; keyboard users are pulled away from where they intended to be.`,
};

function lookupA11yTemplate(technique: string): A11yTemplater | undefined {
  // Progressive narrowing: try the full key, then strip trailing segments
  // until we find a match or run out. "H91.InputText.Name" → "H91.InputText" → "H91".
  let key = technique;
  while (key) {
    const tpl = A11Y_DESCRIPTIONS[key];
    if (tpl) return tpl;
    const lastDot = key.lastIndexOf(".");
    if (lastDot < 0) break;
    key = key.slice(0, lastDot);
  }
  return undefined;
}

function fallbackA11yDescription(violation: Pa11yViolation): string {
  // Last-resort phrasing for rules we haven't keyed. Frame it as a user-affecting
  // gap rather than restating the raw pa11y message — the rule_code stays in
  // evidence for traceability.
  const criterion = violation.criterion
    ? `WCAG ${violation.criterion}`
    : "an accessibility rule";
  return `This element fails ${criterion}; assistive-tech users (screen readers, keyboard-only, or low-vision) are likely affected.`;
}

// --- Static analysis (ESLint + Semgrep) ---

export interface StaticAnalysisIssue {
  source: "eslint" | "semgrep";
  file: string;
  line: number;
  column?: number;
  ruleId: string;
  message: string;
  severity: number | string;
  category?: string;
}

// QA-native descriptions keyed by ESLint rule ID. Focus on the bug class the
// rule guards against, not a restatement of the rule name.
const ESLINT_RULE_DESCRIPTIONS: Record<string, string> = {
  "no-unused-vars":
    "Dead code or unused imports can hide incomplete error handlers; if a variable was meant to carry an error or state its absence means that path is never tested or exercised under failure conditions.",
  "no-undef":
    "A reference to an undeclared variable will throw a ReferenceError at runtime, but only when that specific code path is exercised — tests that skip this branch will give a false-green result.",
  eqeqeq:
    "Loose equality (==) silently coerces types: '0' == false, null == undefined, and '' == 0 all evaluate to true, creating logic bugs that pass unit tests operating on correctly typed data.",
  "no-unreachable":
    "Code after a return, throw, or break is never executed; if it contains error handling, cleanup, or assertions those code paths are permanently dead and cannot be covered by any test.",
  "no-console":
    "Leftover console statements can leak sensitive data to production logs and are a signal that the code was debugged hastily rather than properly instrumented — a common precursor to data-exposure regressions.",
  "no-empty":
    "An empty catch block silently swallows exceptions; errors that should fail the flow are suppressed, making failures invisible to monitoring, alerting, and QA gate checks.",
  "no-constant-condition":
    "A constant condition (while(true) or if(true)) produces unreachable branches or potential infinite loops that can hang test runners, block event loops, and cause silent production outages.",
};

function buildStaticAnalysisDescription(issue: StaticAnalysisIssue): string {
  const known = ESLINT_RULE_DESCRIPTIONS[issue.ruleId];
  if (known) return known;

  if (issue.source === "semgrep" && issue.category === "security") {
    return (
      `Security vulnerability detected by Semgrep (${issue.ruleId}): ${issue.message} ` +
      `This class of issue can lead to data exposure, injection attacks, or authentication bypass — ` +
      `bugs that are rarely caught by functional tests because they require adversarial inputs.`
    );
  }

  const label = issue.source === "eslint" ? "ESLint" : "Semgrep";
  return (
    `${label} rule ${issue.ruleId} flagged a potential issue: ${issue.message} ` +
    `This type of finding can indicate a bug class that manifests only under specific conditions ` +
    `not covered by the current test suite.`
  );
}

export function formatStaticAnalysisFinding(
  issue: StaticAnalysisIssue,
): Finding | null {
  const priority = staticAnalysisToPriority(
    issue.source,
    issue.severity,
    issue.category,
  );
  if (!priority) return null;

  const firstLine = issue.message.split("\n")[0]?.trim() ?? issue.ruleId;
  return {
    priority,
    title: `[${issue.ruleId}] ${firstLine}`,
    description: buildStaticAnalysisDescription(issue),
    evidence: {
      file: issue.file,
      line: issue.line,
      rule_id: issue.ruleId,
      source: issue.source,
    },
  };
}

export function formatA11yFinding(violation: Pa11yViolation): Finding | null {
  if (violation.type === "notice") return null;
  const priority = wcagLevelToPriority(violation.wcagLevel);
  if (!priority) return null;
  const describe = lookupA11yTemplate(violation.technique);
  const description = describe
    ? describe(violation)
    : fallbackA11yDescription(violation);
  return {
    priority,
    title: violation.message.split(/\.\s|\.$/)[0] || violation.code,
    description,
    evidence: {
      rule_code: violation.code,
      selector: violation.selector,
    },
  };
}
