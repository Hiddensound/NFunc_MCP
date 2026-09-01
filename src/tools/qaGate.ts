import { z } from "zod";
import { resolve } from "path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runShell } from "../utils/shellRunner.js";
import {
  parseLighthouseJSON,
  parsePa11yJSON,
  parseSemgrepJSON,
} from "../utils/outputParsers.js";
import {
  formatLighthouseFinding,
  formatA11yFinding,
  formatStaticAnalysisFinding,
  type StaticAnalysisIssue,
} from "../mappers/defectFormatter.js";
import { dedupeA11yFindings } from "../mappers/a11yDedupe.js";
import {
  lighthouseSubScore,
  a11ySubScore,
  staticSubScore,
  compositeScore,
  type SubScores,
} from "../mappers/compositeScore.js";
import { formFactorArgs, type FormFactor } from "./lighthouse.js";
import { runESLint } from "../utils/eslintRunner.js";
import {
  correlate,
  type ToolReports,
  type CorrelatedFinding,
} from "../mappers/correlator.js";
import type { Finding } from "../types.js";
import type { Priority } from "../mappers/priorityMapper.js";
import { generateHtmlReport } from "../utils/reportGenerator.js";

const PRIORITY_ORDER: Record<Priority, number> = { P1: 0, P2: 1, P3: 2 };

// Option 1: four-tier readiness replaces binary pass/fail
type ReleaseReadiness = "BLOCKED" | "CONDITIONAL" | "ADVISORY" | "CLEAR";

interface ScorecardEntry {
  tool: string;
  gate: "PASS" | "FAIL" | "WARN" | "UNAVAILABLE" | "SKIPPED";
  score?: number;
  breakdown?: Record<string, number>;
  issues?: number;
  // pa11y only: raw occurrence count before (rule_code, selector) dedup.
  // Present only when dedup actually collapsed something.
  raw_issues?: number;
}

// ---------------------------------------------------------------------------
// Per-tool runners — each returns a structured result and never throws.
// Errors are surfaced as the `error` field so a partial failure in one tool
// doesn't prevent the other two from contributing findings.
// ---------------------------------------------------------------------------

