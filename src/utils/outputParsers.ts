export interface LighthouseAuditRef {
  id: string;
  title: string;
  description: string;
  score: number;
  displayValue: string;
  numericValue?: number;
  numericUnit?: string;
  /**
   * The audit's weight inside its Lighthouse category, taken from
   * categories[].auditRefs[]. This is Lighthouse's own statement of how much
   * the audit matters: weight 0 means it is a diagnostic that contributes
   * nothing to the category score. Undefined when the audit belongs to no
   * category (rare — treat as unknown, not as zero).
   */
  weight?: number;
  /** Highest-weighted category the audit belongs to, for traceability. */
  category?: string;
  scoreDisplayMode?: string;
}

export interface ParsedLighthouse {
  categoryScores: Record<string, number>;
  totalScore: number;
  ttfbMs: number | null;
  failedAudits: LighthouseAuditRef[];
}

export function parseLighthouseJSON(rawJson: string): ParsedLighthouse {
  const lhr = JSON.parse(rawJson) as {
    categories?: Record<
      string,
      {
        score: number | null;
        auditRefs?: Array<{ id?: string; weight?: number }>;
      }
    >;
    audits?: Record<
      string,
      {
        id?: string;
        title?: string;
        description?: string;
        score: number | null;
        displayValue?: string;
        numericValue?: number;
        numericUnit?: string;
        scoreDisplayMode?: string;
      }
    >;
  };

  const categoryScores: Record<string, number> = {};
  // An audit can appear in more than one category; keep the highest weight,
  // since that is the strongest claim Lighthouse makes about its importance.
  const auditWeights: Record<string, { weight: number; category: string }> = {};

  for (const [key, cat] of Object.entries(lhr.categories ?? {})) {
    if (typeof cat?.score === "number") {
      categoryScores[key] = Math.round(cat.score * 100);
    }
    for (const ref of cat?.auditRefs ?? []) {
      if (!ref.id || typeof ref.weight !== "number") continue;
      const prev = auditWeights[ref.id];
      if (!prev || ref.weight > prev.weight) {
        auditWeights[ref.id] = { weight: ref.weight, category: key };
      }
    }
  }

  const scoreValues = Object.values(categoryScores);
  const totalScore =
    scoreValues.length > 0
      ? Math.round(scoreValues.reduce((a, b) => a + b, 0) / scoreValues.length)
      : 0;

  const serverResponse = lhr.audits?.["server-response-time"];
  const ttfbMs =
    typeof serverResponse?.numericValue === "number"
      ? Math.round(serverResponse.numericValue)
      : null;

  const failedAudits: LighthouseAuditRef[] = [];
  for (const [id, audit] of Object.entries(lhr.audits ?? {})) {
    if (audit?.score === null || audit?.score === undefined) continue;
    const scorePct = Math.round(audit.score * 100);
    if (scorePct >= 90) continue;
    const weightRef = auditWeights[id];
    failedAudits.push({
      id,
      title: audit.title ?? id,
      description: audit.description ?? "",
      score: scorePct,
      displayValue: audit.displayValue ?? "",
      numericValue:
        typeof audit.numericValue === "number" ? audit.numericValue : undefined,
      numericUnit: audit.numericUnit,
      weight: weightRef?.weight,
      category: weightRef?.category,
      scoreDisplayMode: audit.scoreDisplayMode,
    });
  }

  return { categoryScores, totalScore, ttfbMs, failedAudits };
}

export type WcagLevel = "A" | "AA" | "AAA" | "unknown";

export interface Pa11yViolation {
  code: string;
  technique: string;
  message: string;
  selector: string;
  context: string;
  type: "error" | "warning" | "notice";
  wcagLevel: WcagLevel;
  criterion: string | null;
}

export interface ParsedPa11y {
  violationCount: number;
  violations: Pa11yViolation[];
}

interface RawPa11yIssue {
  code?: string;
  type?: string;
  message?: string;
  context?: string;
  selector?: string;
}

const WCAG_CRITERION_LEVELS: Record<string, WcagLevel> = {
  "1.1.1": "A",
  "1.2.1": "A",
  "1.2.2": "A",
  "1.2.3": "A",
  "1.2.4": "AA",
  "1.2.5": "AA",
  "1.3.1": "A",
  "1.3.2": "A",
  "1.3.3": "A",
  "1.3.4": "AA",
  "1.3.5": "AA",
  "1.4.1": "A",
  "1.4.2": "A",
  "1.4.3": "AA",
  "1.4.4": "AA",
  "1.4.5": "AA",
  "1.4.6": "AAA",
  "1.4.10": "AA",
  "1.4.11": "AA",
  "1.4.12": "AA",
  "1.4.13": "AA",
  "2.1.1": "A",
  "2.1.2": "A",
  "2.1.4": "A",
  "2.2.1": "A",
  "2.2.2": "A",
  "2.4.1": "A",
  "2.4.2": "A",
  "2.4.3": "A",
  "2.4.4": "A",
  "2.4.5": "AA",
  "2.4.6": "AA",
  "2.4.7": "AA",
  "2.5.1": "A",
  "2.5.2": "A",
  "2.5.3": "A",
  "2.5.4": "A",
  "3.1.1": "A",
  "3.1.2": "AA",
  "3.2.1": "A",
  "3.2.2": "A",
  "3.2.3": "AA",
  "3.2.4": "AA",
  "3.3.1": "A",
  "3.3.2": "A",
  "3.3.3": "AA",
  "3.3.4": "AA",
  "4.1.1": "A",
  "4.1.2": "A",
  "4.1.3": "AA",
};

