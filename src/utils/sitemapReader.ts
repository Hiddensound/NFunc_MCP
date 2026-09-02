/**
 * Sitemap discovery.
 *
 * The cheapest honest way to learn which pages a site has. A sitemap is
 * authoritative (the site published it), instant (one or two requests), and
 * needs no crawling, no robots.txt politeness budget and no HTML parsing. A
 * crawler is the fallback for sites without one, and is deliberately not built
 * yet — everything downstream works without it.
 *
 * Sitemaps are parsed with regular expressions rather than an XML library.
 * That is normally a mistake, but a sitemap is a machine-generated document
 * with a fixed two-element vocabulary, and the alternative is a dependency
 * carried by every install of this server for one code path. The parser reads
 * <loc> only and ignores everything else, so malformed markup degrades to
 * fewer URLs rather than to wrong ones.
 */

import { gunzipSync } from "node:zlib";

import { httpGet } from "./httpClient.js";

export interface SitemapResult {
  urls: string[];
  /** Every sitemap document actually fetched, in order. */
  sitemapsRead: string[];
  /** True when a cap stopped the walk early — the URL list is a subset. */
  truncated: boolean;
  /** Every location tried, so a failure can say what was ruled out. */
  attempted: string[];
  warnings: string[];
}

/** A sitemap index can point at hundreds of children; walking all of them is rarely worth it. */
const MAX_SITEMAPS = 25;
const MAX_URLS = 50_000;
const FETCH_TIMEOUT_MS = 20_000;

const LOC_RE = /<loc>\s*([^<\s][^<]*?)\s*<\/loc>/gi;

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCharCode(Number(d)))
    // Ampersand last, so "&amp;lt;" does not become "<".
    .replace(/&amp;/g, "&");
}

function extractLocs(xml: string): string[] {
  const out: string[] = [];
  for (const match of xml.matchAll(LOC_RE)) {
    const loc = decodeXmlEntities(match[1].trim());
    if (loc) out.push(loc);
  }
  return out;
}

/** A <sitemapindex> points at more sitemaps; a <urlset> holds pages. */
function isSitemapIndex(xml: string): boolean {
  return /<sitemapindex[\s>]/i.test(xml);
}

/**
 * Sitemap locations declared in robots.txt.
 *
 * Large sites frequently do not serve /sitemap.xml and only announce the real
 * location here, so checking robots first turns a "no sitemap found" dead end
 * into a hit. It is also the polite thing to read before touching a site.
 */
async function sitemapsFromRobots(origin: string): Promise<string[]> {
  const robotsUrl = new URL("/robots.txt", origin).toString();
  const result = await httpGet(robotsUrl, { timeoutMs: 10_000, retries: 1 });
  if (!result.ok) return [];
  const found: string[] = [];
  for (const line of result.body.split(/\r?\n/)) {
    const match = /^\s*sitemap:\s*(\S+)/i.exec(line);
    if (match) found.push(match[1]);
  }
  return found;
}

/**
 * Non-HTML entries a performance audit should never spend a PSI call on.
 * Image and video sitemaps are common and would otherwise fill the sample.
 */
function looksAuditable(url: string): boolean {
  return !/\.(jpe?g|png|gif|webp|avif|svg|ico|pdf|zip|gz|mp4|webm|mp3|xml|json|txt|css|js)(\?|$)/i.test(
    url,
  );
}

/**
 * Sitemap locations worth guessing, beyond the two standard ones.
 *
 * Ordered by how often they pay off. These only run when the standard
 * locations and robots.txt have produced nothing, so the common case still
 * costs one or two requests — a 404 from Google's edge is cheap, but seven of
 * them on every audit would not be.
 */
const CANDIDATE_PATHS = [
  "/sitemap-index.xml",
  "/sitemap/sitemap.xml",
  "/sitemap/index.xml",
  "/wp-sitemap.xml",        // WordPress 5.5+
  "/sitemap_index.xml.gz",
  "/sitemap1.xml",
  "/sitemap.txt",           // plain text, one URL per line
];

/**
 * `<link rel="sitemap">` in the homepage head.
 *
 * Rare but authoritative when present, and it costs one request we can often
 * justify anyway. Only consulted after the cheaper guesses fail.
 */