async function runLighthouse(
  url: string,
  formFactor: FormFactor,
): Promise<{
  scores: Record<string, number>;
  ttfb_ms: number | null;
  findings: Finding[];
  error?: string;
}> {
  const result = await runShell(
    "lighthouse",
    [
      url,
      "--output=json",
      "--quiet",
      "--chrome-flags=--headless",
      ...formFactorArgs(formFactor),
    ],
    { timeoutMs: 180_000 },
  );
  if (result.exitCode === -1 && !result.stdout && !result.stderr) {
    return { scores: {}, ttfb_ms: null, findings: [], error: "Lighthouse is not installed or not found in PATH." };
  }
  if (!result.stdout) {
    return { scores: {}, ttfb_ms: null, findings: [], error: `Lighthouse failed (exit ${result.exitCode}): ${result.stderr.slice(0, 300)}` };
  }
  try {
    const parsed = parseLighthouseJSON(result.stdout);
    const findings: Finding[] = [];
    for (const audit of parsed.failedAudits) {
      const f = formatLighthouseFinding(audit);
      if (f) findings.push(f);
    }
    return { scores: parsed.categoryScores, ttfb_ms: parsed.ttfbMs, findings };
  } catch (err) {
    return {
      scores: {}, ttfb_ms: null, findings: [],
      error: `Lighthouse output could not be parsed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function runA11y(
  url: string,
  engines: Array<"htmlcs" | "axe">,
): Promise<{
  violation_count: number;
  raw_violation_count?: number;
  findings: Finding[];
  error?: string;
}> {
  const results = await Promise.all(
    engines.map((e) =>
      runShell(
        "pa11y",
        [url, "--reporter", "json", "--standard", "WCAG2AA", "--runner", e],
        { timeoutMs: 120_000 },
      ),
    ),
  );

  if (results.every((r) => r.exitCode === -1 && !r.stdout && !r.stderr)) {
    return { violation_count: 0, findings: [], error: "pa11y is not installed or not found in PATH." };
  }
  // pa11y exits 2 when violations are found — that is a successful run.
  const usable = results.filter(
    (r) => (r.exitCode === 0 || r.exitCode === 2) && r.stdout,
  );
  if (usable.length === 0) {
    const r = results[0]!;
    return { violation_count: 0, findings: [], error: `pa11y failed (exit ${r.exitCode}): ${r.stderr.slice(0, 300)}` };
  }

  try {
    const rawFindings: Finding[] = [];
    for (const result of usable) {
      for (const v of parsePa11yJSON(result.stdout).violations) {
        const f = formatA11yFinding(v);
        if (f) rawFindings.push(f);
      }
    }
    // Dedup before the findings reach the correlator and the composite score —
    // 35 copies of one defect otherwise floor the score and swamp all_findings.
    const { findings, rawCount } = dedupeA11yFindings(rawFindings);
    return { violation_count: findings.length, raw_violation_count: rawCount, findings };
  } catch (err) {
    return {
      violation_count: 0, findings: [],
      error: `pa11y output could not be parsed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function runStatic(absPath: string): Promise<{
  issue_count: number;
  eslint_config_used: string;
  findings: Finding[];
  warnings: string[];
}> {
  const semgrepArgs = [
    "--config=p/javascript", "--config=p/typescript",
    "--json", "--exclude", "node_modules", ".",
  ];

  const [eslintRun, semgrepResult] = await Promise.all([
    runESLint(absPath),
    runShell("semgrep", semgrepArgs, { timeoutMs: 180_000, cwd: absPath }),
  ]);

  const allIssues: StaticAnalysisIssue[] = [...eslintRun.issues];
  const warnings: string[] = [...eslintRun.warnings];

  if (semgrepResult.exitCode === -1 && !semgrepResult.stdout && !semgrepResult.stderr) {
    warnings.push("Semgrep not installed — Semgrep analysis skipped.");
  } else if (semgrepResult.stdout) {
    try {
      for (const f of parseSemgrepJSON(semgrepResult.stdout).findings) {
        allIssues.push({ source: "semgrep", file: f.filePath, line: f.line, ruleId: f.ruleId, message: f.message, severity: f.severity, category: f.category });
      }
    } catch { warnings.push("Semgrep output could not be parsed."); }
  }

  // Deduplicate by file:line.
  const dedupMap = new Map<string, Finding>();
  for (const issue of allIssues) {
    const f = formatStaticAnalysisFinding(issue);
    if (!f) continue;
    const key = `${String(f.evidence["file"])}:${String(f.evidence["line"])}`;
    const existing = dedupMap.get(key);
    if (!existing || PRIORITY_ORDER[f.priority] < PRIORITY_ORDER[existing.priority]) {
      dedupMap.set(key, f);
    }
  }
  const findings = Array.from(dedupMap.values());

  return { issue_count: findings.length, eslint_config_used: eslintRun.config_used, findings, warnings };
}

// ---------------------------------------------------------------------------
// Report assembly helpers
// ---------------------------------------------------------------------------

// Option 1: four-tier readiness verdict
function buildVerdict(findings: CorrelatedFinding[]): ReleaseReadiness {
  if (findings.some((f) => f.priority === "P1")) return "BLOCKED";
  if (findings.some((f) => f.priority === "P2")) return "CONDITIONAL";
  if (findings.some((f) => f.priority === "P3")) return "ADVISORY";
  return "CLEAR";
}

// Composite score. See src/mappers/compositeScore.ts for why this is a
// weighted mean of per-tool sub-scores rather than one global subtraction.
function buildSubScores(
  lhData: { scores: Record<string, number>; error?: string } | null,
  a11yData: { findings: Finding[]; error?: string } | null,
  staticData: { findings: Finding[] } | null,
): SubScores {
  return {
    lighthouse:
      lhData && !lhData.error ? lighthouseSubScore(lhData.scores) : null,
    pa11y: a11yData && !a11yData.error ? a11ySubScore(a11yData.findings) : null,
    static: staticData ? staticSubScore(staticData.findings) : null,
  };
}

// Option 3: compact per-tool scorecard
// Any argument may be null when the caller did not supply the corresponding
// input (url or path) — those tools show SKIPPED rather than UNAVAILABLE.
// UNAVAILABLE is reserved for tools that were attempted but failed or are not installed.
function buildScorecard(
  lhData: { scores: Record<string, number>; error?: string } | null,
  a11yData: {
    violation_count: number;
    raw_violation_count?: number;
    findings: Finding[];
    error?: string;
  } | null,
  staticData: { issue_count: number; findings: Finding[] } | null,
): ScorecardEntry[] {
  const entries: ScorecardEntry[] = [];

  if (lhData === null) {
    entries.push({ tool: "Lighthouse", gate: "SKIPPED" });
  } else if (lhData.error) {
    entries.push({ tool: "Lighthouse", gate: "UNAVAILABLE" });
  } else {
    const vals = Object.values(lhData.scores);
    const avg = vals.length > 0
      ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length)
      : 0;
    entries.push({
      tool: "Lighthouse",
      gate: avg < 50 ? "FAIL" : avg < 80 ? "WARN" : "PASS",
      score: avg,
      breakdown: lhData.scores,
    });
  }

  if (a11yData === null) {
    entries.push({ tool: "pa11y", gate: "SKIPPED" });
  } else if (a11yData.error) {
    entries.push({ tool: "pa11y", gate: "UNAVAILABLE" });
  } else {
    const hasP1 = a11yData.findings.some((f) => f.priority === "P1");
    const hasP2 = a11yData.findings.some((f) => f.priority === "P2");
    const raw = a11yData.raw_violation_count;
    entries.push({
      tool: "pa11y",
      gate: hasP1 ? "FAIL" : hasP2 ? "WARN" : "PASS",
      issues: a11yData.violation_count,
      ...(raw !== undefined && raw > a11yData.violation_count
        ? { raw_issues: raw }
        : {}),
    });
  }

  if (staticData === null) {
    entries.push({ tool: "ESLint / Semgrep", gate: "SKIPPED" });
  } else {
    const staticP1 = staticData.findings.some((f) => f.priority === "P1");
    const staticP2 = staticData.findings.some((f) => f.priority === "P2");
    entries.push({
      tool: "ESLint / Semgrep",
      gate: staticP1 ? "FAIL" : staticP2 ? "WARN" : "PASS",
      issues: staticData.issue_count,
    });
  }

  return entries;
}

function buildSummary(
  allFindings: CorrelatedFinding[],
  toolsRan: string[],
  readiness: ReleaseReadiness,
  correlationsFound: number,
): string {
  const n = allFindings.length;
  const m = toolsRan.length;

  // Priority breakdown — only mention tiers that have findings
  const p1 = allFindings.filter((f) => f.priority === "P1").length;
  const p2 = allFindings.filter((f) => f.priority === "P2").length;
  const p3 = allFindings.filter((f) => f.priority === "P3").length;
  const breakdown = (
    [p1 > 0 ? `${p1} P1` : "", p2 > 0 ? `${p2} P2` : "", p3 > 0 ? `${p3} P3` : ""]
      .filter(Boolean)
      .join(", ")
  ) || "none";

  const corrLine =
    correlationsFound > 0
      ? ` ${correlationsFound} cross-confirmed by two tools (high confidence — see corroborated_findings).`
      : "";

  const readinessLine: Record<ReleaseReadiness, string> = {
    BLOCKED:     "Release is BLOCKED — resolve P1s before shipping.",
    CONDITIONAL: "Conditionally shippable — P2 issues should be tracked.",
    ADVISORY:    "Advisory only — P3 issues are safe to ship, log as tech debt.",
    CLEAR:       "All clear — no issues detected.",
  };

  return `${n} finding${n !== 1 ? "s" : ""} (${breakdown}) across ${m} tool${m !== 1 ? "s" : ""}.${corrLine} ${readinessLine[readiness]}`;
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

const inputShape = {
  url: z
    .string()
    .url()
    .optional()
    .describe(
      "URL of the running page to audit with Lighthouse and pa11y. " +
      "Required for performance and accessibility checks. " +
      "Omit when the user only has a local codebase and no running server. " +
      "Accept localhost addresses, staging links, preview URLs, or production URLs.",
    ),
  path: z
    .string()
    .optional()
    .describe(
      "Absolute or relative path to the local codebase to scan with ESLint and Semgrep. " +
      "Required for static analysis and code quality checks. " +
      "Omit when the user only provides a URL and has no local code to scan. " +
      "Use the current working directory if the user doesn't specify one explicitly.",
    ),
  context: z
    .string()
    .optional()
    .describe(
      "Optional free-text context about the project (e.g. 'React SPA', 'checkout flow', " +
      "'marketing site'). Pass anything the user mentions about what the app is or does.",
    ),
  form_factor: z
    .enum(["mobile", "desktop", "both"])
    .optional()
    .describe(
      "Lighthouse device profile: 'desktop' (default, unthrottled), 'mobile' " +
      "(throttled slow 4G with a 4x CPU slowdown, which scores far lower for " +
      "the same page), or 'both'. The profiles render different DOM and find " +
      "different accessibility and SEO defects, so 'both' is the thorough " +
      "choice; it runs concurrently and costs little extra wall time.",
    ),
  a11y_runner: z
    .enum(["htmlcs", "axe", "both"])
    .optional()
    .describe(
      "pa11y engine: 'htmlcs' (default) for WCAG techniques, structure, " +
      "labels and forms; 'axe' for materially better ARIA and computed " +
      "contrast coverage; 'both' to merge them. Choose 'axe' or 'both' when " +
      "the code under test involves ARIA or a component library.",
    ),
};

export function registerQaGateTool(server: McpServer): void {
  server.registerTool(
    "run_qa_gate",
    {
      description:
        "THE default tool to reach for whenever the user asks any of the following — " +
        "or anything similar: 'health check', 'QA snapshot', 'smoke test', 'ready to ship', " +
        "'any red flags', 'overall quality', 'non-functional testing', 'scan everything', " +
        "'give me a report', 'how does this look', 'is this good enough to release'. " +
        "url and path are BOTH OPTIONAL — provide whichever the user has. " +
        "url-only: runs Lighthouse + pa11y, skips static analysis. " +
        "path-only: runs ESLint + Semgrep, skips browser checks. " +
        "Both: full suite. At least one must be supplied. " +
        "\n\n" +
        "What it does: runs Lighthouse (performance, accessibility, SEO, best-practices), " +
        "pa11y (WCAG accessibility violations), ESLint (code bug-risk rules), and Semgrep " +
        "(security patterns) ALL IN PARALLEL, then cross-correlates findings across tools. " +
        "When two tools independently flag the same issue, that finding is promoted one " +
        "priority tier (P3→P2, P2→P1) and marked as confirmed_by both tools — this is the " +
        "'smoking gun' signal. " +
        "\n\n" +
        "Returns: release_readiness (BLOCKED / CONDITIONAL / ADVISORY / CLEAR), a composite_score " +
        "(0–100 severity-weighted health score), a per-tool scorecard with gate status, a plain-English " +
        "summary, top 3 issues, and a full prioritised finding list. " +
        "If any individual tool is not installed, the report is still produced from the others — " +
        "it never fails completely.",
      inputSchema: inputShape,
    },
    async ({ url, path: targetPath, form_factor, a11y_runner }) => {
      if (!url && !targetPath) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({
            error: "Provide at least one of url or path. " +
              "url runs Lighthouse + pa11y; path runs ESLint + Semgrep; both runs the full suite.",
          }) }],
          isError: true,
        };
      }

      const requestedFF = form_factor ?? "desktop";
      const factors: FormFactor[] =
        requestedFF === "both" ? ["mobile", "desktop"] : [requestedFF];
      const requestedRunner = a11y_runner ?? "htmlcs";
      const engines: Array<"htmlcs" | "axe"> =
        requestedRunner === "both" ? ["htmlcs", "axe"] : [requestedRunner];

      // Only run the tools we have inputs for. null means deliberately skipped,
      // not a failure — the scorecard will show SKIPPED for those entries.
      // Every leg — including each Lighthouse form factor — runs concurrently.
      const [lhRuns, a11yData, staticData] = await Promise.all([
        url
          ? Promise.all(
              factors.map(async (ff) => ({ ff, data: await runLighthouse(url, ff) })),
            )
          : null,
        url ? runA11y(url, engines) : null,
        targetPath ? runStatic(resolve(targetPath)) : null,
      ]);

      // Collapse the form factors into one Lighthouse view for the rest of the
      // report. Findings are merged on audit_id and tagged with the form
      // factors they affect; scores keep the worst per category, since a page
      // is only as healthy as its weaker profile.
      const lhOk = lhRuns?.filter((r) => !r.data.error) ?? [];
      const lhData: {
        scores: Record<string, number>;
        ttfb_ms: number | null;
        findings: Finding[];
        error?: string;
      } | null = !lhRuns
        ? null
        : lhOk.length === 0
          ? lhRuns[0]!.data
          : (() => {
              const scores: Record<string, number> = {};
              for (const { data } of lhOk) {
                for (const [k, v] of Object.entries(data.scores)) {
                  scores[k] = k in scores ? Math.min(scores[k]!, v) : v;
                }
              }
              const merged = new Map<string, Finding & { _ff: FormFactor[] }>();
              for (const { ff, data } of lhOk) {
                for (const f of data.findings) {
                  const key = String(f.evidence["audit_id"]);
                  const hit = merged.get(key);
                  if (hit) hit._ff.push(ff);
                  else merged.set(key, { ...f, _ff: [ff] });
                }
              }
              const findings = Array.from(merged.values()).map(({ _ff, ...f }) => ({
                ...f,
                evidence:
                  factors.length > 1
                    ? { ...f.evidence, affects_form_factors: _ff, form_factor_specific: _ff.length === 1 }
                    : f.evidence,
              }));
              return { scores, ttfb_ms: lhOk[0]!.data.ttfb_ms, findings };
            })();

      // Surface tool errors but don't abort — partial reports are still useful.
      const errors: string[] = [];
      if (lhData?.error) errors.push(lhData.error);
      if (a11yData?.error) errors.push(a11yData.error);
      if (staticData?.warnings) errors.push(...staticData.warnings);

      const reports: ToolReports = {
        lighthouse: lhData && !lhData.error
          ? { scores: lhData.scores, ttfb_ms: lhData.ttfb_ms, findings: lhData.findings }
          : null,
        a11y: a11yData && !a11yData.error
          ? { violation_count: a11yData.violation_count, findings: a11yData.findings }
          : null,
        static: staticData
          ? { issue_count: staticData.issue_count, findings: staticData.findings }
          : null,
      };

      const { correlated_findings, unique_findings, correlations_count } =
        correlate(reports);

      // Corroborated findings get a first-class section with an explicit
      // confidence marker. Within the same priority, they sort before
      // single-tool findings so top_issues naturally surfaces them first.
      const corroboratedFindings = correlated_findings
        .map((f) => ({ ...f, confidence: "high" as const }))
        .sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]);

      const allFindings: CorrelatedFinding[] = [
        ...correlated_findings,
        ...unique_findings,
      ].sort((a, b) => {
        const pDiff = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
        if (pDiff !== 0) return pDiff;
        // Corroborated bubbles above single-tool within same priority tier
        return (a.confirmed_by ? 0 : 1) - (b.confirmed_by ? 0 : 1);
      });

      const toolsRan = [
        ...(lhData && !lhData.error ? ["lighthouse"] : []),
        ...(a11yData && !a11yData.error ? ["pa11y"] : []),
        ...(staticData ? ["eslint", "semgrep"] : []),
      ];

      const readiness = buildVerdict(allFindings);
      const subScores = buildSubScores(lhData, a11yData, staticData);
      const composite = compositeScore(subScores);
      const scorecard = buildScorecard(lhData, a11yData, staticData);
      const summary = buildSummary(allFindings, toolsRan, readiness, correlations_count);

      const report: Record<string, unknown> = {
        release_readiness: readiness,
        composite_score: composite,
        // Per-tool 0–100 health, so a low composite is attributable rather than
        // just low. Null means the tool did not run or did not produce a score.
        sub_scores: subScores,
        scorecard,
        ...(staticData ? { eslint_config_used: staticData.eslint_config_used } : {}),
        summary,
        corroborated_findings: corroboratedFindings,
        top_issues: allFindings.slice(0, 3),
        all_findings: allFindings,
        correlations_found: correlations_count,
      };
      if (errors.length > 0) report["errors"] = errors;

      // Generate a self-contained HTML report the user can open in a browser.
      try {
        const reportPath = await generateHtmlReport({
          url,
          path: targetPath,
          release_readiness: readiness,
          composite_score: composite ?? 0,
          scorecard,
          summary,
          corroborated_findings: corroboratedFindings as unknown as Array<Record<string, unknown>>,
          all_findings: allFindings as unknown as Array<Record<string, unknown>>,
          correlations_found: correlations_count,
          errors: errors.length > 0 ? errors : undefined,
          generated_at: new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC",
        });
        report["report_file"] = `file://${reportPath}`;
      } catch {
        // Non-fatal — JSON report is still returned if HTML generation fails.
      }

      return {
        content: [{ type: "text", text: JSON.stringify(report, null, 2) }],
      };
    },
  );
}