function deriveWcagLevel(code: string): {
  level: WcagLevel;
  criterion: string | null;
} {
  // pa11y/HTMLCS code shape: WCAG2AA.Principle1.Guideline1_1.1_1_1.H37
  const segments = code.split(".");
  let criterion: string | null = null;
  for (const seg of segments) {
    if (/^\d+(_\d+)+$/.test(seg)) {
      criterion = seg.replace(/_/g, ".");
      break;
    }
  }
  if (criterion && WCAG_CRITERION_LEVELS[criterion]) {
    return { level: WCAG_CRITERION_LEVELS[criterion], criterion };
  }
  // Fallback: infer from standard prefix when criterion is unknown.
  const prefix = segments[0] ?? "";
  if (prefix === "WCAG2AAA") return { level: "AAA", criterion };
  if (prefix === "WCAG2AA") return { level: "AA", criterion };
  if (prefix === "WCAG2A") return { level: "A", criterion };
  return { level: "unknown", criterion };
}

function extractTechnique(code: string): string {
  // pa11y/HTMLCS code shape: WCAG2AA.PrincipleN.GuidelineN_N.N_N_N.<technique>[.<variant>...]
  // The technique starts at the segment immediately after the criterion (e.g. "1_1_1").
  // We return the technique plus any variant suffix joined with dots, so callers can
  // disambiguate sub-rules like "H91.InputText.Name" vs "H91.A.NoContent".
  const segments = code.split(".");
  for (let i = 0; i < segments.length; i++) {
    if (/^\d+(_\d+)+$/.test(segments[i] ?? "")) {
      const suffix = segments.slice(i + 1).join(".");
      if (suffix) return suffix;
    }
  }
  return segments[segments.length - 1] ?? code;
}

// --- ESLint ---

export interface ESLintIssue {
  filePath: string;
  line: number;
  column: number;
  ruleId: string;
  message: string;
  severity: 1 | 2;
}

export interface ParsedESLint {
  issues: ESLintIssue[];
}

interface RawESLintMessage {
  ruleId?: string | null;
  severity?: number;
  message?: string;
  line?: number;
  column?: number;
}

interface RawESLintFile {
  filePath?: string;
  messages?: RawESLintMessage[];
}

export function parseESLintJSON(rawJson: string): ParsedESLint {
  const files = JSON.parse(rawJson) as RawESLintFile[];
  const issues: ESLintIssue[] = [];
  for (const file of files) {
    const filePath = file.filePath ?? "";
    for (const msg of file.messages ?? []) {
      if (!msg.ruleId) continue;
      issues.push({
        filePath,
        line: msg.line ?? 0,
        column: msg.column ?? 0,
        ruleId: msg.ruleId,
        message: msg.message ?? "",
        severity: msg.severity === 1 ? 1 : 2,
      });
    }
  }
  return { issues };
}

// --- Semgrep ---

export interface SemgrepFinding {
  filePath: string;
  line: number;
  ruleId: string;
  message: string;
  severity: string; // normalised to lowercase: "info" | "warning" | "error"
  category?: string;
}

export interface ParsedSemgrep {
  findings: SemgrepFinding[];
}

interface RawSemgrepResult {
  check_id?: string;
  path?: string;
  start?: { line?: number };
  extra?: {
    message?: string;
    severity?: string;
    metadata?: { category?: string };
  };
}

export function parseSemgrepJSON(rawJson: string): ParsedSemgrep {
  const parsed = JSON.parse(rawJson) as { results?: RawSemgrepResult[] };
  const findings: SemgrepFinding[] = [];
  for (const result of parsed.results ?? []) {
    findings.push({
      filePath: result.path ?? "",
      line: result.start?.line ?? 0,
      ruleId: result.check_id ?? "",
      message: result.extra?.message ?? "",
      severity: (result.extra?.severity ?? "info").toLowerCase(),
      category: result.extra?.metadata?.category,
    });
  }
  return { findings };
}

export function parsePa11yJSON(rawJson: string): ParsedPa11y {
  const parsed = JSON.parse(rawJson) as RawPa11yIssue[] | { issues?: RawPa11yIssue[] };
  const issues: RawPa11yIssue[] = Array.isArray(parsed)
    ? parsed
    : (parsed.issues ?? []);

  const violations: Pa11yViolation[] = [];
  for (const issue of issues) {
    const code = issue.code ?? "";
    const type = (issue.type ?? "error") as Pa11yViolation["type"];
    const { level, criterion } = deriveWcagLevel(code);
    violations.push({
      code,
      technique: extractTechnique(code),
      message: issue.message ?? "",
      selector: issue.selector ?? "",
      context: issue.context ?? "",
      type,
      wcagLevel: level,
      criterion,
    });
  }

  return { violationCount: violations.length, violations };
}
