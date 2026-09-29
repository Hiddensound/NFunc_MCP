import { z } from "zod";
import { resolve } from "path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runShell } from "../utils/shellRunner.js";
import { parseLighthouseJSON, parsePa11yJSON } from "../utils/outputParsers.js";
import { formatLighthouseFinding, formatA11yFinding } from "../mappers/defectFormatter.js";
import { dedupeA11yFindings } from "../mappers/a11yDedupe.js";
import {
  lighthouseSubScore,
  a11ySubScore,
  staticSubScore,
  compositeScore,
  type SubScores,
} from "../mappers/compositeScore.js";
import { formFactorArgs } from "./lighthouse.js";
import { mobileConfig } from "./accessibility.js";
import { changedFilesInput, rulesetInput } from "./staticAnalysis.js";
import { runStaticAnalysis, type StaticRun } from "../utils/staticRunner.js";
import { isNotInstalled, notInstalled } from "../utils/unavailable.js";
import {
  correlate,
  type ToolReports,
  type CorrelatedFinding,
} from "../mappers/correlator.js";
import {
  a11yFindingId,
  a11yLocation,
  lighthouseFindingId,
  withIds,
} from "../mappers/findingId.js";
import {
  effectivePrimary,
  mergeByFormFactor,
  type FormFactor,
} from "../mappers/formFactorMerge.js";
import { buildVerdict, type ReleaseReadiness } from "../mappers/releaseVerdict.js";
import { diffSummary, tagInDiff } from "../mappers/diffTagger.js";
import type { Finding, Priority, UnavailableTool } from "../types.js";
import { generateHtmlReport } from "../utils/reportGenerator.js";

const PRIORITY_ORDER: Record<Priority, number> = { P1: 0, P2: 1, P3: 2 };

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
// doesn't prevent the others from contributing findings.
// ---------------------------------------------------------------------------

interface LighthouseRun {
  scores: Record<string, number>;
  ttfb_ms: number | null;
  findings: Finding[];
  error?: string;
  notInstalled?: boolean;
}

