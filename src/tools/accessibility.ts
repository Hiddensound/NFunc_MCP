import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
import { resolveUrlInputs } from "../utils/urlInput.js";
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

export type A11yFormFactor = "desktop" | "mobile";

/** A pa11y run is faster than Lighthouse but still Chrome. Measured mid-range. */
const TYPICAL_RUN_MS = 15_000;
const DEFAULT_OUTPUT_DIR = "./a11y-reports";

/**
 * pa11y has no --viewport flag, but its --config file is passed through to
 * Puppeteer, so a mobile viewport goes in there. The numbers match Lighthouse's
 * mobile emulation (412x823, 2x DPR, touch) so an a11y run and a perf run are
 * describing the same rendered page rather than two different layouts.
 *
 * Desktop deliberately writes no config at all: pa11y's own default viewport is
 * already desktop-shaped, and passing a config would override any pa11y.json a
 * project has of its own.
 */
const MOBILE_VIEWPORT = {
  viewport: { width: 412, height: 823, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
};

const inputShape = {
  url: z
    .string()
    .min(1)
    .describe(
      "One URL, several comma- or newline-separated URLs, or a path to a CSV " +
        "containing a URL column. More than one URL switches the tool into " +
        "batch mode.",
    ),
  urls: z.array(z.string()).optional(),
  form_factor: z
    .enum(["desktop", "mobile", "both"])
    .optional()
    .describe(
      "Viewport to test at. 'desktop' (default) uses pa11y's own viewport. " +
        "'mobile' emulates a 412x823 touch device, matching run_lighthouse's " +
        "mobile profile — worth using when the mobile layout differs, since " +
        "touch-target and reflow failures only appear there. 'both' runs each.",
    ),
  output_dir: z.string().optional(),
  cursor: z.string().optional().describe("Resume token from a previous batch call."),
  max_seconds_per_call: z.number().int().min(30).max(900).optional(),
  skip_completed: z.boolean().optional(),
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

interface A11yOutcome {
  findings: Finding[];
  rawCount: number;
  runnersUsed: string[];
  /** Set when some engines produced output and others did not. */
  partial?: string;
  error?: string;
}

/** Path to a pa11y config carrying a mobile viewport, written once per process. */
let mobileConfigPath: string | null = null;
async function mobileConfig(): Promise<string> {
  if (mobileConfigPath) return mobileConfigPath;
  const path = join(tmpdir(), `nfunc-pa11y-mobile-${process.pid}.json`);
  await writeFile(path, JSON.stringify(MOBILE_VIEWPORT, null, 2), "utf8");
  mobileConfigPath = path;
  return path;
}

async function auditUrl(
  url: string,
  engines: Array<"htmlcs" | "axe">,
  standard: string,
  ignore: string[] | undefined,
  formFactor: A11yFormFactor,
): Promise<A11yOutcome> {
  const configPath = formFactor === "mobile" ? await mobileConfig() : null;

  const buildArgs = (engine: string) => {
    const args = [url, "--reporter", "json", "--standard", standard, "--runner", engine];
    if (ignore && ignore.length > 0) args.push("--ignore", ignore.join(";"));
    if (configPath) args.push("--config", configPath);
    return args;
  };

  // Engines run concurrently: unlike Lighthouse, pa11y is not measuring time,
  // so CPU contention costs nothing but wall clock.
  const results = await Promise.all(
    engines.map((e) => runShell("pa11y", buildArgs(e), { timeoutMs: 120_000 })),
  );

  // pa11y exits 2 when issues are found — a successful run with data. Exit 1
  // means pa11y itself failed (browser launch, bad URL).
  const usable = results.filter((r) => (r.exitCode === 0 || r.exitCode === 2) && r.stdout);
  if (usable.length === 0) {
    return {
      findings: [],
      rawCount: 0,
      runnersUsed: [],
      error: results[0]?.stderr.slice(0, 300) || `exit ${results[0]?.exitCode}`,
    };
  }

  const rawFindings: Finding[] = [];
  for (const result of usable) {
    let parsed;
    try {
      parsed = parsePa11yJSON(result.stdout);
    } catch (err) {
      return { findings: [], rawCount: 0, runnersUsed: [], error: `unparseable pa11y JSON: ${(err as Error).message}` };
    }
    for (const violation of parsed.violations) {
      const finding = formatA11yFinding(violation);
      if (finding) rawFindings.push(finding);
    }
  }

  // Collapse repeats of the same defect before counting — see a11yDedupe for
  // why pa11y produces them. Dedupes *within* an engine only: the key is
  // (rule_code, selector) and the engines emit different code shapes for the
  // same defect, so an element both flag appears twice. Deliberate — two
  // independent engines agreeing is corroboration worth seeing.
  const { findings, rawCount } = dedupeA11yFindings(rawFindings);
  sortFindingsByPriority(findings);
  return {
    findings,
    rawCount,
    runnersUsed: engines.slice(0, usable.length),
    ...(usable.length < engines.length
      ? { partial: `Only ${usable.length} of ${engines.length} runners produced output.` }
      : {}),
  };
}

interface A11yRecord extends BatchRecord {
  violation_count: number;
  raw_violation_count: number;
  p1_count: number;
  rules: string[];
}

/**
 * Cross-page rollup.
 *
 * The useful question over a set of pages is not "how many violations" but
 * "which defects are in the shared layout". A rule failing on nearly every
 * page is in the header, the footer or the base template — one fix clears all
 * of them — while a rule failing on one page is that page's own bug. Volume
 * alone cannot tell those apart, so the rollup counts pages per rule.
 */
function aggregateA11y(records: A11yRecord[]) {
  const pages = new Set(records.map((r) => r.url)).size;
  const byRule = new Map<string, { rule: string; pages: Set<string>; runs: number }>();
  for (const record of records) {
    for (const rule of record.rules) {
      const entry = byRule.get(rule) ?? { rule, pages: new Set<string>(), runs: 0 };
      entry.pages.add(record.url);
      entry.runs++;
      byRule.set(rule, entry);
    }
  }

  const rules = [...byRule.values()]
    .map((e) => ({
      rule: e.rule,
      pages_affected: e.pages.size,
      of_pages: pages,
      pct: Math.round((e.pages.size / pages) * 100),
      // A rule on 80%+ of pages is shared-layout, not per-page. Same threshold
      // as the PSI systemic collapse, for the same reason.
      shared_layout: e.pages.size / pages >= 0.8 && pages >= 3,
    }))
    .sort((a, b) => b.pages_affected - a.pages_affected);

  const worst = [...records]
    .sort((a, b) => b.p1_count - a.p1_count || b.violation_count - a.violation_count)
    .slice(0, 3)
    .map((r) => ({ url: r.url, variant: r.variant, p1_count: r.p1_count, violation_count: r.violation_count }));

  return {
    pages,
    run_count: records.length,
    captured_at: new Date().toISOString(),
    totals: {
      violations: records.reduce((n, r) => n + r.violation_count, 0),
      p1: records.reduce((n, r) => n + r.p1_count, 0),
      clean_runs: records.filter((r) => r.violation_count === 0).length,
    },
    by_variant: [...new Set(records.map((r) => r.variant))].map((variant) => {
      const group = records.filter((r) => r.variant === variant);
      return {
        variant,
        runs: group.length,
        violations: group.reduce((n, r) => n + r.violation_count, 0),
        p1: group.reduce((n, r) => n + r.p1_count, 0),
      };
    }),
    rules,
    shared_layout_rules: rules.filter((r) => r.shared_layout).map((r) => r.rule),
    worst_pages: worst,
  };
}

const text = (payload: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
});

export function registerAccessibilityTool(server: McpServer) {
  server.registerTool(
    "run_accessibility_check",
    {
      description:
        "Runs pa11y and returns a QA-style report of WCAG violations " +
        "prioritised P1/P2/P3 (notices filtered out). " +
        "\n\n" +
        "**Accepts one URL, a comma- or newline-separated list, or a path to a " +
        "CSV with a URL column.** Several URLs switch to batch mode: a running " +
        "`_index.json` accumulates in `output_dir`, a `cursor` is returned to " +
        "continue with, and the final call adds an `aggregate` block. That " +
        "block answers the question a single-page run cannot — **which rules " +
        "fail across most pages**, and are therefore in the shared header, " +
        "footer or base template rather than being any one page's bug. " +
        "\n\n" +
        "Two engines via `runner`. htmlcs (default) is strong on WCAG " +
        "techniques, document structure, labels and duplicate ids. axe is " +
        "Deque's engine and is materially stronger on ARIA — roles, required " +
        "parent/child relationships, prohibited and unsupported attributes — " +
        "and on computed colour contrast. **Prefer runner='axe' whenever the " +
        "work involves ARIA, a component library, or a design system**, and " +
        "'both' for the most thorough sweep. The overlap is only partial: on a " +
        "real commerce page htmlcs found unlabelled inputs and duplicate ids " +
        "axe did not, while axe found aria-allowed-attr, aria-required-parent " +
        "and image-alt failures htmlcs missed entirely. " +
        "\n\n" +
        "`form_factor` defaults to desktop. Pass 'mobile' when the mobile " +
        "layout differs — touch-target and reflow failures appear only there. " +
        "\n\n" +
        "Requires the pa11y CLI on PATH (`npm install -g pa11y`).",
      inputSchema: inputShape,
    },
    async ({
      url, urls, standard, ignore, runner, form_factor,
      output_dir, cursor, max_seconds_per_call, skip_completed,
    }) => {
      const resolvedStandard = standard ?? "WCAG2AA";
      const resolvedRunner = runner ?? "htmlcs";
      const engines: Array<"htmlcs" | "axe"> =
        resolvedRunner === "both" ? ["htmlcs", "axe"] : [resolvedRunner];
      const requestedFactor = form_factor ?? "desktop";
      const factors: A11yFormFactor[] =
        requestedFactor === "both" ? ["desktop", "mobile"] : [requestedFactor];

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

      // ---- Single URL, single viewport: unchanged contract --------------
      if (resolved.urls.length === 1 && factors.length === 1) {
        const target = resolved.urls[0];
        const outcome = await auditUrl(target, engines, resolvedStandard, ignore, factors[0]);
        if (outcome.error) {
          return {
            ...text({
              error: "pa11y_failed",
              url: target,
              form_factor: factors[0],
              message: outcome.error,
            }),
            isError: true as const,
          };
        }
        if (outcome.partial) warnings.push(outcome.partial);
        return text({
          url: target,
          standard: resolvedStandard,
          runners: engines,
          ...(factors[0] === "mobile" ? { form_factor: "mobile" } : {}),
          violation_count: outcome.findings.length,
          // Pre-dedup total, so a large drop between the two is explainable
          // rather than looking like dropped findings.
          raw_violation_count: outcome.rawCount,
          findings: outcome.findings,
          ...(warnings.length ? { warnings } : {}),
        });
      }

      // ---- Batch --------------------------------------------------------
      const dir = resolve(output_dir ?? DEFAULT_OUTPUT_DIR);
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
          `Skipped ${skipped} URL/viewport pair(s) already in ${join(dir, "_index.json")}. ` +
            "Pass skip_completed:false to re-test them.",
        );
      }
      if (units.length === 0) {
        return text({
          complete: true,
          progress: { done: 0, total: 0, failed: 0 },
          message: "Every requested URL/viewport pair is already in the index.",
          index_file: join(dir, "_index.json"),
          warnings,
        });
      }

      const start = decodeCursor(cursor);
      const records: A11yRecord[] = [];
      const results: unknown[] = [];
      const failures: Array<{ url: string; form_factor: string; error: string }> = [];
      let index = start;
      let budgetExhausted = false;

      while (index < units.length) {
        if (!hasBudget(startedAt, budgetMs, TYPICAL_RUN_MS * engines.length, index - start)) {
          budgetExhausted = true;
          break;
        }

        const unit = units[index];
        const factor = unit.variant as A11yFormFactor;
        const outcome = await auditUrl(unit.url, engines, resolvedStandard, ignore, factor);

        if (outcome.error) {
          failures.push({ url: unit.url, form_factor: factor, error: outcome.error });
          index++;
          continue;
        }

        if (outcome.partial) warnings.push(`${unit.url} (${factor}): ${outcome.partial}`);

        const reportFile = `${slugForUrl(unit.url)}_${factor}.json`;
        await writeFile(
          join(dir, reportFile),
          JSON.stringify(
            {
              url: unit.url,
              form_factor: factor,
              standard: resolvedStandard,
              runners: engines,
              violation_count: outcome.findings.length,
              raw_violation_count: outcome.rawCount,
              findings: outcome.findings,
            },
            null,
            2,
          ),
          "utf8",
        );

        // Rule ids drive the cross-page rollup, so they are stored per run
        // rather than recomputed from the findings later.
        const rules = [
          ...new Set(outcome.findings.map((f) => String(f.evidence["rule_code"] ?? f.title))),
        ];

        records.push({
          url: unit.url,
          variant: factor,
          violation_count: outcome.findings.length,
          raw_violation_count: outcome.rawCount,
          p1_count: outcome.findings.filter((f) => f.priority === "P1").length,
          rules,
          report_file: reportFile,
        });
        results.push({
          url: unit.url,
          form_factor: factor,
          violation_count: outcome.findings.length,
          raw_violation_count: outcome.rawCount,
          findings: outcome.findings,
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
        aggregateBlock = aggregateA11y(await readIndex<A11yRecord>(dir));
      }

      return text({
        complete,
        ...(complete ? {} : { cursor: encodeCursor(index) }),
        progress: { done: index, total: units.length, failed: failures.length },
        input_kind: resolved.kind,
        ...(resolved.source ? { input_source: resolved.source } : {}),
        standard: resolvedStandard,
        runners: engines,
        form_factor: requestedFactor,
        output_dir: dir,
        index_file: indexPath,
        results,
        ...(failures.length ? { failures } : {}),
        ...(aggregateBlock ? { aggregate: aggregateBlock } : {}),
        ...(complete ? {} : { next_step: "Call run_accessibility_check again with this cursor and the same input." }),
        warnings,
      });
    },
  );
}
