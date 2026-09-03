import type {
  LighthouseAuditRef,
  Pa11yViolation,
} from "../utils/outputParsers.js";
import {
  lighthouseImpactToPriority,
  staticAnalysisToPriority,
  wcagConformanceToPriority,
} from "./priorityMapper.js";
import { criterionByNumber, type TargetLevel } from "./wcagLevels.js";
import type { Finding } from "../types.js";

type Templater = (a: LighthouseAuditRef) => string;

/**
 * Parenthesised measurement, or nothing at all.
 *
 * displayValue is absent on binary audits and comes and goes across Lighthouse
 * versions, so interpolating it directly left "()" or a doubled space stranded
 * mid-sentence. Every template that appends a measurement goes through this;
 * templates that build a sentence *around* the value guard it explicitly and
 * supply alternative phrasing instead.
 */
const paren = (v: string | undefined): string => (v ? ` (${v})` : "");

const QA_DESCRIPTIONS: Record<string, Templater> = {
  "first-contentful-paint": (a) =>
    a.displayValue
      ? `Users see the first piece of content ${a.displayValue} after navigation, which is slower than the recommended threshold for a smooth perceived load.`
      : `Users see the first piece of content later after navigation than the recommended threshold for a smooth perceived load.`,
  "largest-contentful-paint": (a) =>
    a.displayValue
      ? `Users see the main page content ${a.displayValue} after navigation, above the recommended threshold for a responsive feel.`
      : `Users see the main page content later after navigation than the recommended threshold for a responsive feel.`,
  "speed-index": (a) =>
    a.displayValue
      ? `The page takes ${a.displayValue} to visually populate, which feels sluggish to users on first load.`
      : `The page is slow to visually populate, which feels sluggish to users on first load.`,
  "total-blocking-time": (a) =>
    a.displayValue
      ? `The page is unresponsive to user input for ${a.displayValue} during load, causing noticeable input lag.`
      : `The page is unresponsive to user input for a prolonged stretch of the load, causing noticeable input lag.`,
  "cumulative-layout-shift": (a) =>
    `The page layout shifts unexpectedly during load${a.displayValue ? ` (CLS ${a.displayValue})` : ""}, causing users to misclick or lose their reading place.`,
  interactive: (a) =>
    a.displayValue
      ? `The page takes ${a.displayValue} before it can reliably respond to user input.`
      : `The page takes a long time before it can reliably respond to user input.`,
  // Lighthouse 13 changed this displayValue from a bare duration to a clause
  // ("Root document took 780 ms"), which broke the original inlined phrasing.
  "server-response-time": (a) =>
    a.displayValue
      ? `${a.displayValue} to respond to the initial request, delaying every downstream load step.`
      : `The server is slow to respond to the initial request, delaying every downstream load step.`,
  "document-latency-insight": (a) =>
    `The initial HTML document is slow to arrive${paren(a.displayValue)}; nothing else can start loading until it does, so this delay is paid by every other resource on the page.`,
  "render-blocking-resources": (a) =>
    `Render-blocking scripts or styles are delaying the first paint${paren(a.displayValue)}; users stare at a blank page longer than necessary.`,
  "unused-javascript": (a) =>
    `The page ships JavaScript that is never executed${paren(a.displayValue)}, inflating load time on slower connections.`,
  "unused-css-rules": (a) =>
    `The page ships CSS rules that go unused${paren(a.displayValue)}, wasting bytes on every visit.`,
  "uses-responsive-images": (a) =>
    `Images larger than their displayed size are being served${paren(a.displayValue)}, wasting bandwidth on mobile users.`,
  "uses-optimized-images": (a) =>
    `Images are not optimally compressed${paren(a.displayValue)}; users on slower networks wait longer than necessary.`,
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

  // --- Responsiveness / main thread ---
  "max-potential-fid": (a) =>
    a.displayValue
      ? `The worst-case delay between a user's first tap or click and the page reacting to it is ${a.displayValue}; users who interact early during load will feel the page freeze.`
      : `There is a long worst-case delay between a user's first tap or click and the page reacting to it; users who interact early during load will feel the page freeze.`,
  "mainthread-work-breakdown": (a) =>
    a.displayValue
      ? `The browser's main thread is busy for ${a.displayValue} during load, so scrolling, taps, and clicks are ignored or delayed while it catches up.`
      : `The browser's main thread is busy for much of the load, so scrolling, taps, and clicks are ignored or delayed while it catches up.`,
  "bootup-time": (a) =>
    a.displayValue
      ? `JavaScript occupies the main thread for ${a.displayValue}; on mid-range phones this is where most of the perceived slowness comes from.`
      : `JavaScript occupies the main thread for a prolonged stretch of the load; on mid-range phones this is where most of the perceived slowness comes from.`,
  "forced-reflow-insight": (a) =>
    `Scripts read layout values immediately after changing the DOM, forcing the browser to recalculate layout mid-frame${paren(a.displayValue)}; this shows up as stutter during scroll and interaction.`,

  // --- Console / runtime health ---
  "errors-in-console": () =>
    `The page logs JavaScript errors to the browser console during load. Each one is a code path that failed at runtime, and features downstream of it may be silently broken for real users.`,
  deprecations: (a) =>
    `The page relies on browser APIs that are deprecated${paren(a.displayValue)}; these will stop working in a future browser release and break the feature that depends on them.`,
  "inspector-issues": () =>
    `Chrome DevTools recorded issues against this page — typically blocked requests, cookie problems, or content-security violations. Each represents browser-enforced behaviour that may differ from what was tested locally.`,
  "third-party-cookies": (a) =>
    `The page sets third-party cookies${paren(a.displayValue)}. Browsers are phasing these out, so any feature depending on them — analytics, personalisation, embedded checkout — will degrade as that rollout completes.`,

  // --- Caching / payload ---
  "bf-cache": (a) =>
    `The page blocks back/forward cache restoration${paren(a.displayValue)}, so pressing Back triggers a full reload instead of an instant restore — a visible regression on the most common navigation in a browsing session.`,
  "cache-insight": (a) =>
    `Static assets are served with short or missing cache lifetimes${paren(a.displayValue)}; returning visitors re-download content that has not changed.`,
  // displayValue here is already a full clause ("Total size was 4,814 KiB"),
  // unlike the bare metrics most audits report, so it leads the sentence
  // instead of being inlined mid-clause.
  "total-byte-weight": (a) =>
    a.displayValue
      ? `${a.displayValue} — a payload that size is slow and expensive to load for users on mobile data or metered connections.`
      : `The page transfers more data than it needs to render, which is slow and expensive for users on mobile data or metered connections.`,
  "unminified-javascript": (a) =>
    `JavaScript is shipped unminified${paren(a.displayValue)}, sending comments and whitespace to every visitor.`,
  "legacy-javascript-insight": (a) =>
    `The bundle ships transpiled polyfills that modern browsers do not need${paren(a.displayValue)}, penalising up-to-date users to support ones that may no longer be in the support matrix.`,
  "image-delivery-insight": (a) =>
    `Images are not delivered in an optimal format or size${paren(a.displayValue)}; users on slower networks wait longer than necessary for the same visual result.`,
  "unsized-images": () =>
    `Images are missing explicit width and height attributes, so the browser cannot reserve space before they load and surrounding content jumps as each one arrives.`,

  // --- Network / critical path ---
  "render-blocking-insight": (a) =>
    `Scripts or stylesheets block the first paint${paren(a.displayValue)}; users stare at a blank page until they finish downloading.`,
  "lcp-discovery-insight": () =>
    `The browser cannot discover the largest content element early — it is loaded lazily, injected by script, or not preloaded — so the main content paints later than the network allows.`,
  "network-dependency-tree-insight": () =>
    `Critical resources load in a long dependent chain rather than in parallel, so total load time is the sum of the chain instead of its slowest link.`,

  // --- Accessibility (Lighthouse-side) ---
  "aria-prohibited-attr": () =>
    `An element carries an ARIA attribute that its role does not permit; assistive tech either ignores the attribute or announces the element incorrectly.`,
  // Shared with the axe runner, whose rule ids match Lighthouse audit ids.
  "aria-allowed-attr": () =>
    `An element uses an ARIA attribute its role does not support; the attribute is ignored, so the state it was meant to convey — pressed, expanded, selected — never reaches screen-reader users.`,
  "aria-required-children": () =>
    `An ARIA role that requires specific child roles is missing them; assistive tech cannot interpret the widget and may skip or misannounce its contents.`,
  "aria-required-parent": () =>
    `An element with a child ARIA role sits outside the parent role it requires; screen readers lose the relationship and announce the item without its surrounding context.`,
  "aria-valid-attr-value": () =>
    `An ARIA attribute holds an invalid value, often an id reference pointing at an element that does not exist; the name or relationship it was meant to establish silently fails.`,
  "duplicate-id-aria": () =>
    `An id used by an ARIA reference appears more than once; the reference resolves to the wrong element, so labels and relationships attach to the wrong control.`,
  "aria-dialog-name": () =>
    `A dialog or alertdialog has no accessible name; screen-reader users are moved into a modal with no indication of what it is asking them to do.`,
  "heading-order": () =>
    `Heading levels skip a step (for example h2 straight to h4); screen-reader users navigating by heading get a broken outline and may believe content is missing.`,
  "label-content-name-mismatch": () =>
    `An element's visible text is not contained in its accessible name, so speech-control users saying the label they can see fail to activate the control.`,
  "meta-viewport": () =>
    `The viewport tag disables zooming (user-scalable="no" or maximum-scale under 5); low-vision users cannot pinch-zoom to read the page.`,

  // --- SEO / crawlability ---
  "link-text": (a) =>
    `One or more links use non-descriptive text such as "click here"${paren(a.displayValue)}; screen-reader users listing links out of context cannot tell where they lead, and search engines gain no signal from the anchor.`,
  "crawlable-anchors": () =>
    `Links are not crawlable — they lack a resolvable href, so search engines cannot follow them and the destination pages may go unindexed.`,
  "robots-txt": () =>
    `robots.txt is invalid. Crawlers may misread the directives and either index pages meant to stay private or skip pages meant to rank.`,
  "llms-txt": () =>
    `llms.txt is missing or does not follow the recommended format, so AI agents fetching the site get no curated guide to its content.`,
  "agent-accessibility-tree": () =>
    `The accessibility tree is malformed, which degrades both screen readers and automated agents that navigate the page through it.`,
};

