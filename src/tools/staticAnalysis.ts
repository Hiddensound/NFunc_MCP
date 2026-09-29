import { z } from "zod";
import { resolve } from "path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runStaticAnalysis } from "../utils/staticRunner.js";
import { diffSummary, tagInDiff } from "../mappers/diffTagger.js";

export const changedFilesInput = z
  .array(z.string())
  .optional()
  .describe(
    "Files changed in the diff under review, relative to `path` (e.g. the output of " +
      "`git diff --name-only main...HEAD`). When given, every file-based finding carries " +
      "`in_diff: true|false` and the report adds `diff_summary` counts. Nothing is filtered out.",
  );

export const rulesetInput = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .describe(
    "Semgrep ruleset(s) — registry ids like 'p/python' or local rule files/directories. " +
      "A string may be comma-separated. Overrides `language`. Default: p/javascript + p/typescript. " +
      "Registry rulesets need network access to semgrep.dev.",
  );

const inputShape = {
  path: z.string().describe("Absolute or relative path to the directory to analyse"),
  ruleset: rulesetInput,
  language: z
    .enum(["js", "ts", "python"])
    .optional()
    .describe(
      "Picks the default Semgrep rulesets when `ruleset` is not given: 'js' → p/javascript, " +
        "'ts' → p/javascript + p/typescript (same as unset), 'python' → p/python and ESLint is skipped.",
    ),
  changed_files: changedFilesInput,
};

export function registerStaticAnalysisTool(server: McpServer): void {
  server.registerTool(
    "run_static_analysis",
    {
      description:
        "Runs ESLint and Semgrep in parallel against a local directory and returns a " +
        "QA-style report with prioritised findings (P1/P2/P3). " +
        "Requires ESLint and Semgrep to be installed on PATH; a missing one is listed in " +
        "`unavailable` with its install command. " +
        "When the target directory has no ESLint config the QA MCP baseline is used as fallback; " +
        "eslint_config_used in the response always states which config was applied. " +
        "Pass changed_files to tag each finding in_diff for pre-merge review.",
      inputSchema: inputShape,
    },
    async ({ path: targetPath, ruleset, language, changed_files }) => {
      const absPath = resolve(targetPath);
      const run = await runStaticAnalysis(absPath, { ruleset, language });
      const findings = tagInDiff(run.findings, changed_files, absPath);

      const report: Record<string, unknown> = {
        path: absPath,
        tools_run: run.tools_run,
        eslint_config_used: run.eslint_config_used,
        semgrep_rulesets: run.rulesets,
        issue_count: findings.length,
        ...(changed_files ? { diff_summary: diffSummary(findings) } : {}),
        findings,
      };
      if (run.eslint_packages.length > 0) report["eslint_packages"] = run.eslint_packages;
      if (run.unavailable.length > 0) report["unavailable"] = run.unavailable;
      if (run.warnings.length > 0) report["warnings"] = run.warnings;

      return {
        content: [{ type: "text", text: JSON.stringify(report, null, 2) }],
      };
    },
  );
}
