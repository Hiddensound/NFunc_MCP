import { criterionFor } from "../mappers/wcagLevels.js";

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
export type A11yRunner = "htmlcs" | "axe";
export type AxeImpact = "critical" | "serious" | "moderate" | "minor";

export interface Pa11yViolation {
  code: string;
  technique: string;
  message: string;
  selector: string;
  context: string;
  type: "error" | "warning" | "notice";
  wcagLevel: WcagLevel;
  criterion: string | null;
  /**
   * Which engine produced this. The two emit completely different `code`
   * shapes — htmlcs gives WCAG technique paths
   * ("WCAG2AA.Principle1.Guideline1_1.1_1_1.H37"), axe gives bare rule ids
   * ("image-alt") — so every consumer has to branch on this rather than
   * pattern-matching the code.
   */
  runner: A11yRunner;
  /** axe only: axe's own severity rating, its equivalent of Lighthouse weight. */
  impact?: AxeImpact;
  /** axe only: the rule could not decide alone and wants human confirmation. */
  needsReview?: boolean;
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
  runner?: string;
  runnerExtras?: {
    impact?: string;
    needsFurtherReview?: boolean;
    help?: string;
    description?: string;
  };
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

/**
 * Resolve a finding to its WCAG success criterion and level.
 *
 * Both engines are handled here now. htmlcs encodes the criterion in its code;
 * axe does not expose WCAG tags through pa11y at all, so its rule ids go
 * through a lookup table. The previous implementation inferred the level from
 * the code's "WCAG2AA" prefix when the criterion was unknown — but that prefix
 * names the *standard being tested against*, not the criterion's own level, so
 * it labelled everything AA and made a level-based priority scheme impossible.
 */
function deriveWcagLevel(
  code: string,
  runner: A11yRunner,
): { level: WcagLevel; criterion: string | null } {
  const found = criterionFor(code, runner);
  if (found) return { level: found.level, criterion: found.number };
  return { level: "unknown", criterion: null };
}

function isAxeImpact(v: string | undefined): v is AxeImpact {
  return v === "critical" || v === "serious" || v === "moderate" || v === "minor";
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

// --- Trivy ---

export type TrivySeverity = "UNKNOWN" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

/**
 * Trivy's `Package.Relationship`. Verified against
 * aquasecurity/trivy pkg/fanal/types/package.go — the constants serialise as
 * these five strings.
 *
 * `root` is the scanned project itself and `workspace` a workspace member;
 * both are "yours" in the sense that matters for remediation, so they are
 * treated alongside `direct` rather than as a third category. `unknown` means
 * Trivy could not classify it, which is not the same as indirect — see
 * `joined` on TrivyVulnerability.
 */
export type TrivyRelationship =
  | "unknown"
  | "root"
  | "workspace"
  | "direct"
  | "indirect";

/**
 * Statuses that mean "no upstream fix exists".
 *
 * These are exactly the statuses Trivy's `--ignore-unfixed` suppresses. We
 * deliberately do not pass that flag: an unfixable CVE is the one case that
 * needs a human mitigation decision, and hiding it means the decision never
 * gets made. They are separated out of the work queue instead.
 */
const NO_FIX_STATUSES = new Set([
  "affected",
  "will_not_fix",
  "fix_deferred",
  "end_of_life",
]);

export interface TrivyVulnerability {
  id: string;
  pkgId: string;
  pkgName: string;
  installedVersion: string;
  /** Comma-separated in some ecosystems; split into a list here. */
  fixedVersions: string[];
  status: string;
  /** True when no upstream fix exists — decision queue, not work queue. */
  unfixable: boolean;
  severity: TrivySeverity;
  title: string;
  primaryUrl: string;
  target: string;
  /** Joined from Results[].Packages[] — absent on the vulnerability itself. */
  relationship: TrivyRelationship;
  dev: boolean;
  /**
   * Whether the PkgID join onto Packages[] succeeded. False means
   * `relationship` and `dev` are placeholders and the finding must be priced
   * on severity alone, the same way lighthouseImpactToPriority falls back when
   * an audit carries no category weight.
   */
  joined: boolean;
}

/**
 * A Trivy secret finding, reduced to the fields that are safe to emit.
 *
 * Trivy's raw Secret object also carries `Match` and `Code.Lines[].Content`.
 * Neither is represented here, and that is the entire point of this interface:
 * CLAUDE.md states that secrets never reach tool output, `run_qa_gate` writes
 * its report to disk, and Trivy's masking of `Match` is documented only for
 * table output. Surrounding source lines can carry a second, unmasked
 * credential. So the parser allowlists fields in rather than filtering fields
 * out — a new upstream field cannot leak through a shape that never had a home
 * for it.
 */
export interface TrivySecret {
  ruleId: string;
  category: string;
  severity: TrivySeverity;
  title: string;
  startLine: number;
  endLine: number;
  target: string;
}

export interface TrivyMisconfiguration {
  id: string;
  avdId: string;
  type: string;
  title: string;
  description: string;
  message: string;
  resolution: string;
  severity: TrivySeverity;
  target: string;
  resource: string;
  startLine: number | null;
  primaryUrl: string;
}

export interface TrivyLicense {
  pkgName: string;
  name: string;
  severity: TrivySeverity;
  category: string;
  filePath: string;
  confidence: number;
  link: string;
}

export interface ParsedTrivy {
  artifactName: string;
  vulnerabilities: TrivyVulnerability[];
  secrets: TrivySecret[];
  misconfigurations: TrivyMisconfiguration[];
  licenses: TrivyLicense[];
  /** Vulnerabilities whose PkgID join missed. Surfaced to the caller. */
  unjoinedCount: number;
}

interface RawTrivyPackage {
  ID?: string;
  Name?: string;
  Version?: string;
  Dev?: boolean;
  Relationship?: string;
}

interface RawTrivyVulnerability {
  VulnerabilityID?: string;
  PkgID?: string;
  PkgName?: string;
  InstalledVersion?: string;
  FixedVersion?: string;
  Status?: string;
  Severity?: string;
  Title?: string;
  PrimaryURL?: string;
}

// Match and Code are deliberately absent — see TrivySecret.
interface RawTrivySecret {
  RuleID?: string;
  Category?: string;
  Severity?: string;
  Title?: string;
  StartLine?: number;
  EndLine?: number;
}

interface RawTrivyMisconfiguration {
  ID?: string;
  AVDID?: string;
  Type?: string;
  Title?: string;
  Description?: string;
  Message?: string;
  Resolution?: string;
  Severity?: string;
  Status?: string;
  PrimaryURL?: string;
  CauseMetadata?: { Resource?: string; StartLine?: number };
}

interface RawTrivyLicense {
  Severity?: string;
  Category?: string;
  PkgName?: string;
  FilePath?: string;
  Name?: string;
  Confidence?: number;
  Link?: string;
}

interface RawTrivyResult {
  Target?: string;
  Class?: string;
  Packages?: RawTrivyPackage[];
  Vulnerabilities?: RawTrivyVulnerability[];
  Misconfigurations?: RawTrivyMisconfiguration[];
  Secrets?: RawTrivySecret[];
  Licenses?: RawTrivyLicense[];
}

function normaliseSeverity(raw: string | undefined): TrivySeverity {
  const s = (raw ?? "").toUpperCase();
  if (s === "CRITICAL" || s === "HIGH" || s === "MEDIUM" || s === "LOW") return s;
  return "UNKNOWN";
}

function normaliseRelationship(raw: string | undefined): TrivyRelationship {
  const r = (raw ?? "").toLowerCase();
  if (r === "root" || r === "workspace" || r === "direct" || r === "indirect") return r;
  return "unknown";
}

/** "1.2.3" → ["1.2.3"]; "1.2.3, 2.0.1" → ["1.2.3", "2.0.1"]; "" → []. */
function splitFixedVersions(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

/**
 * One Trivy JSON report → the four finding classes, with the package join
 * applied.
 *
 * The join is the reason this function is longer than its siblings.
 * `DetectedVulnerability` carries no Relationship and no Dev field — verified
 * against pkg/types/vulnerability.go — so the two signals the priority model
 * needs most live on `Package`, in the same Result's `Packages[]` array. That
 * array is present because `--list-all-pkgs` defaults to true.
 *
 * Keyed on `PkgID`, never on `PkgIdentifier.PURL`: PURL carries `json:"-"` and
 * depends on custom marshalling that has shipped empty (trivy#7464). A
 * `name@version` secondary key covers the ecosystems where PkgID comes back
 * blank, and anything still unmatched is flagged rather than assumed.
 */
export function parseTrivyJSON(rawJson: string): ParsedTrivy {
  const report = JSON.parse(rawJson) as {
    ArtifactName?: string;
    Results?: RawTrivyResult[];
  };

  const vulnerabilities: TrivyVulnerability[] = [];
  const secrets: TrivySecret[] = [];
  const misconfigurations: TrivyMisconfiguration[] = [];
  const licenses: TrivyLicense[] = [];
  let unjoinedCount = 0;

  for (const result of report.Results ?? []) {
    const target = result.Target ?? "";

    // Per-Result package index. Packages are scoped to their Result (the same
    // package name can appear at different versions in two lockfiles), so
    // building one index across the whole report would cross-contaminate.
    const byId = new Map<string, RawTrivyPackage>();
    const byNameVersion = new Map<string, RawTrivyPackage>();
    for (const pkg of result.Packages ?? []) {
      if (pkg.ID) byId.set(pkg.ID, pkg);
      if (pkg.Name && pkg.Version) byNameVersion.set(`${pkg.Name}@${pkg.Version}`, pkg);
    }

    for (const vuln of result.Vulnerabilities ?? []) {
      const pkgName = vuln.PkgName ?? "";
      const installedVersion = vuln.InstalledVersion ?? "";
      const pkgId = vuln.PkgID ?? "";

      const pkg =
        (pkgId ? byId.get(pkgId) : undefined) ??
        byNameVersion.get(`${pkgName}@${installedVersion}`);
      const joined = pkg !== undefined;
      if (!joined) unjoinedCount += 1;

      const fixedVersions = splitFixedVersions(vuln.FixedVersion);
      const status = (vuln.Status ?? "").toLowerCase();

      vulnerabilities.push({
        id: vuln.VulnerabilityID ?? "",
        pkgId,
        pkgName,
        installedVersion,
        fixedVersions,
        status,
        // Both halves matter. A status in the no-fix set is Trivy stating there
        // is no fix; an empty FixedVersion is the same fact arriving by
        // omission, which is how several language ecosystems report it.
        unfixable: fixedVersions.length === 0 || NO_FIX_STATUSES.has(status),
        severity: normaliseSeverity(vuln.Severity),
        title: vuln.Title ?? "",
        primaryUrl: vuln.PrimaryURL ?? "",
        target,
        relationship: joined ? normaliseRelationship(pkg.Relationship) : "unknown",
        dev: joined ? pkg.Dev === true : false,
        joined,
      });
    }

    for (const secret of result.Secrets ?? []) {
      secrets.push({
        ruleId: secret.RuleID ?? "",
        category: secret.Category ?? "",
        severity: normaliseSeverity(secret.Severity),
        title: secret.Title ?? "",
        startLine: secret.StartLine ?? 0,
        endLine: secret.EndLine ?? 0,
        target,
      });
    }

    for (const mc of result.Misconfigurations ?? []) {
      // Trivy includes PASS and EXCEPTION entries when asked to; a passing
      // check is never a finding here, per the project-wide rule that nothing
      // which passes is ever reported.
      if ((mc.Status ?? "FAIL").toUpperCase() !== "FAIL") continue;
      misconfigurations.push({
        id: mc.ID ?? mc.AVDID ?? "",
        avdId: mc.AVDID ?? "",
        type: mc.Type ?? "",
        title: mc.Title ?? "",
        description: mc.Description ?? "",
        message: mc.Message ?? "",
        resolution: mc.Resolution ?? "",
        severity: normaliseSeverity(mc.Severity),
        target,
        resource: mc.CauseMetadata?.Resource ?? "",
        startLine:
          typeof mc.CauseMetadata?.StartLine === "number"
            ? mc.CauseMetadata.StartLine
            : null,
        primaryUrl: mc.PrimaryURL ?? "",
      });
    }

    for (const lic of result.Licenses ?? []) {
      licenses.push({
        pkgName: lic.PkgName ?? "",
        name: lic.Name ?? "",
        severity: normaliseSeverity(lic.Severity),
        category: lic.Category ?? "",
        filePath: lic.FilePath ?? "",
        confidence: typeof lic.Confidence === "number" ? lic.Confidence : 0,
        link: lic.Link ?? "",
      });
    }
  }

  return {
    artifactName: report.ArtifactName ?? "",
    vulnerabilities,
    secrets,
    misconfigurations,
    licenses,
    unjoinedCount,
  };
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
    const runner: A11yRunner = issue.runner === "axe" ? "axe" : "htmlcs";

    if (runner === "axe") {
      // axe codes are bare rule ids with no WCAG path in them, so they go
      // through the rule → criterion table rather than the code parser. This
      // branch used to hardcode level "unknown" because that table did not
      // exist; leaving it that way after adding the table made every axe
      // finding read as a best-practice nit, including image-alt and
      // color-contrast, which are 1.1.1 (A) and 1.4.3 (AA).
      const impact = issue.runnerExtras?.impact;
      const axeCriterion = deriveWcagLevel(code, runner);
      violations.push({
        code,
        technique: code,
        message: issue.message ?? "",
        selector: issue.selector ?? "",
        context: issue.context ?? "",
        type,
        wcagLevel: axeCriterion.level,
        criterion: axeCriterion.criterion,
        runner,
        impact: isAxeImpact(impact) ? impact : undefined,
        needsReview: issue.runnerExtras?.needsFurtherReview === true,
      });
      continue;
    }

    const { level, criterion } = deriveWcagLevel(code, runner);
    violations.push({
      code,
      technique: extractTechnique(code),
      message: issue.message ?? "",
      selector: issue.selector ?? "",
      context: issue.context ?? "",
      type,
      wcagLevel: level,
      criterion,
      runner,
    });
  }

  return { violationCount: violations.length, violations };
}
