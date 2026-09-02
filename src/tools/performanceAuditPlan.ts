import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { httpGet } from "../utils/httpClient.js";
import { readSitemap } from "../utils/sitemapReader.js";
import { readUrlsFromCsv } from "../utils/csvReader.js";
import { classifyUrls, type UrlTemplate } from "../utils/urlClassifier.js";
import { checkPublicReachability } from "../utils/publicUrl.js";
import {
  resolveApiKey,
  keylessWarning,
  KEY_ENV_VAR,
  KEYLESS_RUN_CAP,
} from "../utils/psiAuth.js";

/**
 * Wall-clock budget per PSI call.
 *
 * Measured, not guessed: fivebelow.com's homepage took 39-47 s per run against
 * a live key, roughly three times the 10-30 s the documentation implies. An
 * estimate exists to let someone decide whether to approve a batch, so it
 * should err high — a 20-minute job quoted as 7 gets approved and then
 * abandoned.
 */
const SECONDS_PER_RUN = 45;
const DAILY_QUOTA_WITH_KEY = 25_000;

/**
 * How many templates get sampled by default.
 *
 * Classification is deliberately granular — merging "/en/blog/release/*" into
 * "/en/*" would hide real differences — but granularity compounds: nodejs.org
 * resolves to 100 templates, and sampling all of them is 364 PSI calls of
 * mostly redundant blog posts. Templates are ranked by how much of the site
 * they represent and the top slice is sampled; the rest are still reported, so
 * the user can pull any of them in by name.
 */
const DEFAULT_MAX_TEMPLATES = 12;

const inputShape = {
  origin: z
    .string()
    .url()
    .describe("Site to plan an audit for, e.g. https://www.example.com"),
  discovery: z
    .enum(["sitemap", "list", "csv", "crawl"])
    .optional()
    .describe(
      "How to find URLs. 'sitemap' (default) reads robots.txt and " +
        "/sitemap.xml — fastest and authoritative. 'list' uses the urls " +
        "input. 'csv' reads csv_path. 'crawl' is not implemented yet.",
    ),
  urls: z.array(z.string().url()).optional(),
  csv_path: z.string().optional(),
  strategy: z.enum(["mobile", "desktop", "both"]).optional(),
  runs_per_url: z.number().int().min(1).max(5).optional(),
  max_templates: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe(
      `How many templates to sample, largest first (default ${DEFAULT_MAX_TEMPLATES}). ` +
        "Smaller templates are still listed so they can be requested by name.",
    ),
  api_key: z
    .string()
    .optional()
    .describe(
      `Optional PSI key. Prefer setting ${KEY_ENV_VAR} in the MCP client ` +
        "config — a key passed here is stored in the conversation transcript.",
    ),
};

interface PlannedTemplate extends UrlTemplate {
  sampled_urls?: string[];
}

/** Same-host filter. A sitemap may list other properties; auditing them silently would be wrong. */
function sameOrigin(url: string, originHost: string): boolean {
  try {
    return new URL(url).hostname.toLowerCase() === originHost;
  } catch {
    return false;
  }
}

/** A leading /en/ or /en-us/ is a locale, not a section of the site. */
const LOCALE_SEGMENT = /^[a-z]{2}(-[a-z]{2})?$/i;

/**
 * Which part of the site a template belongs to.
 *
 * The first path segment, except when that segment is a locale code — on
 * nodejs.org every page lives under /en/, so keying on segment one put blog,
 * docs and downloads in a single bucket and defeated the round-robin
 * entirely. Locale-prefixed URLs are common enough (and this check narrow
 * enough) to be worth special-casing.
 */