function fallbackDescription(audit: LighthouseAuditRef): string {
  const detail = audit.displayValue ? ` (current: ${audit.displayValue})` : "";
  return `The "${audit.title}" check did not meet the recommended quality threshold${detail}.`;
}

export function formatLighthouseFinding(
  audit: LighthouseAuditRef,
): Finding | null {
  const priority = lighthouseImpactToPriority(audit.score, audit.weight);
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
      // Why this landed where it did — weight is Lighthouse's own importance
      // signal, and weight 0 marks a diagnostic that blocks nothing.
      ...(audit.weight !== undefined ? { category_weight: audit.weight } : {}),
      ...(audit.category ? { category: audit.category } : {}),
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

/**
 * axe rule ids are the same identifiers Lighthouse uses for its accessibility
 * audits — Lighthouse runs axe internally — so an axe finding can borrow the
 * QA prose already written for the matching Lighthouse audit instead of
 * duplicating it. Falls back to axe's own help text, stripped of the trailing
 * documentation URL that would otherwise land in a defect ticket.
 */
function axeDescription(violation: Pa11yViolation): string {
  const shared = QA_DESCRIPTIONS[violation.code];
  if (shared) {
    return shared({ id: violation.code, displayValue: "" } as LighthouseAuditRef);
  }
  const cleaned = violation.message.replace(/\s*\(https?:\/\/[^)]*\)\s*$/, "").trim();
  return cleaned
    ? `${cleaned}. Flagged by axe as ${violation.impact ?? "unrated"} impact; assistive-tech users are likely affected.`
    : `axe rule "${violation.code}" failed; assistive-tech users are likely affected.`;
}

