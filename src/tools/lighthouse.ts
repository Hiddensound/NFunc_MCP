import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runShell } from "../utils/shellRunner.js";
import { parseLighthouseJSON } from "../utils/outputParsers.js";
import {
  shellErrorResponse,
  parseErrorResponse,
} from "../utils/toolResponse.js";
import { formatLighthouseFinding } from "../mappers/defectFormatter.js";
import { sortFindingsByPriority } from "../mappers/priorityMapper.js";
import type { Finding } from "../types.js";

const inputShape = {
  url: z.string().url(),
  categories: z.array(z.string()).optional(),
  thresholds: z.record(z.string(), z.number()).optional(),
};

export function registerLighthouseTool(server: McpServer) {
  server.registerTool(
    "run_lighthouse",
    {
      description:
        "Runs Google Lighthouse against a URL and returns a QA-style report " +
        "with category scores, TTFB, and prioritised findings (P1/P2/P3). " +
        "Requires the Lighthouse CLI to be installed globally on PATH " +
        "(`npm install -g lighthouse`) and a Chrome/Chromium binary available.",
      inputSchema: inputShape,
    },
    async ({ url, categories, thresholds }) => {
      const args = [
        url,
        "--output=json",
        "--quiet",
        "--chrome-flags=--headless",
      ];
      if (categories && categories.length > 0) {
        args.push(`--only-categories=${categories.join(",")}`);
      }

      const result = await runShell("lighthouse", args, { timeoutMs: 120_000 });

      if (!result.stdout) {
        return shellErrorResponse("Lighthouse produced no JSON output", result);
      }

      let parsed;
      try {
        parsed = parseLighthouseJSON(result.stdout);
      } catch (err) {
        return parseErrorResponse(
          "Failed to parse Lighthouse JSON",
          err,
          result,
        );
      }

      const findings: Finding[] = [];
      for (const audit of parsed.failedAudits) {
        const threshold = thresholds?.[audit.id];
        if (typeof threshold === "number" && audit.score >= threshold) continue;
        const finding = formatLighthouseFinding(audit);
        if (finding) findings.push(finding);
      }
      sortFindingsByPriority(findings);

      const report = {
        url,
        scores: parsed.categoryScores,
        ttfb_ms: parsed.ttfbMs,
        findings,
      };

      return {
        content: [{ type: "text", text: JSON.stringify(report, null, 2) }],
      };
    },
  );
}