async function runLighthouse(url: string, formFactor: FormFactor): Promise<LighthouseRun> {
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
  if (isNotInstalled(result)) {
    return {
      scores: {}, ttfb_ms: null, findings: [], notInstalled: true,
      error: "Lighthouse is not installed or not found in PATH.",
    };
  }
  if (!result.stdout) {
    return { scores: {}, ttfb_ms: null, findings: [], error: `Lighthouse (${formFactor}) failed (exit ${result.exitCode}): ${result.stderr.slice(0, 300)}` };
  }
  try {
    const parsed = parseLighthouseJSON(result.stdout);
    const findings: Finding[] = [];
    for (const audit of parsed.failedAudits) {
      const f = formatLighthouseFinding(audit);
      if (f) findings.push(f);
    }
    return {
      scores: parsed.categoryScores,
      ttfb_ms: parsed.ttfbMs,
      findings: withIds(findings, (f) => lighthouseFindingId(f, url)),
    };
  } catch (err) {
    return {
      scores: {}, ttfb_ms: null, findings: [],
      error: `Lighthouse (${formFactor}) output could not be parsed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

interface A11yRun {
  violation_count: number;
  raw_violation_count?: number;
  findings: Finding[];
  error?: string;
  notInstalled?: boolean;
}

async function runA11y(
  url: string,
  engines: Array<"htmlcs" | "axe">,
  formFactor: FormFactor,
): Promise<A11yRun> {
  // Same viewport run_accessibility_check uses, so the gate and the standalone
  // tool describe the same rendered layout. Desktop passes no config, which
  // leaves pa11y's own desktop-shaped default in place.
  const configArgs = formFactor === "mobile" ? ["--config", await mobileConfig()] : [];
  const results = await Promise.all(
    engines.map((e) =>
      runShell(
        "pa11y",
        [url, "--reporter", "json", "--standard", "WCAG2AA", "--runner", e, ...configArgs],
        { timeoutMs: 120_000 },
      ),
    ),
  );

  if (results.every(isNotInstalled)) {
    return { violation_count: 0, findings: [], notInstalled: true, error: "pa11y is not installed or not found in PATH." };
  }
  // pa11y exits 2 when violations are found — that is a successful run.
  const usable = results.filter(
    (r) => (r.exitCode === 0 || r.exitCode === 2) && r.stdout,
  );
  if (usable.length === 0) {
    const r = results[0]!;
    return { violation_count: 0, findings: [], error: `pa11y (${formFactor}) failed (exit ${r.exitCode}): ${r.stderr.slice(0, 300)}` };
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
    return {
      violation_count: findings.length,
      raw_violation_count: rawCount,
      findings: withIds(findings, (f) => a11yFindingId(f, url)),
    };
  } catch (err) {
    return {
      violation_count: 0, findings: [],
      error: `pa11y (${formFactor}) output could not be parsed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Form-factor collapse
// ---------------------------------------------------------------------------

interface LighthouseView {
  scores: Record<string, number>;
  scores_by_form_factor: Partial<Record<FormFactor, Record<string, number>>>;
  ttfb_ms: number | null;
  findings: Finding[];
  primary: FormFactor | null;
  error?: string;
}

/**
 * Headline scores are the primary profile's, not the worst of the two. The
 * worst-of rule mixed profiles category by category — desktop's performance
 * beside mobile's accessibility — into a set of numbers no single run ever
 * produced.
 */
export function collapseLighthouse(
  runs: Array<{ ff: FormFactor; data: LighthouseRun }>,
  requestedPrimary: FormFactor,
): LighthouseView {
  const ok = runs.filter((r) => !r.data.error);
  if (ok.length === 0) {
    return {
      scores: {}, scores_by_form_factor: {}, ttfb_ms: null, findings: [], primary: null,
      error: runs[0]?.data.error ?? "Lighthouse did not run.",
    };
  }
  const primary = effectivePrimary(requestedPrimary, ok.map((r) => r.ff))!;
  const primaryRun = ok.find((r) => r.ff === primary)!.data;
  const scoresBy: LighthouseView["scores_by_form_factor"] = {};
  for (const { ff, data } of ok) scoresBy[ff] = data.scores;

  return {
    scores: primaryRun.scores,
    scores_by_form_factor: scoresBy,
    ttfb_ms: primaryRun.ttfb_ms,
    findings: mergeByFormFactor(
      ok.map(({ ff, data }) => ({ ff, findings: data.findings })),
      (f) => String(f.evidence["audit_id"]),
      requestedPrimary,
      { legacyEvidence: true },
    ),
    primary,
  };
}

interface A11yView {
  violation_count: number;
  raw_violation_count?: number;
  findings: Finding[];
  /** The primary profile's own findings, for the pa11y sub-score. */
  primary_findings: Finding[];
  primary: FormFactor | null;
  error?: string;
}

export function collapseA11y(
  runs: Array<{ ff: FormFactor; data: A11yRun }>,
  requestedPrimary: FormFactor,
): A11yView {
  const ok = runs.filter((r) => !r.data.error);
  if (ok.length === 0) {
    return {
      violation_count: 0, findings: [], primary_findings: [], primary: null,
      error: runs[0]?.data.error ?? "pa11y did not run.",
    };
  }
  const primary = effectivePrimary(requestedPrimary, ok.map((r) => r.ff))!;
  const findings = mergeByFormFactor(
    ok.map(({ ff, data }) => ({ ff, findings: data.findings })),
    (f) => `${String(f.evidence["rule_code"] ?? "")}|${a11yLocation(f)}`,
    requestedPrimary,
  );
  const raw = ok.reduce((n, r) => n + (r.data.raw_violation_count ?? r.data.violation_count), 0);
  return {
    violation_count: findings.length,
    raw_violation_count: raw,
    findings,
    primary_findings: ok.find((r) => r.ff === primary)!.data.findings,
    primary,
  };
}

// ---------------------------------------------------------------------------
// Report assembly helpers
// ---------------------------------------------------------------------------

// Composite score. See src/mappers/compositeScore.ts for why this is a
// weighted mean of per-tool sub-scores rather than one global subtraction.
function buildSubScores(
  lhData: LighthouseView | null,
  a11yData: A11yView | null,
  staticData: { findings: Finding[]; tools_run: string[] } | null,
): SubScores {
  return {
    lighthouse:
      lhData && !lhData.error ? lighthouseSubScore(lhData.scores) : null,
    pa11y: a11yData && !a11yData.error ? a11ySubScore(a11yData.primary_findings) : null,
    // Nothing ran is not the same as nothing found: no score rather than 100.
    static: staticData && staticData.tools_run.length > 0 ? staticSubScore(staticData.findings) : null,
  };
}

// Compact per-tool scorecard.
// Any argument may be null when the caller did not supply the corresponding
// input (url or path) — those tools show SKIPPED rather than UNAVAILABLE.
// UNAVAILABLE is reserved for tools that were attempted but failed or are not installed.
function buildScorecard(
  lhData: LighthouseView | null,
  a11yData: A11yView | null,
  staticData: { findings: Finding[]; tools_run: string[] } | null,
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
  } else if (staticData.tools_run.length === 0) {
    entries.push({ tool: "ESLint / Semgrep", gate: "UNAVAILABLE" });
  } else {
    const staticP1 = staticData.findings.some((f) => f.priority === "P1");
    const staticP2 = staticData.findings.some((f) => f.priority === "P2");
    entries.push({
      tool: "ESLint / Semgrep",
      gate: staticP1 ? "FAIL" : staticP2 ? "WARN" : "PASS",
      issues: staticData.findings.length,
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

function uniqueUnavailable(list: UnavailableTool[]): UnavailableTool[] {
  const seen = new Set<string>();
  return list.filter((u) => {
    const key = `${u.tool}|${u.reason}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
      "'marketing site'). Echoed into the report and the HTML header so a saved report " +
      "says what was being checked; it does not change any check or priority.",
    ),
  form_factor: z
    .enum(["mobile", "desktop", "both"])
    .optional()
    .describe(
      "Device profile for Lighthouse and pa11y: 'desktop' (default, unthrottled), 'mobile' " +
      "(throttled slow 4G with a 4x CPU slowdown for Lighthouse, a 412x823 touch viewport " +
      "for pa11y), or 'both'. The profiles render different DOM and find " +
      "different accessibility and SEO defects, so 'both' is the thorough " +
      "choice; it runs concurrently and costs little extra wall time.",
    ),
  primary_form_factor: z
    .enum(["desktop", "mobile"])
    .optional()
    .describe(
      "Which profile speaks for the page when form_factor is 'both' (default 'desktop'). " +
      "Headline scores and sub_scores come from it, and a finding only the other profile " +
      "reports is demoted one tier (P1→P2, P2→P3). Per-profile priorities stay on each finding.",
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
  changed_files: changedFilesInput,
  ruleset: rulesetInput,
  output_dir: z
    .string()
    .optional()
    .describe(
      "Directory to write the HTML report and a JSON copy of this result into (created if " +
      "missing). Default: HTML only, in the OS temp directory. Paths are returned in report_paths.",
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
        "summary, top 3 issues, and a full prioritised finding list. Every finding has a stable `id`. " +
        "Pass changed_files to tag static findings in_diff. " +
        "If any individual tool is not installed, the report is still produced from the others and " +
        "the missing tool is listed in `unavailable` with its install command — it never fails completely.",
      inputSchema: inputShape,
    },
    async ({
      url, path: targetPath, context, form_factor, primary_form_factor, a11y_runner,
      changed_files, ruleset, output_dir,
    }) => {
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
        requestedFF === "both" ? ["desktop", "mobile"] : [requestedFF];
      const requestedPrimary: FormFactor = primary_form_factor ?? "desktop";
      const requestedRunner = a11y_runner ?? "htmlcs";
      const engines: Array<"htmlcs" | "axe"> =
        requestedRunner === "both" ? ["htmlcs", "axe"] : [requestedRunner];
      const absPath = targetPath ? resolve(targetPath) : undefined;

      // Only run the tools we have inputs for. null means deliberately skipped,
      // not a failure — the scorecard will show SKIPPED for those entries.
      // Every leg — including each form factor — runs concurrently.
      const [lhRuns, a11yRuns, staticRun] = await Promise.all([
        url
          ? Promise.all(factors.map(async (ff) => ({ ff, data: await runLighthouse(url, ff) })))
          : null,
        url
          ? Promise.all(factors.map(async (ff) => ({ ff, data: await runA11y(url, engines, ff) })))
          : null,
        absPath ? runStaticAnalysis(absPath, { ruleset }) : null,
      ]);

      const lhData = lhRuns ? collapseLighthouse(lhRuns, requestedPrimary) : null;
      const a11yData = a11yRuns ? collapseA11y(a11yRuns, requestedPrimary) : null;
      const staticData: (StaticRun & { findings: Finding[] }) | null =
        staticRun && absPath
          ? { ...staticRun, findings: tagInDiff(staticRun.findings, changed_files, absPath) }
          : null;

      // Surface tool errors but don't abort — partial reports are still useful.
      // A profile that failed while the other succeeded is reported too; the
      // collapsed view alone would hide it.
      const errors: string[] = [];
      for (const runs of [lhRuns, a11yRuns]) {
        if (!runs) continue;
        const failed = runs.filter((r) => r.data.error);
        const seen = new Set<string>();
        for (const r of failed) {
          if (seen.has(r.data.error!)) continue;
          seen.add(r.data.error!);
          errors.push(r.data.error!);
        }
      }
      if (staticData?.warnings) errors.push(...staticData.warnings);
      if (factors.length > 1) {
        for (const [name, view] of [["Lighthouse", lhData], ["pa11y", a11yData]] as const) {
          if (view && !view.error && view.primary !== requestedPrimary) {
            errors.push(
              `${name} has no ${requestedPrimary} result, so ${view.primary} was used as its primary profile and nothing was demoted.`,
            );
          }
        }
      }

      const unavailable = uniqueUnavailable([
        ...(lhRuns?.some((r) => r.data.notInstalled) ? [notInstalled("lighthouse")] : []),
        ...(a11yRuns?.some((r) => r.data.notInstalled) ? [notInstalled("pa11y")] : []),
        ...(staticData?.unavailable ?? []),
      ]);

      const reports: ToolReports = {
        lighthouse: lhData && !lhData.error
          ? { scores: lhData.scores, ttfb_ms: lhData.ttfb_ms, findings: lhData.findings }
          : null,
        a11y: a11yData && !a11yData.error
          ? { violation_count: a11yData.violation_count, findings: a11yData.findings }
          : null,
        static: staticData
          ? { issue_count: staticData.findings.length, findings: staticData.findings }
          : null,
      };

      const { correlated_findings, unique_findings, correlations_count } =
        correlate(reports, { url });

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
        ...(staticData?.tools_run ?? []),
      ];

      // Readiness runs over the adjusted priorities: promoted by correlation,
      // demoted when only the non-primary profile reports a finding.
      const readiness = buildVerdict(allFindings);
      const subScores = buildSubScores(lhData, a11yData, staticData);
      const composite = compositeScore(subScores);
      const scorecard = buildScorecard(lhData, a11yData, staticData);
      const summary = buildSummary(allFindings, toolsRan, readiness, correlations_count);

      const report: Record<string, unknown> = {
        release_readiness: readiness,
        composite_score: composite,
        ...(context ? { context } : {}),
        ...(url
          ? {
              form_factor: requestedFF,
              primary_form_factor: requestedPrimary,
            }
          : {}),
        ...(lhData && !lhData.error
          ? { scores: lhData.scores, scores_by_form_factor: lhData.scores_by_form_factor }
          : {}),
        // Per-tool 0–100 health, so a low composite is attributable rather than
        // just low. Null means the tool did not run or did not produce a score.
        sub_scores: subScores,
        scorecard,
        ...(staticData ? { eslint_config_used: staticData.eslint_config_used } : {}),
        summary,
        ...(changed_files ? { diff_summary: diffSummary(allFindings) } : {}),
        corroborated_findings: corroboratedFindings,
        top_issues: allFindings.slice(0, 3),
        all_findings: allFindings,
        correlations_found: correlations_count,
      };
      if (unavailable.length > 0) report["unavailable"] = unavailable;
      if (errors.length > 0) report["errors"] = errors;

      // Generate a self-contained HTML report the user can open in a browser.
      try {
        const paths = await generateHtmlReport(
          {
            url,
            path: targetPath,
            context,
            release_readiness: readiness,
            composite_score: composite ?? 0,
            scorecard,
            summary,
            corroborated_findings: corroboratedFindings as unknown as Array<Record<string, unknown>>,
            all_findings: allFindings as unknown as Array<Record<string, unknown>>,
            correlations_found: correlations_count,
            errors: errors.length > 0 ? errors : undefined,
            generated_at: new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC",
          },
          {
            outputDir: output_dir,
            json: (p) => ({ ...report, report_file: `file://${p.html}`, report_paths: p }),
          },
        );
        report["report_file"] = `file://${paths.html}`;
        report["report_paths"] = paths;
      } catch (err) {
        // Non-fatal — the JSON report is still returned. Said out loud when the
        // caller asked for a specific directory, since they will look there.
        if (output_dir) {
          report["errors"] = [
            ...errors,
            `Could not write the report to ${resolve(output_dir)}: ${err instanceof Error ? err.message : String(err)}`,
          ];
        }
      }

      return {
        content: [{ type: "text", text: JSON.stringify(report, null, 2) }],
      };
    },
  );
}
