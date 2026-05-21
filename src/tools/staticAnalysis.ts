import { z } from "zod";
import { resolve } from "path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runShell } from "../utils/shellRunner.js";
import { parseSemgrepJSON } from "../utils/outputParsers.js";
import { runESLint } from "../utils/eslintRunner.js";
import {
  formatStaticAnalysisFinding,
  type StaticAnalysisIssue,
} from "../mappers/defectFormatter.js";
import type { Finding } from "../types.js";
import type { Priority } from "../mappers/priorityMapper.js";

const PRIORITY_ORDER: Record<Priority, number> = { P1: 0, P2: 1, P3: 2 };

function higherPriority(a: Finding, b: Finding): Finding {
  return PRIORITY_ORDER[a.priority] <= PRIORITY_ORDER[b.priority] ? a : b;
}

function isSemgrepNotInstalled(stderr: string, stdout: string, exitCode: number): boolean {
  if (exitCode !== -1) return false;
  if (!stderr && !stdout) return true;
  return (
    stderr.includes("ENOENT") ||
    stderr.includes("not found") ||
    stderr.includes("command not found") ||
    stderr.includes("No such file")
  );
}

const inputShape = {
  path: z.string().describe("Absolute or relative path to the directory to analyse"),
  ruleset: z
    .string()
    .optional()
    .describe("Semgrep ruleset override (default: p/javascript + p/typescript)"),
  language: z.enum(["js", "ts", "python"]).optional().describe("Language hint"),
};

export function registerStaticAnalysisTool(server: McpServer): void {
  server.registerTool(
    "run_static_analysis",
    {
      description:
        "Runs ESLint and Semgrep in parallel against a local directory and returns a " +
        "QA-style report with prioritised findings (P1/P2/P3). " +
        "Requires ESLint and Semgrep to be installed on PATH. " +
        "When the target directory has no ESLint config the QA MCP baseline is used as fallback; " +
        "eslint_config_used in the response always states which config was applied.",
      inputSchema: inputShape,
    },
    async ({ path: targetPath, ruleset }) => {
      const absPath = resolve(targetPath);

      // --- Semgrep args ---
      const semgrepRulesets = ruleset
        ? [`--config=${ruleset}`]
        : ["--config=p/javascript", "--config=p/typescript"];
      const semgrepArgs = [...semgrepRulesets, "--json", "--exclude", "node_modules", "."];

      // Run ESLint (per-package aware) and Semgrep in parallel.
      const [eslintRun, semgrepResult] = await Promise.all([
        runESLint(absPath),
        runShell("semgrep", semgrepArgs, { timeoutMs: 180_000, cwd: absPath }),
      ]);

      const toolsRun: string[] = [];
      const warnings: string[] = [...eslintRun.warnings];
      const allIssues: StaticAnalysisIssue[] = [...eslintRun.issues];

      if (eslintRun.ran) toolsRun.push("eslint");

      // --- Semgrep ---
      if (isSemgrepNotInstalled(semgrepResult.stderr, semgrepResult.stdout, semgrepResult.exitCode)) {
        warnings.push("Semgrep is not installed or not found in PATH — skipping Semgrep analysis.");
      } else if (semgrepResult.exitCode === 2) {
        warnings.push(`Semgrep error: ${semgrepResult.stderr.slice(0, 500)}`);
      } else if (semgrepResult.stdout) {
        try {
          for (const finding of parseSemgrepJSON(semgrepResult.stdout).findings) {
            allIssues.push({
              source: "semgrep",
              file: finding.filePath,
              line: finding.line,
              ruleId: finding.ruleId,
              message: finding.message,
              severity: finding.severity,
              category: finding.category,
            });
          }
          toolsRun.push("semgrep");
        } catch {
          warnings.push("Failed to parse Semgrep JSON output.");
        }
      } else {
        toolsRun.push("semgrep");
      }

      // --- Format findings ---
      const formatted: Finding[] = [];
      for (const issue of allIssues) {
        const finding = formatStaticAnalysisFinding(issue);
        if (finding) formatted.push(finding);
      }

      // --- Deduplicate: same file:line → keep highest priority ---
      const dedupMap = new Map<string, Finding>();
      for (const f of formatted) {
        const key = `${String(f.evidence["file"])}:${String(f.evidence["line"])}`;
        const existing = dedupMap.get(key);
        dedupMap.set(key, existing ? higherPriority(existing, f) : f);
      }

      // --- Sort: priority first, then file path ---
      const findings = Array.from(dedupMap.values()).sort((a, b) => {
        const pDiff = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
        if (pDiff !== 0) return pDiff;
        return String(a.evidence["file"]).localeCompare(String(b.evidence["file"]));
      });

      const report: Record<string, unknown> = {
        path: absPath,
        tools_run: toolsRun,
        eslint_config_used: eslintRun.config_used,
        issue_count: findings.length,
        findings,
      };
      if (eslintRun.packages.length > 0) report["eslint_packages"] = eslintRun.packages;
      if (warnings.length > 0) report["warnings"] = warnings;

      return {
        content: [{ type: "text", text: JSON.stringify(report, null, 2) }],
      };
    },
  );
}
