import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runShell } from "../utils/shellRunner.js";
import { parsePa11yJSON } from "../utils/outputParsers.js";
import {
  shellErrorResponse,
  parseErrorResponse,
} from "../utils/toolResponse.js";
import { formatA11yFinding } from "../mappers/defectFormatter.js";
import { sortFindingsByPriority } from "../mappers/priorityMapper.js";
import type { Finding } from "../types.js";

const inputShape = {
  url: z.string().url(),
  standard: z.enum(["WCAG2A", "WCAG2AA", "WCAG2AAA"]).optional(),
  ignore: z.array(z.string()).optional(),
};

export function registerAccessibilityTool(server: McpServer) {
  server.registerTool(
    "run_accessibility_check",
    {
      description:
        "Runs pa11y against a URL and returns a QA-style report with WCAG " +
        "violations mapped to priorities (Level A → P1, AA → P2, AAA → P3; " +
        "notices are filtered out). Requires the pa11y CLI to be installed " +
        "globally on PATH (`npm install -g pa11y`).",
      inputSchema: inputShape,
    },
    async ({ url, standard, ignore }) => {
      const resolvedStandard = standard ?? "WCAG2AA";
      const args = [
        url,
        "--reporter",
        "json",
        "--standard",
        resolvedStandard,
      ];
      if (ignore && ignore.length > 0) {
        args.push("--ignore", ignore.join(";"));
      }

      const result = await runShell("pa11y", args, { timeoutMs: 120_000 });

      // pa11y exits 2 when issues are found — that's a successful run with data.
      // Exit 1 means pa11y itself failed (browser launch, bad URL, etc.).
      const ranSuccessfully = result.exitCode === 0 || result.exitCode === 2;

      if (!ranSuccessfully || !result.stdout) {
        return shellErrorResponse(
          "pa11y did not produce a usable report",
          result,
        );
      }

      let parsed;
      try {
        parsed = parsePa11yJSON(result.stdout);
      } catch (err) {
        return parseErrorResponse("Failed to parse pa11y JSON", err, result);
      }

      const findings: Finding[] = [];
      for (const violation of parsed.violations) {
        const finding = formatA11yFinding(violation);
        if (finding) findings.push(finding);
      }
      sortFindingsByPriority(findings);

      const report = {
        url,
        standard: resolvedStandard,
        violation_count: findings.length,
        findings,
      };

      return {
        content: [{ type: "text", text: JSON.stringify(report, null, 2) }],
      };
    },
  );
}
