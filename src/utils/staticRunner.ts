import { runShell, type ShellResult } from "./shellRunner.js";
import { parseSemgrepJSON } from "./outputParsers.js";
import { runESLint } from "./eslintRunner.js";
import { isNotInstalled, needsNetwork, notInstalled } from "./unavailable.js";
import {
  formatStaticAnalysisFinding,
  type StaticAnalysisIssue,
} from "../mappers/defectFormatter.js";
import { fileFindingId, withIds } from "../mappers/findingId.js";
import type { Finding, Priority, UnavailableTool } from "../types.js";

/**
 * ESLint + Semgrep over one directory. Shared by run_static_analysis and
 * run_qa_gate, which each used to carry their own copy of this and had
 * drifted — the gate ignored Semgrep's exit code 2, the standalone tool did
 * not.
 */

export type StaticLanguage = "js" | "ts" | "python";

const PRIORITY_ORDER: Record<Priority, number> = { P1: 0, P2: 1, P3: 2 };

/**
 * Registry rulesets by language. Unset keeps the historical default
 * (JavaScript + TypeScript). Python has no ESLint equivalent here, so it runs
 * Semgrep alone.
 */
const LANGUAGE_RULESETS: Record<StaticLanguage, string[]> = {
  js: ["p/javascript"],
  ts: ["p/javascript", "p/typescript"],
  python: ["p/python"],
};
const DEFAULT_RULESETS = LANGUAGE_RULESETS.ts;

export function semgrepRulesets(
  ruleset: string | string[] | undefined,
  language: StaticLanguage | undefined,
): string[] {
  const explicit = (Array.isArray(ruleset) ? ruleset : ruleset ? [ruleset] : [])
    .flatMap((r) => r.split(","))
    .map((r) => r.trim())
    .filter(Boolean);
  if (explicit.length > 0) return explicit;
  return language ? LANGUAGE_RULESETS[language] : DEFAULT_RULESETS;
}

/**
 * Registry configs are downloaded from semgrep.dev at scan time. A local file
 * path or directory is not.
 */
function usesRegistry(rulesets: string[]): boolean {
  return rulesets.some(
    (r) => /^(p|r|s)\//.test(r) || r === "auto" || /^https?:\/\//.test(r),
  );
}

const NETWORK_MARKERS = [
  "failed to download",
  "unable to download",
  "could not download",
  "connectionerror",
  "connection error",
  "max retries exceeded",
  "name resolution",
  "nodename nor servname",
  "getaddrinfo",
  "network is unreachable",
  "temporary failure in name resolution",
  "failed to establish a new connection",
  "could not resolve host",
  "certificate verify failed",
];

/** Semgrep puts config errors in stderr and, with --json, in stdout's errors[]. */
export function isSemgrepNetworkFailure(result: ShellResult, rulesets: string[]): boolean {
  if (!usesRegistry(rulesets)) return false;
  const haystack = `${result.stderr}\n${result.stdout}`.toLowerCase();
  return NETWORK_MARKERS.some((m) => haystack.includes(m));
}

/**
 * Semgrep can exit 0 with a well-formed JSON body whose results are empty
 * because its config never loaded — reading that as "clean" is the failure
 * this guards against.
 */
