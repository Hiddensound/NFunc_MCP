import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { httpGetJson } from "../utils/httpClient.js";
import { parsePsiResponse, PsiRuntimeError, type ParsedPsi } from "../utils/psiParser.js";
import { checkPublicReachability } from "../utils/publicUrl.js";
import { resolveApiKey, keylessWarning, KEY_ENV_VAR, KEYLESS_RUN_CAP } from "../utils/psiAuth.js";
import { formatLighthouseFinding } from "../mappers/defectFormatter.js";
import { formatFieldFindings } from "../mappers/webVitalsMapper.js";
import { sortFindingsByPriority } from "../mappers/priorityMapper.js";
import {
  compareLabField,
  adjustmentFor,
  promote,
  demote,
  AUDIT_TO_VITAL,
  type MetricComparison,
} from "../mappers/labFieldComparator.js";
import {
  aggregate,
  collapseSystemicFindings,
  suppressComponentFindings,
  type RunResult,
} from "../mappers/psiAggregator.js";
import type { Finding } from "../types.js";

/**
 * Overridable so the tool can be exercised end to end against a captured
 * response without spending quota, and so anyone behind an egress proxy can
 * point at it. Defaults to the real API.
 */
const PSI_ENDPOINT =
  process.env.PAGESPEED_API_ENDPOINT ??
  "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";
/**
 * Per-attempt ceiling, set from measurement rather than from the documentation.
 *
 * Across every successful live run observed, latency fell between 10 s and
 * 57 s. A longer timeout therefore buys no additional successes — it only makes
 * a hang more expensive. 75 s covers the slowest observed success with margin
 * and leaves room inside a 150 s chunk for a second attempt, which is worth
 * more than waiting: in a 6-run sample the attempt immediately after a timeout
 * succeeded in 10 s.
 */
const PSI_TIMEOUT_MS = 75_000;

/** Typical successful run, measured against a live key. Used to reserve budget. */
const TYPICAL_RUN_MS = 45_000;
/** Spacing between calls. Sequencing beats fanning out — see the tool description. */
const INTER_CALL_DELAY_MS = 1_500;
const DEFAULT_OUTPUT_DIR = "./psi-reports";
/**
 * PSI calls take 10-30 s. Six is roughly 90 seconds of work, which fits inside
 * a typical MCP client timeout with room to spare; the caller loops on the
 * cursor until the batch is done.
 */
const DEFAULT_MAX_RUNS_PER_CALL = 2;

/**
 * Wall-clock ceiling for one call, the real protection against an MCP timeout.
 *
 * A run count alone cannot bound the time, because per-call latency varies far
 * more than expected: fivebelow.com's homepage took 47 s per run while its
 * beauty PLP returned HTTP 500 and burned the retry budget. Counting runs let
 * a two-run chunk exceed five minutes. The loop now stops starting new work
 * once the budget is spent and hands back a cursor, so a chunk returns on time
 * whatever the API does.
 */
const DEFAULT_MAX_SECONDS_PER_CALL = 150;

const pageShape = z.object({
  template: z.string(),
  label: z.string(),
  url: z.string().url(),
  slug: z.string().optional(),
});