/**
 * One pa11y violation → a Finding, priced by WCAG conformance.
 *
 * `target` is the conformance level the project has committed to (AA for
 * essentially all commercial work). It decides whether a criterion is a gap or
 * an enhancement, so it belongs in the finding, not just the summary.
 */
export function formatA11yFinding(
  violation: Pa11yViolation,
  target: TargetLevel = "AA",
): Finding | null {
  if (violation.type === "notice") return null;

  const criterion = violation.criterion ? criterionByNumber(violation.criterion) : null;
  const { priority, blocksTarget } = wcagConformanceToPriority(violation.wcagLevel, target, {
    axeImpact: violation.impact,
    needsReview: violation.needsReview,
  });
  if (!priority) return null;

  // Every finding says which criterion it maps to and whether that criterion is
  // required at the committed level. Without it a reader cannot tell a
  // conformance gap from a best-practice nit, and the two carry very different
  // consequences.
  const wcagEvidence = criterion
    ? {
        wcag_criterion: criterion.number,
        wcag_name: criterion.name,
        wcag_level: criterion.level,
        blocks_target: blocksTarget,
      }
    : { wcag_criterion: null, wcag_level: "not-a-criterion", blocks_target: false };

  if (violation.runner === "axe") {
    return {
      priority,
      title: violation.message.replace(/\s*\(https?:\/\/[^)]*\)\s*$/, "").trim() || violation.code,
      description: withConformanceNote(axeDescription(violation), criterion, blocksTarget, target),
      evidence: {
        rule_code: violation.code,
        selector: violation.selector,
        runner: "axe",
        ...wcagEvidence,
        ...(violation.impact ? { axe_impact: violation.impact } : {}),
        ...(violation.needsReview ? { needs_manual_review: true } : {}),
      },
    };
  }

  const describe = lookupA11yTemplate(violation.technique);
  const description = describe ? describe(violation) : fallbackA11yDescription(violation);
  return {
    priority,
    title: violation.message.split(/\.\s|\.$/)[0] || violation.code,
    description: withConformanceNote(description, criterion, blocksTarget, target),
    evidence: {
      rule_code: violation.code,
      selector: violation.selector,
      ...wcagEvidence,
    },
  };
}

/**
 * Append what the finding means for the conformance claim.
 *
 * A defect description says what is broken for users. This says what it costs
 * the project — and for a Level A failure under an AA commitment, that is the
 * sentence a release manager needs, not the technique name.
 */
function withConformanceNote(
  description: string,
  criterion: ReturnType<typeof criterionByNumber>,
  blocksTarget: boolean,
  target: TargetLevel,
): string {
  if (!criterion) {
    return `${description} This is a best-practice check, not a WCAG success criterion — worth fixing, but it does not affect a conformance claim.`;
  }
  if (!blocksTarget) {
    return `${description} Maps to WCAG ${criterion.number} ${criterion.name} (Level ${criterion.level}), which is above the committed Level ${target} target — an enhancement, not a conformance gap.`;
  }
  if (criterion.level === "A") {
    return `${description} Fails WCAG ${criterion.number} ${criterion.name} at Level A. Level A is the floor: while this fails, Level ${target} conformance is not achievable regardless of how the other criteria score.`;
  }
  return `${description} Fails WCAG ${criterion.number} ${criterion.name} at Level ${criterion.level}, which is required for the committed Level ${target} target.`;
}
