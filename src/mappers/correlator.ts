import type { Finding, Priority } from "../types.js";

export interface CorrelatedFinding extends Finding {
  id: string;
  source_tool: string;
  confirmed_by?: string[];
  related_findings?: string[];
}

export interface ToolReports {
  lighthouse: {
    scores: Record<string, number>;
    ttfb_ms: number | null;
    findings: Finding[];
  } | null;
  a11y: {
    violation_count: number;
    findings: Finding[];
  } | null;
  static: {
    issue_count: number;
    findings: Finding[];
  } | null;
}

export interface CorrelatorResult {
  correlated_findings: CorrelatedFinding[];
  unique_findings: CorrelatedFinding[];
  correlations_count: number;
}

const PRIORITY_ORDER: Record<Priority, number> = { P1: 0, P2: 1, P3: 2 };

function promotePriority(p: Priority): Priority {
  if (p === "P3") return "P2";
  if (p === "P2") return "P1";
  return "P1";
}

// Maps Lighthouse accessibility audit IDs to substrings that appear inside the
// pa11y rule_code for the same class of issue.  A leading "." prevents matching
// partial segment names (e.g. ".H44" won't accidentally match ".1H44").
//
// Keep this keyed on defects the two tools genuinely detect in common. A wrong
// entry is worse than a missing one: a bogus match promotes a finding a whole
// priority tier and stamps it "confirmed by two tools". Where Lighthouse and
// pa11y test adjacent-but-different criteria (e.g. label-content-name-mismatch
// under WCAG 2.5.3 vs F68 under 1.3.1) they are deliberately left unmapped.
const LH_TO_PA11Y_SUBSTRINGS: Record<string, string[]> = {
  // Colour / contrast
  "color-contrast": [".G18", ".G145", ".G174"],

  // Images
  "image-alt": [".H37", ".H67", ".F65"],
  "input-image-alt": [".H36"],
  "object-alt": [".H53"],

  // Accessible names on controls
  label: [".H44", ".F68", ".H91.Input", ".H91.Select", ".H91.Textarea"],
  "form-field-multiple-labels": [".H44", ".F68"],
  "button-name": [".H91.Button"],
  "select-name": [".H91.Select"],
  "aria-input-field-name": [".ARIA6", ".ARIA9", ".H91"],
  "aria-toggle-field-name": [".ARIA6", ".ARIA9", ".H91"],
  "aria-command-name": [".ARIA6", ".ARIA9", ".H91"],
  "aria-dialog-name": [".ARIA6", ".ARIA9"],

  // ARIA misuse
  "aria-prohibited-attr": [".ARIA6", ".ARIA4"],
  "aria-valid-attr-value": [".ARIA9"],

  // Links
  "link-name": [".H30", ".H91.A."],
  "link-text": [".H30", ".H91.A."],
  "crawlable-anchors": [".G1,G123,G124", ".H30"],

  // Document / language
  "document-title": [".H25", ".F89"],
  "html-has-lang": [".H57"],
  "html-lang-valid": [".H57"],
  "valid-lang": [".H58"],

  // Structure
  "heading-order": [".G141", ".H42"],
  "frame-title": [".H64"],

  // Duplicate identifiers. Lighthouse 12 removed duplicate-id-aria altogether,
  // which is why a page throwing 35 pa11y F77 violations correlated with
  // nothing under Lighthouse 13. Both ids are kept so older Lighthouse output
  // still matches; there is currently no LH 13 equivalent to pair F77 with.
  "duplicate-id-aria": [".H93", ".F77"],
  "duplicate-id-active": [".H93", ".F77"],
};

// Lighthouse performance audit IDs where Rule 2 (code linkage) is relevant.
const PERFORMANCE_AUDIT_IDS = new Set([
  "render-blocking-resources",
  "unused-javascript",
  "unused-css-rules",
  "bootup-time",
  "mainthread-work-breakdown",
  "total-blocking-time",
]);