const inputShape = {
  pages: z.array(pageShape).min(1).describe("Approved pages from plan_performance_audit."),
  strategy: z.enum(["mobile", "desktop", "both"]).optional(),
  runs_per_url: z.number().int().min(1).max(5).optional(),
  categories: z.array(z.string()).optional(),
  output_dir: z.string().optional(),
  origin_fallback: z.boolean().optional(),
  api_key: z.string().optional(),
  cursor: z.string().optional().describe("Resume token from a previous call. Omit on the first call."),
  max_runs_per_call: z.number().int().min(1).max(20).optional(),
  skip_completed: z
    .boolean()
    .optional()
    .describe(
      "Skip page/strategy pairs already present in the output index (default true). " +
        "PSI fails intermittently, so re-running to fill gaps is normal — this makes " +
        "that cheap instead of re-spending quota on pages that already succeeded. " +
        "Set false to force a fresh measurement.",
    ),
  max_seconds_per_call: z
    .number()
    .int()
    .min(30)
    .max(900)
    .optional()
    .describe(
      `Wall-clock ceiling for one call (default ${DEFAULT_MAX_SECONDS_PER_CALL}s). Must stay ` +
        "below your MCP client's tool timeout; raise MCP_TOOL_TIMEOUT to use a bigger chunk.",
    ),
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface WorkUnit {
  page: z.infer<typeof pageShape>;
  strategy: "mobile" | "desktop";
}

function slugFor(page: z.infer<typeof pageShape>): string {
  if (page.slug) return page.slug;
  try {
    const url = new URL(page.url);
    const path = url.pathname.replace(/^\/|\/$/g, "").replace(/\//g, "-");
    const query = url.search ? `-${url.search.slice(1).replace(/[^a-z0-9]+/gi, "-")}` : "";
    return (path || "homepage") + query;
  } catch {
    return page.template;
  }
}

function encodeCursor(index: number): string {
  return Buffer.from(JSON.stringify({ i: index })).toString("base64url");
}

function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { i?: number };
    return typeof parsed.i === "number" && parsed.i >= 0 ? parsed.i : 0;
  } catch {
    return 0;
  }
}

function buildRequestUrl(
  target: string,
  strategy: string,
  categories: string[],
  key: string | null,
): URL {
  const url = new URL(PSI_ENDPOINT);
  url.searchParams.set("url", target);
  url.searchParams.set("strategy", strategy);
  if (key) url.searchParams.set("key", key);
  for (const category of categories) url.searchParams.append("category", category);
  return url;
}

/**
 * Apply the lab-vs-field verdicts to the findings for one run.
 *
 * The lab finding is the one that moves. A confirmed failure is promoted
 * because two independent measurements agree; a lab-only failure is demoted
 * and tagged, because the simulation saw something real users do not. Field
 * findings that the lab missed entirely are promoted and tagged `field_only` —
 * those are the ones no local tool can produce.
 */
function applyComparisons(findings: Finding[], comparisons: MetricComparison[]): Finding[] {
  for (const comparison of comparisons) {
    const { direction, tag } = adjustmentFor(comparison.verdict);
    if (direction === "none") continue;

    const labAuditId = Object.entries(AUDIT_TO_VITAL).find(
      ([, vital]) => vital === comparison.metric,
    )?.[0];

    const target =
      comparison.verdict === "worse_in_field"
        ? findings.find((f) => f.evidence.audit_id === `crux.${comparison.metric}`)
        : findings.find((f) => f.evidence.audit_id === labAuditId);
    if (!target) continue;

    target.priority =
      direction === "promote"
        ? promote(target.priority, comparison.metric)
        : demote(target.priority);
    target.evidence = { ...target.evidence, lab_field_verdict: comparison.verdict, adjustment: tag };
    target.description = `${target.description} ${comparison.note}`;
  }
  return findings;
}

/** Merge into the running index rather than overwriting, so batches accumulate. */
async function mergeIndex(dir: string, results: RunResult[]): Promise<string> {
  const indexPath = join(dir, "_index.json");
  let existing: RunResult[] = [];
  try {
    existing = JSON.parse(await readFile(indexPath, "utf8")) as RunResult[];
  } catch {
    existing = [];
  }
  const byKey = new Map(existing.map((r) => [`${r.url}|${r.strategy}`, r]));
  for (const result of results) byKey.set(`${result.url}|${result.strategy}`, result);
  await writeFile(indexPath, JSON.stringify([...byKey.values()], null, 2), "utf8");
  return indexPath;
}

