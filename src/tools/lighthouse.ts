import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runShell, type ShellResult } from "../utils/shellRunner.js";
import { parseLighthouseJSON, type ParsedLighthouse } from "../utils/outputParsers.js";
import { extractLabMetrics } from "../utils/psiParser.js";
import { resolveUrlInputs } from "../utils/urlInput.js";
import { classifyUrls } from "../utils/urlClassifier.js";
import { aggregate, type RunResult } from "../mappers/psiAggregator.js";
import {
  DEFAULT_MAX_SECONDS_PER_CALL,
  decodeCursor,
  encodeCursor,
  elapsedSeconds,
  filterCompleted,
  hasBudget,
  mergeIndex,
  readIndex,
  slugForUrl,
  type BatchRecord,
} from "../utils/batchState.js";
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

/** A single local Lighthouse run, measured. Used to reserve chunk budget. */
const TYPICAL_RUN_MS = 40_000;
const DEFAULT_OUTPUT_DIR = "./lighthouse-reports";

const inputShape = {
  url: z
    .string()
    .min(1)
    .describe(
      "One URL, several comma- or newline-separated URLs, or a path to a CSV " +
        "containing a URL column. More than one URL switches the tool into " +
        "batch mode: results are written to output_dir and a cursor is " +
        "returned to continue with.",
    ),
  urls: z
    .array(z.string())
    .optional()
    .describe("Explicit URL list, as an alternative to packing them into `url`."),
  output_dir: z.string().optional(),
  cursor: z.string().optional().describe("Resume token from a previous batch call."),
  max_seconds_per_call: z.number().int().min(30).max(900).optional(),
  skip_completed: z
    .boolean()
    .optional()
    .describe(
      "Batch mode only. Skip URL/form-factor pairs already in the output " +
        "index (default true), so re-running fills gaps instead of redoing work.",
    ),
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

interface AuditRun {
  factor: FormFactor;
  parsed: ParsedLighthouse;
  raw: string;
}

/** One Lighthouse invocation. Returns the parsed report and the raw LHR. */
async function runLighthouseOnce(
  url: string,
  factor: FormFactor,
  categories: string[] | undefined,
): Promise<{ run?: AuditRun; result: ShellResult; parseError?: unknown }> {
  const args = [
    url,
    "--output=json",
    "--quiet",
    "--chrome-flags=--headless",
    ...formFactorArgs(factor),
  ];
  if (categories && categories.length > 0) {
    args.push(`--only-categories=${categories.join(",")}`);
  }
  const result = await runShell("lighthouse", args, { timeoutMs: 180_000 });
  if (!result.stdout) return { result };
  try {
    return { run: { factor, parsed: parseLighthouseJSON(result.stdout), raw: result.stdout }, result };
  } catch (parseError) {
    return { result, parseError };
  }
}

function buildFindings(
  parsed: ParsedLighthouse,
  thresholds: Record<string, number> | undefined,
): Finding[] {
  const out: Finding[] = [];
  for (const audit of parsed.failedAudits) {
    const threshold = thresholds?.[audit.id];
    if (typeof threshold === "number" && audit.score >= threshold) continue;
    const finding = formatLighthouseFinding(audit);
    if (finding) out.push(finding);
  }
  return out;
}

/**
 * Merge findings across form factors on audit id, recording which profiles each
 * affects so "fails on desktop only" is readable straight off the finding.
 */
function mergeAcrossFactors(
  runs: AuditRun[],
  thresholds: Record<string, number> | undefined,
): Finding[] {
  const merged = new Map<string, Finding & { _ff: FormFactor[] }>();
  for (const { factor, parsed } of runs) {
    for (const finding of buildFindings(parsed, thresholds)) {
      const key = String(finding.evidence["audit_id"]);
      const existing = merged.get(key);
      if (existing) existing._ff.push(factor);
      else merged.set(key, { ...finding, _ff: [factor] });
    }
  }
  const findings = [...merged.values()].map(({ _ff, ...finding }) => ({
    ...finding,
    evidence: {
      ...finding.evidence,
      affects_form_factors: _ff,
      form_factor_specific: _ff.length === 1,
    },
  }));
  return sortFindingsByPriority(findings);
}

interface LighthouseRecord extends BatchRecord {
  scores: Record<string, number>;
  ttfb_ms: number | null;
  lab: ReturnType<typeof extractLabMetrics>;
  finding_count: number;
  p1_count: number;
  report_file: string;
}

const text = (payload: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
});