// Deterministic non-crypto string hash (djb2), base36-encoded.
// Selectors are long and routinely share long prefixes — e.g.
// "#accordion-panel-:rn: > div > div > input:nth-child(1)" and the same
// selector ending ":nth-child(3)" are identical for their first 40 characters.
// The previous id truncated the selector to 16 chars, so those two distinct
// findings collapsed to one id and consumedA11yIds claimed the wrong entry
// during correlation. Hashing the whole selector keeps ids short and unique.
function shortHash(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h + input.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

function makeId(tool: string, f: Finding): string {
  const e = f.evidence;
  if (tool === "lighthouse") return `lh:${String(e["audit_id"] ?? f.title)}`;
  if (tool === "a11y") {
    const code = String(e["rule_code"] ?? "").split(".").slice(-2).join(".");
    return `a11y:${code}:${shortHash(String(e["selector"] ?? ""))}`;
  }
  const basename = String(e["file"] ?? "").split("/").pop() ?? "";
  return `static:${String(e["source"] ?? "")}:${basename}:${String(e["line"] ?? "")}`;
}

function tag(tool: string, findings: Finding[]): CorrelatedFinding[] {
  return findings.map((f) => ({ ...f, id: makeId(tool, f), source_tool: tool }));
}

// Rule 1 — Double-confirmed accessibility:
// A Lighthouse accessibility finding and a pa11y finding that cover the same
// WCAG technique are merged into one finding with priority promoted one tier
// and confirmed_by set to both tools.
function applyRule1(
  lhFindings: CorrelatedFinding[],
  a11yFindings: CorrelatedFinding[],
): {
  correlated: CorrelatedFinding[];
  consumedLhIds: Set<string>;
  consumedA11yIds: Set<string>;
} {
  const correlated: CorrelatedFinding[] = [];
  const consumedLhIds = new Set<string>();
  const consumedA11yIds = new Set<string>();

  for (const lhF of lhFindings) {
    const auditId = String(lhF.evidence["audit_id"] ?? "");
    const substrings = LH_TO_PA11Y_SUBSTRINGS[auditId];
    if (!substrings) continue;

    // Claim every unconsumed pa11y finding covering the same technique, not
    // just the first. One Lighthouse audit routinely corresponds to several
    // pa11y violations — one per offending element — and stopping at the first
    // left the rest to reappear as uncorroborated copies of the same defect.
    const matches = a11yFindings.filter((a11yF) => {
      if (consumedA11yIds.has(a11yF.id)) return false;
      const ruleCode = String(a11yF.evidence["rule_code"] ?? "");
      return substrings.some((s) => ruleCode.includes(s));
    });
    if (matches.length === 0) continue;

    // Use the most severe of the matched pa11y findings, then take the better
    // (lower index = higher priority) of that and the Lighthouse finding as the
    // base, and promote it one tier.
    const worstA11y = matches.reduce((a, b) =>
      PRIORITY_ORDER[a.priority] <= PRIORITY_ORDER[b.priority] ? a : b,
    );
    const basePriority =
      PRIORITY_ORDER[lhF.priority] <= PRIORITY_ORDER[worstA11y.priority]
        ? lhF.priority
        : worstA11y.priority;

    // Findings arrive here already deduplicated, so fold the collapsed
    // occurrence counts back in to report how many elements are affected.
    const elementCount = matches.reduce(
      (n, m) => n + Number(m.evidence["occurrences"] ?? 1),
      0,
    );

    correlated.push({
      id: `corr:lh+a11y:${auditId}`,
      source_tool: "lighthouse+pa11y",
      priority: promotePriority(basePriority),
      title: lhF.title,
      description:
        `[Lighthouse] ${lhF.description} ` +
        `[pa11y] ${worstA11y.description} ` +
        `Two independent tools flagged the same accessibility gap across ` +
        `${elementCount} element${elementCount !== 1 ? "s" : ""} — ` +
        `this cross-tool confirmation increases confidence that the issue is real and affects real users.`,
      evidence: {
        ...lhF.evidence,
        pa11y_rule_codes: [
          ...new Set(matches.map((m) => String(m.evidence["rule_code"] ?? ""))),
        ],
        pa11y_selectors: matches
          .slice(0, 5)
          .map((m) => String(m.evidence["selector"] ?? "")),
        pa11y_elements_affected: elementCount,
      },
      confirmed_by: ["lighthouse", "pa11y"],
    });

    consumedLhIds.add(lhF.id);
    for (const m of matches) consumedA11yIds.add(m.id);
  }

  return { correlated, consumedLhIds, consumedA11yIds };
}

// Rule 2 — Performance ↔ code linkage:
// If a Lighthouse performance finding's description or display value contains a
// filename that also appears in a static analysis finding, the static finding is
// added as a related_finding on the Lighthouse entry.
// Note: full coverage requires the Lighthouse parser to extract resource URLs
// from audit detail items — the current parser only surfaces displayValue, so
// matches depend on whether filenames appear there.
function applyRule2(
  lhFindings: CorrelatedFinding[],
  staticFindings: CorrelatedFinding[],
): CorrelatedFinding[] {
  if (staticFindings.length === 0) return lhFindings;

  return lhFindings.map((lhF) => {
    const auditId = String(lhF.evidence["audit_id"] ?? "");
    if (!PERFORMANCE_AUDIT_IDS.has(auditId)) return lhF;

    const haystack =
      `${lhF.description} ${String(lhF.evidence["value"] ?? "")}`.toLowerCase();

    const related = staticFindings
      .filter((sf) => {
        const basename =
          String(sf.evidence["file"] ?? "").split("/").pop() ?? "";
        return basename.length > 3 && haystack.includes(basename.toLowerCase());
      })
      .map((sf) => sf.id);

    return related.length > 0 ? { ...lhF, related_findings: related } : lhF;
  });
}

export function correlate(reports: ToolReports): CorrelatorResult {
  const lhTagged = tag("lighthouse", reports.lighthouse?.findings ?? []);
  const a11yTagged = tag("a11y", reports.a11y?.findings ?? []);
  const staticTagged = tag("static", reports.static?.findings ?? []);

  const { correlated, consumedLhIds, consumedA11yIds } = applyRule1(
    lhTagged,
    a11yTagged,
  );

  const remainingLh = applyRule2(
    lhTagged.filter((f) => !consumedLhIds.has(f.id)),
    staticTagged,
  );
  const remainingA11y = a11yTagged.filter((f) => !consumedA11yIds.has(f.id));

  return {
    correlated_findings: correlated,
    unique_findings: [...remainingLh, ...remainingA11y, ...staticTagged],
    correlations_count: correlated.length,
  };
}
