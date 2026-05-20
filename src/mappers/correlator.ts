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
const LH_TO_PA11Y_SUBSTRINGS: Record<string, string[]> = {
  "color-contrast": [".G18", ".G145", ".G174"],
  "image-alt": [".H37", ".H67", ".F65"],
  label: [".H44", ".F68", ".H91.Input", ".H91.Select", ".H91.Textarea"],
  "link-name": [".H30", ".H91.A."],
  "document-title": [".H25", ".F89"],
  "html-has-lang": [".H57"],
  "frame-title": [".H64"],
  "button-name": [".H91.Button"],
  "select-name": [".H91.Select"],
  "duplicate-id-aria": [".H93", ".F77"],
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

function makeId(tool: string, f: Finding): string {
  const e = f.evidence;
  if (tool === "lighthouse") return `lh:${String(e["audit_id"] ?? f.title)}`;
  if (tool === "a11y") {
    const code = String(e["rule_code"] ?? "").split(".").slice(-2).join(".");
    const sel = String(e["selector"] ?? "").slice(0, 16);
    return `a11y:${code}:${sel}`;
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

    for (const a11yF of a11yFindings) {
      if (consumedA11yIds.has(a11yF.id)) continue;
      const ruleCode = String(a11yF.evidence["rule_code"] ?? "");
      if (!substrings.some((s) => ruleCode.includes(s))) continue;

      // Use the better (lower index = higher priority) of the two raw priorities
      // as the base, then promote it one tier.
      const basePriority =
        PRIORITY_ORDER[lhF.priority] <= PRIORITY_ORDER[a11yF.priority]
          ? lhF.priority
          : a11yF.priority;

      correlated.push({
        id: `corr:lh+a11y:${auditId}`,
        source_tool: "lighthouse+pa11y",
        priority: promotePriority(basePriority),
        title: lhF.title,
        description:
          `[Lighthouse] ${lhF.description} ` +
          `[pa11y] ${a11yF.description} ` +
          `Two independent tools flagged the same accessibility gap — ` +
          `this cross-tool confirmation increases confidence that the issue is real and affects real users.`,
        evidence: {
          ...lhF.evidence,
          pa11y_rule_code: ruleCode,
          pa11y_selector: a11yF.evidence["selector"] ?? "",
        },
        confirmed_by: ["lighthouse", "pa11y"],
      });

      consumedLhIds.add(lhF.id);
      consumedA11yIds.add(a11yF.id);
      break; // one correlation per Lighthouse finding
    }
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
