/**
 * Whether PSI can reach a URL at all.
 *
 * PSI fetches the target from Google's own infrastructure, so "can I open this
 * in my browser" is not the test — the page has to be reachable from the
 * public internet. Localhost and RFC1918 addresses are not degraded cases that
 * return partial data; they cannot be audited, full stop, and the only useful
 * response is to say so before spending a request finding out.
 */

export type ReachVerdict = "public" | "loopback" | "private" | "non_http" | "malformed";

export interface ReachResult {
  verdict: ReachVerdict;
  auditable: boolean;
  reason?: string;
}

/** IPv4 in a private or link-local range, per RFC1918 / RFC3927. */
function isPrivateIPv4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  const [a, b] = parts.map(Number);
  if (parts.some((p) => !/^\d+$/.test(p)) || [a, b].some(Number.isNaN)) return false;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true; // link-local
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

function isLoopback(host: string): boolean {
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1" || host === "[::1]") return true;
  return /^127\./.test(host);
}

/**
 * Hostnames that never resolve on the public internet. `.local` is mDNS,
 * `.internal` and `.test`/`.invalid` are reserved, and a bare hostname with no
 * dot is a LAN name.
 */
function isNonPublicName(host: string): boolean {
  if (/\.(local|internal|localdomain|test|invalid|example)$/.test(host)) return true;
  return !host.includes(".") && !/^\d+$/.test(host);
}

export function checkPublicReachability(rawUrl: string): ReachResult {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { verdict: "malformed", auditable: false, reason: `"${rawUrl}" is not a valid URL.` };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return {
      verdict: "non_http",
      auditable: false,
      reason: `PSI only audits http(s) URLs; got "${url.protocol}".`,
    };
  }

  const host = url.hostname.toLowerCase();

  if (isLoopback(host)) {
    return {
      verdict: "loopback",
      auditable: false,
      reason:
        "PSI fetches pages from Google's infrastructure, so it cannot reach " +
        "localhost. Use run_lighthouse, which runs Chrome on this machine.",
    };
  }
  if (isPrivateIPv4(host)) {
    return {
      verdict: "private",
      auditable: false,
      reason:
        `${host} is a private-network address and is not reachable from ` +
        "Google's infrastructure. Use run_lighthouse for internal hosts.",
    };
  }
  if (isNonPublicName(host)) {
    return {
      verdict: "private",
      auditable: false,
      reason:
        `"${host}" is not a publicly resolvable hostname. Use run_lighthouse ` +
        "for hosts that only resolve on your network.",
    };
  }

  return { verdict: "public", auditable: true };
}

/**
 * Paths that PSI can fetch but cannot meaningfully audit, because an anonymous
 * request does not see the real page.
 *
 * PSI has no session: it audits an empty cart, a redirect to a login form, or
 * a search page with no query, and reports the result as if it were the page
 * someone asked about. A confidently wrong number is worse than a gap, so
 * these are flagged rather than run. `run_lighthouse` can carry cookies and is
 * the right tool for them.
 */
const SESSION_GATED = [
  /(^|\/)(cart|basket|bag)(\/|$)/,
  /(^|\/)(checkout|payment|order-confirmation)(\/|$)/,
  /(^|\/)(account|my-account|profile|dashboard|orders)(\/|$)/,
  /(^|\/)(login|signin|sign-in|register|signup|sign-up|logout)(\/|$)/,
  /(^|\/)(wishlist|favorites|favourites|saved)(\/|$)/,
];

export function isSessionGated(rawUrl: string): boolean {
  try {
    const path = new URL(rawUrl).pathname.toLowerCase();
    return SESSION_GATED.some((re) => re.test(path));
  } catch {
    return false;
  }
}
