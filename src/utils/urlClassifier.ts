import { isSessionGated } from "./publicUrl.js";

/**
 * Cluster a URL list into page templates.
 *
 * A performance audit's unit of analysis is the template, not the URL. Nobody
 * needs 3,904 product pages measured; they need to know what a product page
 * costs. The manual Five Below audit was organised exactly this way — Homepage,
 * PLP (category), PLP (subcategory), PLP (paginated), PDP, Cart, Search,
 * Info — with representative URLs sampled per template, and this reproduces
 * that structure automatically instead of asking someone to hand-write the
 * list.
 *
 * The clustering is a heuristic and will occasionally be wrong. That is
 * acceptable because the plan tool shows its work and the user approves the
 * sample before any PSI call is spent: a misclassification costs a
 * conversation turn, not quota.
 */

export interface UrlTemplate {
  id: string;
  label: string;
  /** Path shape with high-cardinality segments collapsed, e.g. "/categories/*". */
  pattern: string;
  urlCount: number;
  /** How many URLs to audit, given the population size. */
  suggestedSample: number;
  /** Representative URLs, most-canonical first. */
  candidates: string[];
  auditable: boolean;
  reason?: string;
  recommendation?: string;
  /**
   * True when *any* URL in the template is session-gated — computed over the
   * whole group, not the sampled candidates. Deciding this from candidates made
   * the verdict depend on which URLs the sampler happened to pick, so a
   * template containing /cart could pass as auditable purely by luck.
   */
  anySessionGated: boolean;
}

interface ParsedUrl {
  raw: string;
  segments: string[];
  querySig: string;
}

/**
 * Query parameters that identify the visitor or the campaign rather than the
 * page. Left in, they would split one template into dozens of "shapes" that
 * all render identically.
 */
const TRACKING_PARAMS = /^(utm_|gclid|fbclid|msclkid|mc_cid|mc_eid|_ga|igshid|srsltid|ref|referrer|source|cmpid|campaign)/i;

/**
 * A segment position needs at least this many distinct values to be wildcarded.
 * Two siblings are as likely to be two distinct pages as one template with two
 * instances, so the floor is three.
 */
const WILDCARD_DISTINCT = 3;

/**
 * The signal that separates an identifier from a section name: **fan-out**.
 *
 * Cardinality alone does not work, and getting this wrong is visible on real
 * sites. On nodejs.org, "/en/{blog,download,learn,about}" has only a handful of
 * distinct values, so a pure count threshold wildcarded it and merged 1,054
 * blog posts, download pages and API docs into one meaningless "/en/*\/*\/*"
 * template.
 *
 * A section name is shared by many URLs (blog → 900 pages); an identifier
 * belongs to one (v04.3 → 1 page). So a segment is a wildcard when its values
 * each account for very few URLs, and stays literal when each value heads a
 * substantial subtree — regardless of how many there are.
 */
const MAX_MEAN_FANOUT = 2.5;
/**
 * The first path segment is the site's own taxonomy — "categories", "products",
 * "info" — and collapsing it produces the useless pattern "/*". It only gets
 * wildcarded on a clear id explosion.
 */
const WILDCARD_DISTINCT_ROOT = 20;

const ID_LIKE = /^(\d+|[0-9a-f]{8,}|[0-9a-f-]{16,}|p\d+|sku[-_]?\w+)$/i;

/**
 * Route vocabulary — segments that name a *kind* of page, never an instance.
 *
 * Fan-out alone misreads these on a small URL list. Given eight URLs under
 * /ecommerce/, the segments {page, product, cart, checkout, my-account} average
 * 1.6 URLs each, which looks exactly like a set of identifiers — so the
 * classifier collapsed paginated listings and product detail pages into one
 * "/ecommerce/*\/*" template and proposed sampling them as if they were the
 * same page type. On the full inventory the fan-out for "product" would be
 * large and the heuristic would work, but a plan should not be wrong just
 * because the input list is short.
 */
const ROUTE_WORDS = new Set([
  "page", "pages", "product", "products", "category", "categories", "collection",
  "collections", "cart", "basket", "checkout", "account", "my-account", "login",
  "signin", "register", "search", "tag", "tags", "author", "feed", "blog", "news",
  "article", "articles", "post", "posts", "info", "about", "help", "support",
  "shop", "store", "browse", "dept", "department", "item", "items", "sku",
]);