export function registerLighthouseTool(server: McpServer) {
  server.registerTool(
    "run_lighthouse",
    {
      description:
        "Runs Google Lighthouse and returns a QA-style report with category " +
        "scores, TTFB, and prioritised findings (P1/P2/P3). " +
        "\n\n" +
        "**Accepts one URL, a comma- or newline-separated list, or a path to a " +
        "CSV with a URL column.** A single URL returns one report immediately. " +
        "Several URLs switch to batch mode: each report is written to " +
        "`output_dir`, a running `_index.json` accumulates, a `cursor` is " +
        "returned to continue with, and the final call adds an `aggregate` " +
        "block with cross-page means, per-template rollups and outliers — " +
        "quote those rather than recomputing them. Re-run with the same URLs " +
        "and no cursor to fill any gaps; completed work is skipped. " +
        "\n\n" +
        "`form_factor` selects the device profile: 'desktop' (default, " +
        "unthrottled), 'mobile' (throttled slow 4G, 4x CPU slowdown), or " +
        "'both'. **Prefer 'both' when auditing properly** — the two profiles " +
        "render different DOM and find different defects, not just different " +
        "performance numbers. " +
        "\n\n" +
        "Requires the Lighthouse CLI on PATH (`npm install -g lighthouse`) " +
        "and a Chrome/Chromium binary.",
      inputSchema: inputShape,
    },
    async ({
      url, urls, categories, thresholds, form_factor,
      output_dir, cursor, max_seconds_per_call, skip_completed,
    }) => {
      const requested = form_factor ?? "desktop";
      const factors: FormFactor[] =
        requested === "both" ? ["mobile", "desktop"] : [requested];

      let resolved;
      try {
        resolved = resolveUrlInputs(url, urls);
      } catch (err) {
        return {
          ...text({ error: "unusable_url_input", message: (err as Error).message }),
          isError: true as const,
        };
      }
      const warnings = [...resolved.warnings];

      // ---- Single URL: unchanged contract ------------------------------
      if (resolved.urls.length === 1) {
        const target = resolved.urls[0];
        const outcomes = await Promise.all(
          factors.map((factor) => runLighthouseOnce(target, factor, categories)),
        );
        const good = outcomes.filter((o) => o.run).map((o) => o.run as AuditRun);

        if (good.length === 0) {
          const first = outcomes[0];
          return first.parseError
            ? parseErrorResponse("Failed to parse Lighthouse JSON", first.parseError, first.result)
            : shellErrorResponse("Lighthouse produced no JSON output", first.result);
        }

        if (factors.length === 1) {
          const { parsed } = good[0];
          return text({
            url: target,
            form_factor: factors[0],
            scores: parsed.categoryScores,
            ttfb_ms: parsed.ttfbMs,
            findings: sortFindingsByPriority(buildFindings(parsed, thresholds)),
            ...(warnings.length ? { warnings } : {}),
          });
        }

        const scores: Record<string, Record<string, number>> = {};
        const ttfb: Record<string, number | null> = {};
        for (const { factor, parsed } of good) {
          scores[factor] = parsed.categoryScores;
          ttfb[factor] = parsed.ttfbMs;
        }
        return text({
          url: target,
          form_factor: "both",
          form_factors_run: good.map((g) => g.factor),
          scores,
          ttfb_ms: ttfb,
          findings: mergeAcrossFactors(good, thresholds),
          ...(warnings.length ? { warnings } : {}),
        });
      }

      // ---- Batch -------------------------------------------------------
      const dir = resolve(output_dir ?? DEFAULT_OUTPUT_DIR);
      // Before anything writes into it. mergeIndex creates it too, but that
      // runs after the loop, which is too late for the first report file.
      await mkdir(dir, { recursive: true });
      const budgetMs = (max_seconds_per_call ?? DEFAULT_MAX_SECONDS_PER_CALL) * 1000;
      const startedAt = Date.now();

      const allUnits = resolved.urls.flatMap((u) =>
        factors.map((factor) => ({ url: u, variant: factor })),
      );
      const { units, skipped } = await filterCompleted(
        dir, allUnits, skip_completed ?? true, cursor,
      );
      if (skipped > 0) {
        warnings.push(
          `Skipped ${skipped} URL/form-factor pair(s) already in ${join(dir, "_index.json")}. ` +
            "Pass skip_completed:false to re-measure them.",
        );
      }
      if (units.length === 0) {
        return text({
          complete: true,
          progress: { done: 0, total: 0, failed: 0 },
          message: "Every requested URL/form-factor pair is already in the index.",
          index_file: join(dir, "_index.json"),
          warnings,
        });
      }

      const start = decodeCursor(cursor);
      const records: LighthouseRecord[] = [];
      const results: unknown[] = [];
      const failures: Array<{ url: string; form_factor: string; error: string }> = [];
      let index = start;
      let budgetExhausted = false;

      while (index < units.length) {
        // Sequential, not concurrent. Two Chrome instances on one machine
        // contend for CPU, and this tool's whole job is measuring how long
        // things take — a half-busy machine reports numbers nobody can act on.
        // The single-URL path keeps its concurrency: one page, documented.
        if (!hasBudget(startedAt, budgetMs, TYPICAL_RUN_MS, index - start)) {
          budgetExhausted = true;
          break;
        }

        const unit = units[index];
        const factor = unit.variant as FormFactor;
        const outcome = await runLighthouseOnce(unit.url, factor, categories);

        if (!outcome.run) {
          failures.push({
            url: unit.url,
            form_factor: factor,
            error: outcome.parseError
              ? `unparseable Lighthouse JSON: ${(outcome.parseError as Error).message}`
              : outcome.result.stderr.slice(0, 300) || `exit ${outcome.result.exitCode}`,
          });
          index++;
          continue;
        }

        const { parsed, raw } = outcome.run;
        const reportFile = `${slugForUrl(unit.url)}_${factor}.json`;
        // The raw LHR, not the parsed summary: the individual audits are what
        // anyone diagnosing a finding actually needs, and they do not survive
        // parsing. The summary lives in the index.
        await writeFile(join(dir, reportFile), raw, "utf8");

        const findings = sortFindingsByPriority(buildFindings(parsed, thresholds));
        records.push({
          url: unit.url,
          variant: factor,
          scores: parsed.categoryScores,
          ttfb_ms: parsed.ttfbMs,
          lab: extractLabMetrics(raw),
          finding_count: findings.length,
          p1_count: findings.filter((f) => f.priority === "P1").length,
          report_file: reportFile,
        });
        results.push({
          url: unit.url,
          form_factor: factor,
          scores: parsed.categoryScores,
          ttfb_ms: parsed.ttfbMs,
          findings,
          report_file: reportFile,
        });
        index++;
      }

      const { indexPath } = await mergeIndex(dir, records);
      const complete = index >= units.length;

      if (budgetExhausted) {
        warnings.push(
          `Stopped after ${elapsedSeconds(startedAt)}s to stay inside the per-call budget. ` +
            "Call again with the cursor to continue.",
        );
      }
      if (failures.length > 0) {
        warnings.push(
          `${failures.length} run(s) failed. Call again with the same URLs and no cursor — ` +
            "completed pairs are skipped, so only the gaps are retried.",
        );
      }

      let aggregateBlock: unknown;
      if (complete) {
        const all = await readIndex<LighthouseRecord>(dir);
        // Group by page template so the rollup says "PDPs average 61" rather
        // than listing twelve product URLs. Same classifier the PSI plan uses.
        const { templates } = classifyUrls(all.map((r) => r.url));
        const templateOf = new Map<string, { id: string; label: string }>();
        for (const t of templates) {
          for (const candidate of t.candidates) templateOf.set(candidate, { id: t.id, label: t.label });
        }
        const runs: RunResult[] = all.map((r) => {
          const t = templateOf.get(r.url);
          return {
            template: t?.id ?? "all",
            label: t?.label ?? "All pages",
            url: r.url,
            strategy: r.variant,
            runs: 1,
            scores: r.scores,
            lab: r.lab,
            field: null,
            comparisons: [],
            findings: [],
            report_file: r.report_file,
          };
        });
        const { lab_vs_field_summary, ...rest } = aggregate(runs);
        // No field data in a local run, so the lab-vs-field block would be an
        // empty shape inviting a wrong conclusion. PSI is where that lives.
        aggregateBlock = { ...rest, field_data: "not available — use run_performance_audit for real-user data" };
      }

      return text({
        complete,
        ...(complete ? {} : { cursor: encodeCursor(index) }),
        progress: { done: index, total: units.length, failed: failures.length },
        input_kind: resolved.kind,
        ...(resolved.source ? { input_source: resolved.source } : {}),
        form_factor: requested,
        output_dir: dir,
        index_file: indexPath,
        results,
        ...(failures.length ? { failures } : {}),
        ...(aggregateBlock ? { aggregate: aggregateBlock } : {}),
        ...(complete ? {} : { next_step: "Call run_lighthouse again with this cursor and the same input." }),
        warnings,
      });
    },
  );
}