async function sitemapFromHomepageLink(origin: string): Promise<string[]> {
  const result = await httpGet(origin, { timeoutMs: 15_000, retries: 0 });
  if (!result.ok) return [];
  const found: string[] = [];
  for (const match of result.body.matchAll(/<link\b[^>]*>/gi)) {
    const tag = match[0];
    if (!/rel=["']?sitemap["']?/i.test(tag)) continue;
    const href = /href=["']([^"']+)["']/i.exec(tag)?.[1];
    if (href) {
      try {
        found.push(new URL(href, origin).toString());
      } catch {
        // Unparseable href — ignore rather than fail discovery over it.
      }
    }
  }
  return found;
}

/**
 * A sitemap.txt is a bare newline-delimited URL list, not XML. Detected by
 * content rather than extension, because servers are inconsistent about both.
 */
function isPlainTextSitemap(body: string): boolean {
  const head = body.trimStart().slice(0, 200);
  return !head.startsWith("<") && /^https?:\/\//im.test(head);
}

function extractPlainTextUrls(body: string): string[] {
  return body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^https?:\/\//i.test(line));
}

export async function readSitemap(origin: string): Promise<SitemapResult> {
  const warnings: string[] = [];
  const sitemapsRead: string[] = [];
  const attempted: string[] = [];
  const urls = new Set<string>();
  const seen = new Set<string>();
  let truncated = false;

  /**
   * Tiers, cheapest and most authoritative first. Each is tried only if every
   * earlier one came up empty, so a site that declares its sitemap properly
   * still costs two requests while a site that hides it gets a real search.
   */
  const declared = await sitemapsFromRobots(origin);
  const tiers: Array<{ name: string; locations: () => Promise<string[]> }> = [
    { name: "robots.txt", locations: async () => declared },
    {
      name: "standard locations",
      locations: async () => [
        new URL("/sitemap.xml", origin).toString(),
        new URL("/sitemap_index.xml", origin).toString(),
      ],
    },
    { name: "homepage <link rel=sitemap>", locations: () => sitemapFromHomepageLink(origin) },
    {
      name: "common CMS locations",
      locations: async () => CANDIDATE_PATHS.map((path) => new URL(path, origin).toString()),
    },
  ];

  for (const tier of tiers) {
    // Stop on the first tier that finds a sitemap *document*, not the first
    // that yields URLs. web.dev serves a valid index whose children time out;
    // falling through on an empty result sent discovery guessing at nine more
    // locations for 43s when the sitemap had already been located.
    if (sitemapsRead.length > 0) break;

    const queue = await tier.locations();
    let consecutiveFailures = 0;
    while (queue.length > 0) {
      if (sitemapsRead.length >= MAX_SITEMAPS || urls.size >= MAX_URLS) {
        truncated = true;
        break;
      }

      const next = queue.shift() as string;
      if (seen.has(next)) continue;
      seen.add(next);
      attempted.push(next);

      // Large sites commonly serve .xml.gz. It arrives as an opaque gzip payload
      // rather than with Content-Encoding, so fetch does not inflate it and a
      // text read produces binary noise — hence the explicit binary path.
      const gzipped = /\.gz(\?|$)/i.test(next);
      // No retry: discovery must stay fast, and a sitemap that times out once
      // usually times out again. Retrying doubled the cost of the slow case
      // for no observed benefit.
      const result = await httpGet(next, {
        timeoutMs: FETCH_TIMEOUT_MS,
        retries: 0,
        raw: gzipped,
      });
      if (!result.ok) {
        // A 404 or 403 on a guessed location is the expected answer to "is it
        // here?" — cheap, informative, and no reason to stop guessing. Only
        // expensive failures (timeouts, 5xx) count toward giving up.
        if (result.status === 404 || result.status === 403) continue;

        consecutiveFailures++;
        // A sitemap index can list hundreds of children. If the first few all
        // time out, the rest almost certainly will too, at a full timeout each.
        if (consecutiveFailures >= 3) {
          warnings.push(
            `Gave up on ${tier.name} after ${consecutiveFailures} consecutive failures ` +
              `(last: ${result.error ?? `HTTP ${result.status}`}).`,
          );
          break;
        }
        warnings.push(`Could not read ${next}: ${result.error ?? `HTTP ${result.status}`}`);
        continue;
      }
      consecutiveFailures = 0;

      let body = result.body;
      if (gzipped) {
        try {
          body = gunzipSync(Buffer.from(result.bytes ?? new Uint8Array())).toString("utf8");
        } catch (err) {
          warnings.push(`Could not decompress ${next}: ${(err as Error).message}`);
          continue;
        }
      }

      if (isPlainTextSitemap(body)) {
        const plain = extractPlainTextUrls(body).filter(looksAuditable);
        if (plain.length === 0) continue;
        sitemapsRead.push(next);
        for (const loc of plain) {
          if (urls.size >= MAX_URLS) {
            truncated = true;
            break;
          }
          urls.add(loc);
        }
        continue;
      }

      const locs = extractLocs(body);
      if (locs.length === 0) continue;
      sitemapsRead.push(next);

      if (isSitemapIndex(body)) {
        for (const child of locs) if (!seen.has(child)) queue.push(child);
        continue;
      }

      for (const loc of locs) {
        if (urls.size >= MAX_URLS) {
          truncated = true;
          break;
        }
        if (looksAuditable(loc)) urls.add(loc);
      }
    }
  }

  if (sitemapsRead.length > 0 && urls.size === 0) {
    warnings.push(
      `Found a sitemap at ${sitemapsRead[0]} but could not extract any URLs from it — ` +
        `its child documents failed to load or contained no page entries. Supply URLs ` +
        `with discovery:"list" or discovery:"csv".`,
    );
  }

  if (sitemapsRead.length === 0) {
    warnings.push(
      `No sitemap found for ${origin}. Tried ${attempted.length} location(s): ` +
        `robots.txt, the standard paths, the homepage <link rel="sitemap">, and ` +
        `common CMS locations. ` +
        `Supply URLs directly with discovery:"list", or point at a CSV export with ` +
        `discovery:"csv" — an analytics top-pages export is the better input for a ` +
        `performance audit anyway, since it is weighted by real traffic.`,
    );
  }
  if (truncated) {
    warnings.push(
      `Stopped after ${sitemapsRead.length} sitemap documents and ${urls.size} URLs. ` +
        `The template breakdown below is based on that subset.`,
    );
  }

  return { urls: [...urls], sitemapsRead, truncated, attempted, warnings };
}