export function registerPerformanceAuditTool(server: McpServer) {
  server.registerTool(
    "run_performance_audit",
    {
      description:
        "Runs a PageSpeed Insights audit over an approved set of pages and " +
        "returns lab scores, CrUX real-user field data, and the disagreements " +
        "between them. " +
        "\n\n" +
        "**Call plan_performance_audit first** and get the user's approval on " +
        "the page list — this tool spends real API quota and takes 10-30 " +
        "seconds per page/device. " +
        "\n\n" +
        "Runs in chunks: each call performs at most `max_runs_per_call` PSI " +
        "requests and returns a `cursor`. Keep calling with that cursor until " +
        "`complete` is true. Full raw reports are written to `output_dir` " +
        "(one JSON per page/device) and merged into a running `_index.json`, " +
        "so a failure partway through never costs the completed runs. The " +
        "final call also returns an `aggregate` block containing every " +
        "cross-page number — quote those rather than recomputing them." +
        "\n\n" +
        "The unique value here is `lab_vs_field`: a metric that passes in the " +
        "lab but fails for real users means the test environment is not " +
        "reproducing production, which no local tool can detect.",
      inputSchema: inputShape,
    },
    async ({
      pages, strategy, runs_per_url, categories, output_dir,
      origin_fallback, api_key, cursor, max_runs_per_call, max_seconds_per_call,
      skip_completed,
    }) => {
      const warnings: string[] = [];
      const resolvedStrategy = strategy ?? "both";
      const runsPerUrl = runs_per_url ?? 1;
      const originFallback = origin_fallback ?? true;
      const maxRuns = max_runs_per_call ?? DEFAULT_MAX_RUNS_PER_CALL;
      const budgetMs = (max_seconds_per_call ?? DEFAULT_MAX_SECONDS_PER_CALL) * 1000;
      const startedAt = Date.now();
      const requestedCategories = categories ?? [
        "performance", "accessibility", "best-practices", "seo",
      ];
      const dir = resolve(output_dir ?? DEFAULT_OUTPUT_DIR);
      const { key, source } = resolveApiKey(api_key);

      const strategies: Array<"mobile" | "desktop"> =
        resolvedStrategy === "both" ? ["mobile", "desktop"] : [resolvedStrategy];

      const units: WorkUnit[] = [];
      for (const page of pages) for (const s of strategies) units.push({ page, strategy: s });

      /**
       * Drop work that already succeeded.
       *
       * PSI fails intermittently on real sites — roughly one run in three
       * against fivebelow.com timed out or 500'd, and the same URL succeeded
       * minutes later. Filling those gaps is the normal workflow, not an edge
       * case, so a second pass must not re-measure and re-charge for the pages
       * that worked. Ordering is preserved, so a cursor from a previous call
       * would not line up; re-running to fill gaps means starting without one.
       */
      let skipped = 0;
      if ((skip_completed ?? true) && !cursor) {
        try {
          const existing = JSON.parse(await readFile(join(dir, "_index.json"), "utf8")) as RunResult[];
          const done = new Set(existing.map((r) => `${r.url}|${r.strategy}`));
          const before = units.length;
          const remaining = units.filter((u) => !done.has(`${u.page.url}|${u.strategy}`));
          skipped = before - remaining.length;
          units.length = 0;
          units.push(...remaining);
        } catch {
          // No index yet — nothing to skip.
        }
      }
      if (skipped > 0) {
        warnings.push(
          `Skipped ${skipped} page/strategy pair(s) already in ${join(dir, "_index.json")}. ` +
            "Pass skip_completed:false to re-measure them.",
        );
      }
      if (units.length === 0) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              complete: true,
              progress: { done: 0, total: 0, failed: 0 },
              message: "Every requested page/strategy is already in the index. Nothing to run.",
              index_file: join(dir, "_index.json"),
              warnings,
            }, null, 2),
          }],
        };
      }

      const totalRuns = units.length * runsPerUrl;
      if (!key && totalRuns > KEYLESS_RUN_CAP) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              error: "keyless_batch_too_large",
              message: keylessWarning(totalRuns),
              runs_requested: totalRuns,
              keyless_cap: KEYLESS_RUN_CAP,
              env_var: KEY_ENV_VAR,
            }, null, 2),
          }],
          isError: true,
        };
      }

      const unreachable = pages
        .map((p) => ({ url: p.url, check: checkPublicReachability(p.url) }))
        .filter((p) => !p.check.auditable);
      if (unreachable.length > 0) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              error: "pages_not_auditable",
              pages: unreachable.map((p) => ({ url: p.url, reason: p.check.reason })),
            }, null, 2),
          }],
          isError: true,
        };
      }

      await mkdir(dir, { recursive: true });

      const start = decodeCursor(cursor);
      const results: RunResult[] = [];
      const failures: Array<{ url: string; strategy: string; error: string }> = [];
      let index = start;
      let callsUsed = 0;

      let budgetExhausted = false;
      while (index < units.length && callsUsed + runsPerUrl <= Math.max(maxRuns, runsPerUrl)) {
        // Check before starting a unit, never mid-unit: abandoning a page
        // half-way through its repeat runs would leave a median of one.
        // Reserve room for the run about to start, rather than checking only
        // whether the budget is already spent — otherwise a 40 s run at the
        // 149 s mark starts a second and overshoots by a full run.
        const reserve = TYPICAL_RUN_MS * runsPerUrl;
        if (callsUsed > 0 && Date.now() - startedAt + reserve >= budgetMs) {
          budgetExhausted = true;
          break;
        }
        const unit = units[index];
        // Raw bodies are kept alongside the parsed form: the parsed summary
        // feeds the index, the raw response is what gets written to disk.
        const attempts: Array<{ parsed: ParsedPsi; raw: string }> = [];
        let lastError = "";

        for (let run = 0; run < runsPerUrl; run++) {
          if (callsUsed > 0) await sleep(INTER_CALL_DELAY_MS);
          const requestUrl = buildRequestUrl(unit.page.url, unit.strategy, requestedCategories, key);
          // Clamp this run's timeout to the budget it has left. Without it the
          // budget is only advisory: a single hang costs the full PSI timeout
          // on top of whatever was already spent, and a 150 s chunk ran 188 s.
          // The reserve check above guarantees at least TYPICAL_RUN_MS remains,
          // so this never squeezes a run into an unwinnable window.
          // The whole call, retries included, is bounded by what is left of the
          // chunk budget — so a retry can never push the chunk past its ceiling.
          const remainingMs = budgetMs - (Date.now() - startedAt);
          const response = await httpGetJson<unknown>(requestUrl, {
            timeoutMs: PSI_TIMEOUT_MS,
            totalBudgetMs: Math.max(TYPICAL_RUN_MS, remainingMs),
            // One retry, and timeouts are included: measurement showed timeout
            // is the dominant failure mode here and that it usually recovers,
            // while 5xx is rare and cheap. Two attempts, not three.
            retries: 1,
            retryOnTimeout: true,
            retryDelayMs: 3_000,
            redact: key ? [key] : [],
          });
          callsUsed++;

          if (!response.ok || !response.data) {
            lastError = response.error ?? `HTTP ${response.status}`;
            continue;
          }

          try {
            attempts.push({
              parsed: parsePsiResponse(response.body, {
                strategy: unit.strategy,
                originFallback,
              }),
              raw: response.body,
            });
          } catch (err) {
            // A 200 carrying a runtimeError is a failed run, not a zero score.
            lastError =
              err instanceof PsiRuntimeError
                ? `Lighthouse runtime error ${err.code}: ${err.message}`
                : (err as Error).message;
          }
        }

        if (attempts.length === 0) {
          failures.push({ url: unit.page.url, strategy: unit.strategy, error: lastError });
          index++;
          continue;
        }

        // Median run by performance score. Averaging the metrics of different
        // runs would invent a page that was never measured; picking the median
        // run keeps every number internally consistent with one real load.
        const ordered = [...attempts].sort(
          (a, b) => (a.parsed.scores.performance ?? 0) - (b.parsed.scores.performance ?? 0),
        );
        const median = ordered[Math.floor(ordered.length / 2)];
        const parsed = median.parsed;

        // Write the **raw** PSI response, not the parsed summary.
        //
        // This originally saved the parsed object, which holds only failing
        // audits — 9 KB where the real response is closer to a megabyte. The
        // report spec sends the agent to these files to fill in the diagnostic
        // checklist (unused JS, third-party weight, image formats), and none of
        // that detail survived parsing. The parsed summary lives in _index.json;
        // disk holds the full record.
        const fileName = `${slugFor(unit.page)}_${unit.strategy}.json`;
        await writeFile(join(dir, fileName), median.raw, "utf8");

        const labFindings = parsed.lighthouse.failedAudits
          .map(formatLighthouseFinding)
          .filter((f): f is Finding => f !== null);
        const fieldFindings = parsed.field ? formatFieldFindings(parsed.field.metrics) : [];
        const comparisons = compareLabField(parsed.lab, parsed.field);

        let findings = suppressComponentFindings([...fieldFindings, ...labFindings]);
        findings = sortFindingsByPriority(applyComparisons(findings, comparisons));

        results.push({
          template: unit.page.template,
          label: unit.page.label,
          url: unit.page.url,
          strategy: unit.strategy,
          runs: attempts.length,
          scores: parsed.scores,
          lab: parsed.lab,
          field: parsed.field,
          comparisons,
          findings,
          report_file: fileName,
        });
        index++;
      }

      if (budgetExhausted) {
        warnings.push(
          `Stopped after ${Math.round((Date.now() - startedAt) / 1000)}s to stay inside the ` +
            "per-call time budget. Call again with the cursor to continue.",
        );
      }

      const indexPath = await mergeIndex(dir, results);
      const complete = index >= units.length;

      if (failures.length > 0) {
        warnings.push(
          `${failures.length} run(s) failed. PSI fails intermittently — the same URL often ` +
            "succeeds on a later attempt. Call this tool again with the same pages and no " +
            "cursor: completed runs are skipped automatically, so only the gaps are retried.",
        );
      }

      let aggregateBlock: Record<string, unknown> | undefined;
      if (complete) {
        // Aggregate over everything on disk, not just this chunk — the whole
        // point of the running index is that the final numbers cover the batch.
        let allRuns: RunResult[] = results;
        try {
          allRuns = JSON.parse(await readFile(indexPath, "utf8")) as RunResult[];
        } catch {
          warnings.push("Could not re-read the index; aggregate covers this call's runs only.");
        }
        const systemic = collapseSystemicFindings(allRuns);
        aggregateBlock = {
          ...aggregate(allRuns),
          systemic_findings: systemic.findings,
          collapsed_vitals: systemic.collapsedVitals,
          ...(systemic.collapsedVitals.length > 0
            ? {
                collapse_note:
                  `Per-page findings for ${systemic.collapsedVitals.join(", ")} are superseded by ` +
                  "the systemic findings above; report them once, site-wide, not per page.",
              }
            : {}),
        };
      }

      const payload = {
        complete,
        ...(complete ? {} : { cursor: encodeCursor(index) }),
        progress: { done: index, total: units.length, failed: failures.length },
        api_key: { present: Boolean(key), source },
        output_dir: dir,
        index_file: indexPath,
        results,
        ...(failures.length > 0 ? { failures } : {}),
        ...(aggregateBlock ? { aggregate: aggregateBlock } : {}),
        ...(complete
          ? {}
          : { next_step: "Call run_performance_audit again with this cursor and the same pages." }),
        warnings,
      };

      return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
    },
  );
}
