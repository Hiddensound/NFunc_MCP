import { z } from "zod";
import { fileURLToPath } from "url";
import { resolve } from "path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runShell } from "../utils/shellRunner.js";
import { parseESLintJSON, parseSemgrepJSON } from "../utils/outputParsers.js";
import { detectESLintConfig } from "../utils/eslintConfigDetector.js";
import {
  formatStaticAnalysisFinding,
  type StaticAnalysisIssue,
} from "../mappers/defectFormatter.js";
import type { Finding } from "../types.js";
import type { Priority } from "../mappers/priorityMapper.js";

const BASELINE_CONFIG_PATH = fileURLToPath(
  new URL("../config/qa-mcp-baseline.eslint.config.js", import.meta.url),
);

const PRIORITY_ORDER: Record<Priority, number> = { P1: 0, P2: 1, P3: 2 };

function higherPriority(a: Finding, b: Finding): Finding {
  return PRIORITY_ORDER[a.priority] <= PRIORITY_ORDER[b.priority] ? a : b;
}

function isNotInstalled(stderr: string, stdout: string, exitCode: number): boolean {
  if (exitCode !== -1) return false;
  // When execa fails with ENOENT (command not found), the process never starts
  // so stderr is an empty string — we can't rely on string-matching alone.
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

      // --- Decide ESLint config strategy ---
      const { hasConfig } = detectESLintConfig(absPath);
      const eslintConfigUsed = hasConfig ? "project" : "qa-mcp-baseline";

      // ESLint flat config resolves `files` globs relative to cwd, not the
      // config file location. Always lint "." and run from absPath so that
      // "**/*.js" correctly matches files inside the target directory.
      const eslintArgs = [".", "--format", "json"];
      if (!hasConfig) {
        eslintArgs.push("--config", BASELINE_CONFIG_PATH);
      }
      eslintArgs.push("--ignore-pattern", "node_modules", "--ignore-pattern", "dist");

      // --- Semgrep args ---
      const semgrepRulesets = ruleset
        ? [`--config=${ruleset}`]
        : ["--config=p/javascript", "--config=p/typescript"];

      const semgrepArgs = [
        ...semgrepRulesets,
        "--json",
        "--exclude",
        "node_modules",
        ".",
      ];

      // Run both tools in parallel, rooted at the target directory.
      const [eslintResult, semgrepResult] = await Promise.all([
        runShell("eslint", eslintArgs, { timeoutMs: 120_000, cwd: absPath }),
        runShell("semgrep", semgrepArgs, { timeoutMs: 180_000, cwd: absPath }),
      ]);

      const toolsRun: string[] = [];
      const warnings: string[] = [];
      const allIssues: StaticAnalysisIssue[] = [];

      // --- ESLint ---
      // Exit 0 = no issues, exit 1 = issues found, exit 2 = config/fatal error.
      // Exit -1 = tool not found or timeout.
      if (isNotInstalled(eslintResult.stderr, eslintResult.stdout, eslintResult.exitCode)) {
        warnings.push(
          "ESLint is not installed or not found in PATH — skipping ESLint analysis.",
        );
      } else if (eslintResult.exitCode === 2) {
        warnings.push(
          `ESLint configuration error: ${eslintResult.stderr.slice(0, 500)}`,
        );
      } else if (eslintResult.stdout) {
        try {
          const parsed = parseESLintJSON(eslintResult.stdout);
          for (const issue of parsed.issues) {
            allIssues.push({
              source: "eslint",
              file: issue.filePath,
              line: issue.line,
              column: issue.column,
              ruleId: issue.ruleId,
              message: issue.message,
              severity: issue.severity,
            });
          }
          toolsRun.push("eslint");
        } catch {
          warnings.push("Failed to parse ESLint JSON output.");
        }
      } else {
        // Exit 0 with no stdout = no files matched (e.g. only TS files with JS-only baseline).
        toolsRun.push("eslint");
      }

      // --- Semgrep ---
      // Exit 0 = no matches, exit 1 = matches found, exit 2 = error.
      if (isNotInstalled(semgrepResult.stderr, semgrepResult.stdout, semgrepResult.exitCode)) {
        warnings.push(
          "Semgrep is not installed or not found in PATH — skipping Semgrep analysis.",
        );
      } else if (semgrepResult.exitCode === 2) {
        warnings.push(
          `Semgrep error: ${semgrepResult.stderr.slice(0, 500)}`,
        );
      } else if (semgrepResult.stdout) {
        try {
          const parsed = parseSemgrepJSON(semgrepResult.stdout);
          for (const finding of parsed.findings) {
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
        eslint_config_used: eslintConfigUsed,
        issue_count: findings.length,
        findings,
      };
      if (warnings.length > 0) report["warnings"] = warnings;

      return {
        content: [{ type: "text", text: JSON.stringify(report, null, 2) }],
      };
    },
  );
}