function sectionOf(pattern: string): string {
  const segments = pattern.replace(/^\//, "").split("?")[0].split("/").filter(Boolean);
  if (segments.length > 1 && LOCALE_SEGMENT.test(segments[0])) segments.shift();
  return segments[0] ?? "/";
}

/**
 * Choose which templates to sample.
 *
 * Ranking purely by URL count fills the budget with whatever section is
 * biggest: on nodejs.org that is eleven flavours of blog and nothing else,
 * while a human would have picked a blog post, the docs, the download page and
 * the homepage. Volume is a poor proxy for what a performance audit needs,
 * because templates within one section usually share a codepath and therefore
 * share their defects — the second blog variant tells you far less than the
 * first download page.
 *
 * So selection round-robins across top-level sections, taking each section's
 * largest remaining template in turn. Within a section, and between sections
 * of equal standing, URL count still decides. The entry page — whatever URL was
 * actually requested — is seeded first regardless: it is a single URL, so volume
 * ranking always sorts it last, and it is the page the user named.
 */
function selectBudget(
  eligible: UrlTemplate[],
  budget: number,
  entryPattern = "/",
): UrlTemplate[] {
  // The entry page is one URL, so volume ranking always sorts it last.
  const homepage = eligible.find((t) => t.pattern === entryPattern);
  const picked: UrlTemplate[] = homepage ? [homepage] : [];

  const bySection = new Map<string, UrlTemplate[]>();
  for (const t of eligible) {
    if (t === homepage) continue;
    const key = sectionOf(t.pattern);
    const bucket = bySection.get(key);
    if (bucket) bucket.push(t);
    else bySection.set(key, [t]);
  }

  // Sections ordered by their largest template, so the dominant part of the
  // site is still sampled first — just not exclusively.
  const queues = [...bySection.values()]
    .map((list) => [...list].sort((a, b) => b.urlCount - a.urlCount))
    .sort((a, b) => b[0].urlCount - a[0].urlCount);

  let progressed = true;
  while (picked.length < budget && progressed) {
    progressed = false;
    for (const queue of queues) {
      if (picked.length >= budget) break;
      const next = queue.shift();
      if (!next) continue;
      picked.push(next);
      progressed = true;
    }
  }

  return picked;
}

function buildQuestions(
  templates: PlannedTemplate[],
  gated: PlannedTemplate[],
  deferred: PlannedTemplate[],
  runs: number,
  runsPerUrl: number,
  hasKey: boolean,
  truncated: boolean,
): string[] {
  const questions: string[] = [];

  questions.push(
    `Sample sizes: the plan audits ${templates.reduce((n, t) => n + t.suggestedSample, 0)} ` +
      `URLs across ${templates.length} templates. Accept these, or set your own per template?`,
  );

  if (runsPerUrl === 1) {
    const extra = Math.round((runs * 2 * SECONDS_PER_RUN) / 60);
    questions.push(
      `runs_per_url is 1, so a single slow run becomes an unchallenged data ` +
        `point. Raising it to 3 takes the median and removes that risk, at ` +
        `roughly ${extra} extra minutes. Raise it?`,
    );
  }

  if (deferred.length > 0) {
    questions.push(
      `${deferred.length} smaller template(s) are listed but not sampled, to keep the run ` +
        `affordable. Pull any of them in by pattern, or raise max_templates?`,
    );
  }

  if (gated.length > 0) {
    questions.push(
      `${gated.map((t) => t.label).join(", ")} cannot be audited by PSI — it ` +
        `fetches anonymously, so it would measure an empty cart or a login ` +
        `redirect. Run these through run_lighthouse separately?`,
    );
  }

  if (!hasKey) {
    questions.push(
      `No ${KEY_ENV_VAR} is set. Provide a key, or cut the run to ` +
        `${KEYLESS_RUN_CAP} runs or fewer?`,
    );
  }

  if (truncated) {
    questions.push(
      "Sitemap discovery hit its cap, so the template breakdown covers a " +
        "subset of the site. Proceed with that, or narrow the audit to " +
        "specific sections?",
    );
  }

  return questions;
}

export function registerPerformanceAuditPlanTool(server: McpServer) {
  server.registerTool(
    "plan_performance_audit",
    {
      description:
        "Plans a PageSpeed Insights audit without spending any PSI quota. " +
        "Discovers a site's URLs (sitemap, an explicit list, or a CSV), " +
        "clusters them into page templates, flags the ones PSI physically " +
        "cannot audit, and returns a costed run plan plus the questions that " +
        "need answering before it runs. " +
        "\n\n" +
        "**Always call this before run_performance_audit.** Present the " +
        "returned templates and `questions` to the user, get their answers, " +
        "then pass the confirmed page list to run_performance_audit. Nothing " +
        "is audited until they approve — a misclassified template should " +
        "cost a conversation turn, not 40 API calls." +
        "\n\n" +
        "PSI is for publicly hosted sites. Localhost and private hosts are " +
        "rejected here; use run_lighthouse for those.",
      inputSchema: inputShape,
    },
    async ({ origin, discovery, urls, csv_path, strategy, runs_per_url, max_templates, api_key }) => {
      const warnings: string[] = [];
      const mode = discovery ?? "sitemap";
      const resolvedStrategy = strategy ?? "both";
      const runsPerUrl = runs_per_url ?? 1;
      const maxTemplates = max_templates ?? DEFAULT_MAX_TEMPLATES;
      const strategyCount = resolvedStrategy === "both" ? 2 : 1;

      // --- Preflight ------------------------------------------------------
      const reach = checkPublicReachability(origin);
      if (!reach.auditable) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { error: "origin_not_auditable", origin, reason: reach.reason },
                null,
                2,
              ),
            },
          ],
          isError: true,
        };
      }

      if (mode === "crawl") {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  error: "crawl_not_implemented",
                  message:
                    "Crawling is not built yet. Use discovery:'sitemap' " +
                    "(default), or supply URLs with discovery:'list' or " +
                    "discovery:'csv'.",
                },
                null,
                2,
              ),
            },
          ],
          isError: true,
        };
      }

      const originHost = new URL(origin).hostname.toLowerCase();
      const liveCheck = await httpGet(origin, { timeoutMs: 15_000, retries: 1 });
      if (!liveCheck.ok) {
        // A bot wall blocking *us* says nothing about PSI, which fetches from
        // Google's own address space and is widely allowlisted — fivebelow.com
        // returns a Cloudflare challenge here while having served PSI fine.
        // Reporting that as "PSI will likely fail" would be a false alarm.
        const botWalled = liveCheck.status === 403 || liveCheck.status === 503;
        warnings.push(
          botWalled
            ? `${origin} returned HTTP ${liveCheck.status} to this preflight, which usually means ` +
                "a bot-protection challenge rather than a broken site. PSI fetches from Google's " +
                "infrastructure and is often allowlisted where we are not, so this is not a reason " +
                "to stop — but if the audit comes back empty, that challenge page is the first suspect."
            : `${origin} did not respond successfully (${liveCheck.error ?? `HTTP ${liveCheck.status}`}). ` +
                "PSI will likely fail the same way; confirm the URL before running.",
        );
      }

      // --- Discovery ------------------------------------------------------
      let discovered: string[] = [];
      let sitemapUrl: string | null = null;
      let truncated = false;

      if (mode === "list") {
        if (!urls || urls.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  { error: "missing_urls", message: "discovery:'list' requires a non-empty urls array." },
                  null,
                  2,
                ),
              },
            ],
            isError: true,
          };
        }
        discovered = urls;
      } else if (mode === "csv") {
        if (!csv_path) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  { error: "missing_csv_path", message: "discovery:'csv' requires csv_path." },
                  null,
                  2,
                ),
              },
            ],
            isError: true,
          };
        }
        try {
          const csv = readUrlsFromCsv(csv_path);
          discovered = csv.urls;
          warnings.push(...csv.warnings);
          warnings.push(`Read ${csv.urls.length} URLs from column "${csv.column}" of ${csv_path}.`);
        } catch (err) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  { error: "csv_unreadable", message: (err as Error).message },
                  null,
                  2,
                ),
              },
            ],
            isError: true,
          };
        }
      } else {
        const sitemap = await readSitemap(origin);
        discovered = sitemap.urls;
        sitemapUrl = sitemap.sitemapsRead[0] ?? null;
        truncated = sitemap.truncated;
        warnings.push(...sitemap.warnings);
      }

      // Seed the URL the user actually gave.
      //
      // Sitemaps frequently omit their entry page — nodejs.org lists /en/... and
      // never "/" — so a plan built purely from discovery can skip the very page
      // that was asked about. This originally seeded `new URL("/", origin)`,
      // which silently retargeted the audit whenever the input carried a path:
      // a request for /ecommerce/ was planned as the site's domain homepage, a
      // completely different page.
      const entry = new URL(origin);
      const entryUrl = entry.toString();
      const entryPath = entry.pathname.replace(/\/$/, "") || "/";
      const sameUrl = (a: string, b: string): boolean =>
        a.replace(/\/$/, "") === b.replace(/\/$/, "");

      if (!discovered.some((u) => sameUrl(u, entryUrl))) {
        discovered = [entryUrl, ...discovered];
        warnings.push(`Added ${entryUrl} — it was not listed by ${mode} discovery.`);
      }

      let onOrigin = discovered.filter((u) => sameOrigin(u, originHost));

      // A path in the input scopes the audit to that subtree. Someone auditing
      // /ecommerce/ is asking about the shop, not the blog that shares the host.
      if (entryPath !== "/") {
        const before = onOrigin.length;
        onOrigin = onOrigin.filter((u) => {
          try {
            const path = new URL(u).pathname.replace(/\/$/, "") || "/";
            return path === entryPath || path.startsWith(`${entryPath}/`);
          } catch {
            return false;
          }
        });
        if (before > onOrigin.length) {
          warnings.push(
            `Scoped to ${entryPath}/ — dropped ${before - onOrigin.length} URL(s) outside that ` +
              `path. Pass the bare origin instead to audit the whole site.`,
          );
        }
      }
      if (onOrigin.length < discovered.length) {
        warnings.push(
          `Dropped ${discovered.length - onOrigin.length} URL(s) pointing at a different host than ${originHost}.`,
        );
      }

      if (onOrigin.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  error: "no_urls_found",
                  origin,
                  discovery: mode,
                  warnings,
                  message:
                    "No auditable URLs were discovered. Supply them directly " +
                    "with discovery:'list', or point at a CSV export.",
                },
                null,
                2,
              ),
            },
          ],
          isError: true,
        };
      }

      // --- Classify -------------------------------------------------------
      const { templates, skipped } = classifyUrls(onOrigin);
      if (skipped > 0) warnings.push(`Skipped ${skipped} unparseable URL(s).`);

      // classifyUrls returns largest-first, so the head of the list is the
      // slice of the site worth spending calls on — with one correction. The
      // homepage is a single URL and therefore ranks last by volume, which on
      // nodejs.org pushed it out of the sample entirely in favour of an
      // eleventh blog variant. It is the most-visited page on essentially
      // every site, so it is seeded into the budget before ranking applies.
      const eligible = templates.filter((t) => !t.anySessionGated);
      const inBudget = new Set(selectBudget(eligible, maxTemplates, entryPath).map((t) => t.id));

      const planned: PlannedTemplate[] = templates.map((t) => {
        if (!inBudget.has(t.id) && !t.anySessionGated) {
          return {
            ...t,
            suggestedSample: 0,
            reason: "below_sampling_budget",
            recommendation:
              `Not sampled by default — it is outside the top ${maxTemplates} templates by ` +
              "URL count. Ask for it by pattern to include it.",
          };
        }
        if (t.anySessionGated) {
          return {
            ...t,
            auditable: false,
            suggestedSample: 0,
            reason: "session_gated",
            recommendation:
              "PSI fetches anonymously and would measure a logged-out or " +
              "empty version of this page. Audit it with run_lighthouse, " +
              "which runs Chrome locally and can carry session cookies.",
          };
        }
        return { ...t, sampled_urls: t.candidates.slice(0, t.suggestedSample) };
      });

      const sampled = planned.filter((t) => t.auditable && t.suggestedSample > 0);
      const gated = planned.filter((t) => !t.auditable);
      const deferred = planned.filter((t) => t.auditable && t.suggestedSample === 0);

      // --- Cost -----------------------------------------------------------
      const sampledUrls = sampled.reduce((n, t) => n + t.suggestedSample, 0);
      const urlsCovered = sampled.reduce((n, t) => n + t.urlCount, 0);
      const runs = sampledUrls * strategyCount * runsPerUrl;
      const { key, source } = resolveApiKey(api_key);

      if (!key && runs > KEYLESS_RUN_CAP) warnings.push(keylessWarning(runs));

      const payload = {
        origin,
        discovery: {
          source: mode,
          urls_found: onOrigin.length,
          sitemap_url: sitemapUrl,
          truncated,
        },
        api_key: { present: Boolean(key), source },
        strategy: resolvedStrategy,
        runs_per_url: runsPerUrl,
        templates: planned.map((t) => ({
          id: t.id,
          label: t.label,
          pattern: t.pattern,
          url_count: t.urlCount,
          suggested_sample: t.suggestedSample,
          candidates: t.candidates,
          ...(t.sampled_urls ? { sampled_urls: t.sampled_urls } : {}),
          auditable: t.auditable,
          ...(t.reason ? { reason: t.reason } : {}),
          ...(t.recommendation ? { recommendation: t.recommendation } : {}),
        })),
        coverage: {
          templates_total: planned.length,
          templates_sampled: sampled.length,
          templates_deferred: deferred.length,
          urls_represented: urlsCovered,
          urls_total: onOrigin.length,
          represented_pct: Math.round((urlsCovered / onOrigin.length) * 100),
        },
        estimate: {
          urls_sampled: sampledUrls,
          runs,
          wall_clock_minutes: Math.max(1, Math.round((runs * SECONDS_PER_RUN) / 60)),
          quota_used: runs,
          quota_limit: key ? DAILY_QUOTA_WITH_KEY : KEYLESS_RUN_CAP,
        },
        questions: buildQuestions(sampled, gated, deferred, runs, runsPerUrl, Boolean(key), truncated),
        next_step:
          "Show the templates and questions to the user. Once they confirm " +
          "the sample, call run_performance_audit with the approved pages.",
        warnings,
      };

      return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
    },
  );
}
