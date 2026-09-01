import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runShell } from "../utils/shellRunner.js";
import { parsePa11yJSON } from "../utils/outputParsers.js";
import {
  shellErrorResponse,
  parseErrorResponse,
} from "../utils/toolResponse.js";
import { formatA11yFinding } from "../mappers/defectFormatter.js";
import { dedupeA11yFindings } from "../mappers/a11yDedupe.js";
import { sortFindingsByPriority } from "../mappers/priorityMapper.js";
import type { Finding } from "../types.js";

const inputShape = {
  url: z.string().url(),
  standard: z.enum(["WCAG2A", "WCAG2AA", "WCAG2AAA"]).optional(),
  ignore: z.array(z.string()).optional(),
  runner: z
    .enum(["htmlcs", "axe", "both"])
    .optional()
    .describe(
      "Which accessibility engine to run. 'htmlcs' (default) checks WCAG " +
        "techniques and is strong on document structure, labels, and forms. " +
        "'axe' is Deque's engine and is materially stronger on ARIA — roles, " +
        "required parent/child relationships, prohibited and unsupported " +
        "attributes — and on computed colour contrast, so prefer it when the " +
        "work under test involves ARIA or a component library. 'both' runs " +
        "the two and merges the results, which is the most thorough option " +
        "and roughly doubles runtime.",
    ),
};

export function registerAccessibilityTool(server: McpServer) {
  server.registerTool(
    "run_accessibility_check",
    {
      description:
        "Runs pa11y against a URL and returns a QA-style report of WCAG " +
        "violations prioritised P1/P2/P3 (notices are filtered out). " +
        "\n\n" +
        "Two engines are available via `runner`. htmlcs (default) checks WCAG " +
        "techniques and is strong on document structure, labels, and forms. " +
        "axe is Deque's engine and is materially stronger on ARIA — invalid " +
        "roles, missing required parent/child relationships, prohibited and " +
        "unsupported attributes — and on computed colour contrast. " +
        "**Prefer runner='axe' whenever the work under test involves ARIA, a " +
        "component library, or a design system**, and runner='both' for the " +
        "most thorough sweep. The two engines overlap only partly: on a real " +
        "commerce page htmlcs found unlabelled inputs and duplicate ids that " +
        "axe did not, while axe found aria-allowed-attr, aria-required-parent " +
        "and image-alt failures htmlcs missed entirely. " +
        "\n\n" +
        "Requires the pa11y CLI on PATH (`npm install -g pa11y`).",
      inputSchema: inputShape,
    },
    async ({ url, standard, ignore, runner }) => {
      const resolvedStandard = standard ?? "WCAG2AA";
      const resolvedRunner = runner ?? "htmlcs";
      const engines: Array<"htmlcs" | "axe"> =
        resolvedRunner === "both" ? ["htmlcs", "axe"] : [resolvedRunner];

      const buildArgs = (engine: string) => {
        const args = [url, "--reporter", "json", "--standard", resolvedStandard,
          "--runner", engine];
        if (ignore && ignore.length > 0) args.push("--ignore", ignore.join(";"));
        return args;
      };

      // Engines run concurrently so "both" costs little more wall time than one.
      const results = await Promise.all(
        engines.map((e) => runShell("pa11y", buildArgs(e), { timeoutMs: 120_000 })),
      );

      // pa11y exits 2 when issues are found — that's a successful run with data.
      // Exit 1 means pa11y itself failed (browser launch, bad URL, etc.).
      const usable = results.filter(
        (r) => (r.exitCode === 0 || r.exitCode === 2) && r.stdout,
      );
      if (usable.length === 0) {
        return shellErrorResponse(
          "pa11y did not produce a usable report",
          results[0]!,
        );
      }

      const rawFindings: Finding[] = [];
      for (const result of usable) {
        let parsed;
        try {
          parsed = parsePa11yJSON(result.stdout);
        } catch (err) {
          return parseErrorResponse("Failed to parse pa11y JSON", err, result);
        }
        for (const violation of parsed.violations) {
          const finding = formatA11yFinding(violation);
          if (finding) rawFindings.push(finding);
        }
      }

      // Collapse repeats of the same defect before counting or sorting — see
      // a11yDedupe for why pa11y produces them. Note this dedupes *within* an
      // engine only: the key is (rule_code, selector), and the two engines emit
      // different code shapes for the same defect ("...1_1_1.H37" vs
      // "image-alt"), so an element both engines flag appears twice. That is
      // deliberate for now — two independent engines agreeing is corroboration
      // worth seeing, the same signal the Lighthouse/pa11y correlator promotes.
      const { findings, rawCount } = dedupeA11yFindings(rawFindings);
      sortFindingsByPriority(findings);

      const report = {
        url,
        standard: resolvedStandard,
        runners: engines,
        ...(usable.length < engines.length
          ? { warnings: [`Only ${usable.length} of ${engines.length} runners produced output.`] }
          : {}),
        violation_count: findings.length,
        // Pre-dedup total, so a large drop between the two is explainable
        // rather than looking like dropped findings.
        raw_violation_count: rawCount,
        findings,
      };

      return {
        content: [{ type: "text", text: JSON.stringify(report, null, 2) }],
      };
    },
  );
}
