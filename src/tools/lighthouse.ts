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

export type FormFactor = "mobile" | "desktop";

/**
 * Lighthouse defaults to mobile: a 412x823 screen, a mid-range Android UA,
 * simulated slow 4G and a 4x CPU slowdown. Desktop needs --preset=desktop,
 * which also drops throttling to 1x.
 *
 * These are not interchangeable runs. On a real commerce page the desktop
 * pass scored accessibility 73 against mobile's 87 and surfaced image-alt,
 * aria-required-children, aria-required-parent, aria-allowed-attr and
 * aria-valid-attr-value failures that the mobile pass never reported, because
 * the two render different DOM. Mobile likewise found failures desktop did
 * not. Neither substitutes for the other.
 */
export function formFactorArgs(ff: FormFactor): string[] {
  return ff === "desktop" ? ["--preset=desktop"] : ["--form-factor=mobile"];
}

const inputShape = {
  url: z.string().url(),
  categories: z.array(z.string()).optional(),
  thresholds: z.record(z.string(), z.number()).optional(),
  form_factor: z
    .enum(["mobile", "desktop", "both"])
    .optional()
    .describe(
      "Device profile to emulate. 'desktop' (default) runs unthrottled. " +
        "'mobile' applies the Lighthouse CLI's own default profile — a " +
        "412x823 screen on simulated slow 4G with a 4x CPU slowdown — which " +
        "is considerably harsher and will report much lower performance " +
        "scores for the same page. 'both' runs the two concurrently and " +
        "reports each separately, tagging every finding with the form " +
        "factors it affects; use it when you want to know which defects are " +
        "device-specific, since the two profiles render different DOM and " +
        "genuinely find different accessibility and SEO problems.",
    ),
};

export function registerLighthouseTool(server: McpServer) {
  server.registerTool(
    "run_lighthouse",
    {
      description:
        "Runs Google Lighthouse against a URL and returns a QA-style report " +
        "with category scores, TTFB, and prioritised findings (P1/P2/P3). " +
        "\n\n" +
        "`form_factor` selects the device profile: 'mobile' (default, " +
        "throttled slow 4G with 4x CPU slowdown), 'desktop' (unthrottled), or " +
        "'both'. **Prefer 'both' when auditing a page properly** — the two " +
        "profiles render different DOM and find different defects, not just " +
        "different performance numbers. With 'both', `scores` is keyed by " +
        "form factor and each finding carries affects_form_factors plus " +
        "form_factor_specific, so device-only regressions are obvious. " +
        "\n\n" +
        "Requires the Lighthouse CLI on PATH (`npm install -g lighthouse`) " +
        "and a Chrome/Chromium binary available.",
      inputSchema: inputShape,
    },
    async ({ url, categories, thresholds, form_factor }) => {
      const requested = form_factor ?? "desktop";
      const factors: FormFactor[] =
        requested === "both" ? ["mobile", "desktop"] : [requested];

      const runOne = async (ff: FormFactor) => {
        const args = [
          url,
          "--output=json",
          "--quiet",
          "--chrome-flags=--headless",
          ...formFactorArgs(ff),
        ];
        if (categories && categories.length > 0) {
          args.push(`--only-categories=${categories.join(",")}`);
        }
        return { ff, result: await runShell("lighthouse", args, { timeoutMs: 180_000 }) };
      };

      // Concurrent, so "both" costs little more wall time than a single run.
      const runs = await Promise.all(factors.map(runOne));

      const parsedByFactor = new Map<FormFactor, ReturnType<typeof parseLighthouseJSON>>();
      for (const { ff, result } of runs) {
        if (!result.stdout) {
          if (factors.length === 1) {
            return shellErrorResponse("Lighthouse produced no JSON output", result);
          }
          continue; // one form factor failed; report the other
        }
        try {
          parsedByFactor.set(ff, parseLighthouseJSON(result.stdout));
        } catch (err) {
          if (factors.length === 1) {
            return parseErrorResponse("Failed to parse Lighthouse JSON", err, result);
          }
        }
      }
      if (parsedByFactor.size === 0) {
        return shellErrorResponse(
          "Lighthouse produced no usable output for any form factor",
          runs[0]!.result,
        );
      }

      const buildFindings = (parsed: ReturnType<typeof parseLighthouseJSON>) => {
        const out: Finding[] = [];
        for (const audit of parsed.failedAudits) {
          const threshold = thresholds?.[audit.id];
          if (typeof threshold === "number" && audit.score >= threshold) continue;
          const f = formatLighthouseFinding(audit);
          if (f) out.push(f);
        }
        return out;
      };

      // Single form factor keeps the original flat report shape.
      if (parsedByFactor.size === 1 && factors.length === 1) {
        const parsed = parsedByFactor.get(factors[0]!)!;
        const findings = buildFindings(parsed);
        sortFindingsByPriority(findings);
        return {
          content: [{ type: "text", text: JSON.stringify({
            url,
            form_factor: factors[0],
            scores: parsed.categoryScores,
            ttfb_ms: parsed.ttfbMs,
            findings,
          }, null, 2) }],
        };
      }

      // Both: merge on audit_id and record which form factors each affects, so
      // "fails on desktop only" is readable straight off the finding.
      const merged = new Map<string, Finding & { _ff: FormFactor[] }>();
      const scores: Record<string, Record<string, number>> = {};
      const ttfb: Record<string, number | null> = {};

      for (const ff of factors) {
        const parsed = parsedByFactor.get(ff);
        if (!parsed) continue;
        scores[ff] = parsed.categoryScores;
        ttfb[ff] = parsed.ttfbMs;
        for (const f of buildFindings(parsed)) {
          const key = String(f.evidence["audit_id"]);
          const existing = merged.get(key);
          if (existing) existing._ff.push(ff);
          else merged.set(key, { ...f, _ff: [ff] });
        }
      }

      const findings = Array.from(merged.values()).map(({ _ff, ...f }) => ({
        ...f,
        evidence: {
          ...f.evidence,
          affects_form_factors: _ff,
          form_factor_specific: _ff.length === 1,
        },
      }));
      sortFindingsByPriority(findings);

      return {
        content: [{ type: "text", text: JSON.stringify({
          url,
          form_factor: "both",
          form_factors_run: Array.from(parsedByFactor.keys()),
          scores,
          ttfb_ms: ttfb,
          findings,
        }, null, 2) }],
      };
    },
  );
}