function semgrepConfigErrors(stdout: string): string[] {
  try {
    const parsed = JSON.parse(stdout) as { errors?: Array<{ message?: string; level?: string }> };
    return (parsed.errors ?? [])
      .filter((e) => (e.level ?? "error") === "error")
      .map((e) => e.message ?? "")
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Raw ESLint/Semgrep issues → deduplicated, id-stamped, sorted findings.
 * Same file:line from two tools → one finding, keeping the higher priority.
 */
export function buildStaticFindings(issues: StaticAnalysisIssue[], absPath: string): Finding[] {
  const dedup = new Map<string, Finding>();
  for (const issue of issues) {
    const f = formatStaticAnalysisFinding(issue);
    if (!f) continue;
    const key = `${String(f.evidence["file"])}:${String(f.evidence["line"])}`;
    const existing = dedup.get(key);
    if (!existing || PRIORITY_ORDER[f.priority] < PRIORITY_ORDER[existing.priority]) {
      dedup.set(key, f);
    }
  }

  return withIds([...dedup.values()], (f) => fileFindingId(f, absPath)).sort(
    (a, b) =>
      PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] ||
      String(a.evidence["file"]).localeCompare(String(b.evidence["file"])) ||
      Number(a.evidence["line"]) - Number(b.evidence["line"]),
  );
}

export interface StaticRun {
  findings: Finding[];
  tools_run: string[];
  eslint_config_used: string;
  eslint_packages: string[];
  warnings: string[];
  unavailable: UnavailableTool[];
  rulesets: string[];
}

export async function runStaticAnalysis(
  absPath: string,
  options: { ruleset?: string | string[]; language?: StaticLanguage } = {},
): Promise<StaticRun> {
  const rulesets = semgrepRulesets(options.ruleset, options.language);
  const semgrepArgs = [
    ...rulesets.map((r) => `--config=${r}`),
    "--json", "--exclude", "node_modules", ".",
  ];
  const skipEslint = options.language === "python";

  const [eslintRun, semgrepResult] = await Promise.all([
    skipEslint ? null : runESLint(absPath),
    runShell("semgrep", semgrepArgs, { timeoutMs: 180_000, cwd: absPath }),
  ]);

  const toolsRun: string[] = [];
  const warnings: string[] = [...(eslintRun?.warnings ?? [])];
  const unavailable: UnavailableTool[] = [];
  const issues: StaticAnalysisIssue[] = [...(eslintRun?.issues ?? [])];

  if (eslintRun?.ran) toolsRun.push("eslint");
  if (eslintRun?.notInstalled) unavailable.push(notInstalled("eslint"));

  if (isNotInstalled(semgrepResult)) {
    unavailable.push(notInstalled("semgrep"));
    warnings.push("Semgrep is not installed or not found in PATH — Semgrep analysis skipped.");
  } else if (isSemgrepNetworkFailure(semgrepResult, rulesets)) {
    unavailable.push(
      needsNetwork(
        "semgrep",
        "semgrep",
        `Semgrep downloads registry rulesets (${rulesets.join(", ")}) from semgrep.dev at scan time and could not reach it. ` +
          "Re-run with network access, or pass `ruleset` as a local rules file or directory.",
      ),
    );
    warnings.push(
      `Semgrep could not download its rulesets (${rulesets.join(", ")}) — no network access to semgrep.dev. Semgrep analysis skipped.`,
    );
  } else if (semgrepResult.exitCode === 2 && !semgrepResult.stdout) {
    warnings.push(`Semgrep error: ${semgrepResult.stderr.slice(0, 500)}`);
  } else if (semgrepResult.stdout) {
    try {
      for (const f of parseSemgrepJSON(semgrepResult.stdout).findings) {
        issues.push({
          source: "semgrep",
          file: f.filePath,
          line: f.line,
          ruleId: f.ruleId,
          message: f.message,
          severity: f.severity,
          category: f.category,
        });
      }
      const configErrors = semgrepConfigErrors(semgrepResult.stdout);
      if (configErrors.length > 0) {
        warnings.push(`Semgrep reported errors: ${configErrors.join("; ").slice(0, 500)}`);
      }
      toolsRun.push("semgrep");
    } catch {
      warnings.push("Failed to parse Semgrep JSON output.");
    }
  } else {
    toolsRun.push("semgrep");
  }

  const findings = buildStaticFindings(issues, absPath);

  return {
    findings,
    tools_run: toolsRun,
    eslint_config_used: eslintRun ? eslintRun.config_used : "skipped (language: python)",
    eslint_packages: eslintRun?.packages ?? [],
    warnings,
    unavailable,
    rulesets,
  };
}