/**
 * A content slug: hyphenated and long enough to be a title rather than a route.
 * "adrienne-trek-jacket" is an instance; "my-account" is a route.
 */
function looksLikeSlug(value: string): boolean {
  if (!value.includes("-")) return false;
  const words = value.split("-").length;
  return value.length >= 14 || words >= 3;
}

function parseUrl(raw: string): ParsedUrl | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const segments = url.pathname.split("/").filter(Boolean);
  const keys = [...url.searchParams.keys()]
    .filter((k) => !TRACKING_PARAMS.test(k))
    .map((k) => k.toLowerCase())
    .sort();
  return { raw, segments, querySig: [...new Set(keys)].join("&") };
}

/**
 * Wildcard a segment when its values are identifiers rather than taxonomy.
 * Cardinality alone is the main signal; an id-shaped majority is enough on its
 * own, since "/p/12345" and "/p/12346" are the same page template even when
 * only two exist.
 */
function shouldWildcard(depth: number, values: string[]): boolean {
  const distinct = new Set(values);
  if (distinct.size < 2) return false;

  // Numeric, hash-shaped and long-slug values are identifiers whatever their
  // fan-out; route vocabulary never is.
  const values_ = [...distinct].map((v) => v.toLowerCase());
  const idLike = values_.filter((v) => ID_LIKE.test(v) || looksLikeSlug(v)).length;
  if (idLike / distinct.size > 0.6) return true;
  if (values_.every((v) => ROUTE_WORDS.has(v))) return false;

  if (depth === 0 && distinct.size < WILDCARD_DISTINCT_ROOT) return false;
  if (distinct.size < WILDCARD_DISTINCT) return false;

  return values.length / distinct.size <= MAX_MEAN_FANOUT;
}

/**
 * Recursive descent over path segments.
 *
 * At each depth, URLs that end here form their own pattern, and the rest are
 * grouped by their next segment — wildcarded together when that segment looks
 * like an identifier, kept apart when it looks like a section name. Recursion
 * (rather than one global pass per depth) is what keeps "/categories/*" and
 * "/products/*" separate instead of collapsing both into "/*\/*".
 */
function descend(
  urls: ParsedUrl[],
  depth: number,
  prefix: string[],
  out: Map<string, ParsedUrl[]>,
): void {
  const terminal = urls.filter((u) => u.segments.length === depth);
  const deeper = urls.filter((u) => u.segments.length > depth);

  if (terminal.length > 0) {
    const key = "/" + prefix.join("/");
    for (const u of terminal) {
      const full = u.querySig ? `${key}?${u.querySig}` : key;
      const bucket = out.get(full);
      if (bucket) bucket.push(u);
      else out.set(full, [u]);
    }
  }

  if (deeper.length === 0) return;

  if (shouldWildcard(depth, deeper.map((u) => u.segments[depth]))) {
    descend(deeper, depth + 1, [...prefix, "*"], out);
    return;
  }

  const groups = new Map<string, ParsedUrl[]>();
  for (const u of deeper) {
    const token = u.segments[depth];
    const bucket = groups.get(token);
    if (bucket) bucket.push(u);
    else groups.set(token, [u]);
  }
  for (const [token, group] of groups) {
    descend(group, depth + 1, [...prefix, token], out);
  }
}

/**
 * Human labels for common commerce and content shapes.
 *
 * Deliberately conservative: an unrecognised pattern is labelled by its path
 * rather than guessed at, because a wrong label in an executive report is
 * worse than a literal one.
 */
function labelFor(pattern: string): string {
  const [path, query] = pattern.split("?");
  const p = path.toLowerCase();
  const depth = path.split("/").filter(Boolean).length;
  const wildcards = (path.match(/\*/g) ?? []).length;
  const paginated = query ? ` (${query.includes("p") || query.includes("page") ? "paginated" : "filtered"})` : "";

  if (path === "/") return "Homepage";
  if (/(^|\/)(cart|basket|bag)(\/|$)/.test(p)) return "Cart";
  if (/(^|\/)(checkout|payment)(\/|$)/.test(p)) return "Checkout";
  if (/(^|\/)(search|s|find)(\/|$)/.test(p)) return "Search results";
  if (/(^|\/)(store-locator|stores|locations|find-a-store)(\/|$)/.test(p)) return "Store locator";
  if (/(^|\/)(account|my-account|profile|orders|wishlist)(\/|$)/.test(p)) return "Account";
  if (/(^|\/)(login|signin|sign-in|register|signup)(\/|$)/.test(p)) return "Login / register";
  if (/(^|\/)(product|products|p|item|items|sku|dp)(\/|$)/.test(p)) return `PDP (product)${paginated}`;
  if (/(^|\/)(blog|news|articles|stories|posts)(\/|$)/.test(p)) return `Content / article${paginated}`;
  if (/(^|\/)(info|about|help|faq|support|legal|privacy|terms|policies|customer-service)(\/|$)/.test(p))
    return `Info / static${paginated}`;
  if (/(^|\/)(categories|category|c|collections|shop|browse|dept|department)(\/|$)/.test(p)) {
    const kind = wildcards >= 2 ? "subcategory" : "category";
    return `PLP (${kind})${paginated}`;
  }
  if (wildcards > 0 && depth <= 2) return `Listing${paginated}`;
  return `${path}${paginated}`;
}

/**
 * Sample size by population.
 *
 * Three is the ceiling because PSI is slow and quota is finite, and because
 * variance between pages of one template is usually smaller than variance
 * between templates — a fourth PDP tells you much less than a first Cart.
 */
function suggestSample(population: number): number {
  if (population <= 1) return 1;
  if (population <= 5) return 2;
  return 3;
}

/**
 * Representatives, chosen for spread rather than at random.
 *
 * Shortest first: it is usually the canonical, most-linked instance of the
 * template. Then the longest and a middle one, because URL length correlates
 * with depth and with how much content the page carries, and a template's
 * worst page is more often its longest.
 */
function pickCandidates(urls: string[], count: number): string[] {
  const sorted = [...urls].sort((a, b) => a.length - b.length || a.localeCompare(b));
  if (sorted.length <= count) return sorted;
  const picks = [sorted[0]];
  if (count >= 2) picks.push(sorted[sorted.length - 1]);
  if (count >= 3) picks.push(sorted[Math.floor(sorted.length / 2)]);
  for (let i = 1; picks.length < count && i < sorted.length; i++) {
    if (!picks.includes(sorted[i])) picks.push(sorted[i]);
  }
  return picks.slice(0, count);
}

function slugify(pattern: string): string {
  return (
    pattern
      .replace(/[?&=]/g, "-")
      .replace(/\*/g, "wild")
      .replace(/[^a-z0-9]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase() || "root"
  );
}

export interface ClassifyOptions {
  /** Patterns matching fewer URLs than this are folded into "Other". */
  minTemplateSize?: number;
}

export function classifyUrls(
  rawUrls: string[],
  options: ClassifyOptions = {},
): { templates: UrlTemplate[]; skipped: number } {
  const { minTemplateSize = 1 } = options;

  const parsed: ParsedUrl[] = [];
  let skipped = 0;
  for (const raw of rawUrls) {
    const p = parseUrl(raw);
    if (p) parsed.push(p);
    else skipped++;
  }

  const buckets = new Map<string, ParsedUrl[]>();
  descend(parsed, 0, [], buckets);

  const templates: UrlTemplate[] = [];
  for (const [pattern, group] of buckets) {
    if (group.length < minTemplateSize) continue;
    const urls = group.map((g) => g.raw);
    const suggested = suggestSample(urls.length);
    templates.push({
      id: slugify(pattern),
      label: labelFor(pattern),
      pattern,
      urlCount: urls.length,
      suggestedSample: suggested,
      candidates: pickCandidates(urls, suggested),
      auditable: true,
      anySessionGated: urls.some(isSessionGated),
    });
  }

  // Biggest templates first: a reader scanning the plan should see the shapes
  // that dominate the site before the long tail of one-off pages.
  templates.sort((a, b) => b.urlCount - a.urlCount || a.pattern.localeCompare(b.pattern));
  return { templates, skipped };
}
