/**
 * HTTP counterpart to shellRunner.
 *
 * Every tool before this one reached the outside world by spawning a process,
 * so `runShell` was the single choke point for timeout, error and duration
 * handling. PSI is an HTTP API, and bending shellRunner around `curl` would
 * trade a typed response for string parsing. This mirrors shellRunner's
 * contract instead: never throws for a reachable-but-unhappy endpoint, always
 * reports duration, and leaves the decision about what counts as failure to
 * the caller.
 *
 * Node 18+ ships global fetch, so this adds no dependency.
 */

export interface HttpResult {
  /** True only for a 2xx. A 404 is a result, not an exception. */
  ok: boolean;
  /** 0 when the request never got a response (timeout, DNS, connection refused). */
  status: number;
  body: string;
  /** Raw response bytes. Populated only when `raw` was requested. */
  bytes?: Uint8Array;
  durationMs: number;
  /** Total attempts made, including the successful one. 1 means no retries. */
  attempts: number;
  /** Present only when `ok` is false. Always redacted. */
  error?: string;
}

export interface HttpRequestOptions {
  timeoutMs?: number;
  /** Extra attempts after the first. 0 disables retrying. */
  retries?: number;
  /** Base delay for exponential backoff; doubled each attempt. */
  retryDelayMs?: number;
  headers?: Record<string, string>;
  /**
   * Return bytes instead of decoded text. Needed for `.xml.gz` sitemaps, which
   * are served as an opaque gzip payload rather than with Content-Encoding, so
   * fetch does not inflate them and decoding to a string corrupts them.
   */
  raw?: boolean;
  /**
   * Absolute ceiling across every attempt, including backoff. Where `timeoutMs`
   * bounds one request, this bounds the whole call: each attempt is shortened
   * to whatever is left, and retrying stops when nothing is. Without it,
   * enabling `retryOnTimeout` silently doubles the worst case, which is exactly
   * how a chunked runner overruns its budget.
   */
  totalBudgetMs?: number;
  /**
   * Retry after a timeout. Off by default: a timeout means the request already
   * spent its entire budget, so retrying multiplies the wall clock by the
   * attempt count for a request that is unlikely to be faster next time. A 429
   * or 5xx is different — those fail fast and often succeed on retry.
   */
  retryOnTimeout?: boolean;
  /**
   * Literal strings to strip from every error message before it leaves this
   * module — API keys, tokens, anything that would otherwise reach a log, a
   * tool response, or a conversation transcript.
   */
  redact?: string[];
}

/**
 * Sites behind a bot wall reject the default Node fetch agent outright, which
 * turns a healthy site into a 403 and a sitemap into a "not found". Naming
 * ourselves honestly and looking like a browser gets through most of them;
 * a caller can override it via `headers`.
 */
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 nfunc-mcp/qa-audit";

/** Query parameters whose values are stripped before a URL is quoted anywhere. */
const SENSITIVE_PARAMS = new Set(["key", "api_key", "apikey", "token", "access_token"]);

/**
 * A URL safe to put in an error message.
 *
 * The PSI request URL carries the API key in the query string, so any error
 * that interpolates the URL leaks the key into the tool response — and from
 * there into the conversation transcript. Redacting at the point of formatting
 * rather than asking every call site to remember is the only version of this
 * that stays correct.
 */
export function sanitizeUrl(url: string | URL): string {
  try {
    const u = new URL(url);
    for (const param of u.searchParams.keys()) {
      if (SENSITIVE_PARAMS.has(param.toLowerCase())) {
        u.searchParams.set(param, "REDACTED");
      }
    }
    return u.toString();
  } catch {
    return "[unparseable url]";
  }
}

/**
 * Strip literal secret values out of a message before it is shown anywhere.
 *
 * `sanitizeUrl` handles the case where the key sits in a query parameter we
 * can name; this handles the rest — a key echoed back inside a provider's
 * error body, or a stack frame that captured it as an argument. Exported so
 * the bootstrap fatal handler can use it too, since that error is printed
 * before any of the request plumbing has had a chance to redact it.
 */
export function redactAll(message: string, secrets: string[]): string {
  let out = message;
  for (const secret of secrets) {
    // A short "secret" would redact half the message; a real key is far longer.
    if (secret && secret.length >= 8) out = out.split(secret).join("REDACTED");
  }
  return out;
}

/** Retry only what a retry can plausibly fix. A 400 will be a 400 next time too. */
function isRetryable(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/**
 * `Retry-After` is either a delay in seconds or an HTTP date. Google sends
 * seconds on 429s, but the date form is legal and cheap to support.
 */
function retryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return null;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function httpGet(
  url: string | URL,
  options: HttpRequestOptions = {},
): Promise<HttpResult> {
  const {
    timeoutMs = 60_000,
    retries = 2,
    retryDelayMs = 2_000,
    headers,
    raw = false,
    totalBudgetMs,
    retryOnTimeout = false,
    redact = [],
  } = options;

  const start = Date.now();
  const safeUrl = sanitizeUrl(url);
  let lastError = "";
  let lastStatus = 0;

  const deadline = totalBudgetMs === undefined ? null : start + totalBudgetMs;
  const remainingMs = (): number => (deadline === null ? Infinity : deadline - Date.now());

  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    const budgetLeft = remainingMs();
    if (budgetLeft <= 0) {
      lastError = lastError || `Request to ${safeUrl} ran out of time budget`;
      break;
    }

    try {
      const response = await fetch(url, {
        headers: { "user-agent": DEFAULT_USER_AGENT, ...headers },
        signal: AbortSignal.timeout(Math.min(timeoutMs, budgetLeft)),
      });
      lastStatus = response.status;

      if (response.ok) {
        const bytes = new Uint8Array(await response.arrayBuffer());
        return {
          ok: true,
          status: response.status,
          body: raw ? "" : new TextDecoder().decode(bytes),
          ...(raw ? { bytes } : {}),
          durationMs: Date.now() - start,
          attempts: attempt,
        };
      }

      // Read the body before deciding — a non-2xx from PSI carries a JSON
      // error object that says far more than the status code does.
      const body = await response.text().catch(() => "");
      lastError = `HTTP ${response.status} from ${safeUrl}${body ? `: ${body.slice(0, 300)}` : ""}`;

      if (!isRetryable(response.status) || attempt > retries) {
        return {
          ok: false,
          status: response.status,
          body,
          durationMs: Date.now() - start,
          attempts: attempt,
          error: redactAll(lastError, redact),
        };
      }

      const serverAsked = retryAfterMs(response.headers.get("retry-after"));
      const backoff = Math.min(serverAsked ?? retryDelayMs * 2 ** (attempt - 1), Math.max(0, remainingMs()));
      await sleep(backoff);
    } catch (err) {
      // Timeouts and network failures land here. AbortSignal.timeout raises a
      // TimeoutError, which reads as an unexplained abort unless named.
      const e = err as Error;
      const timedOut = e.name === "TimeoutError" || e.name === "AbortError";
      lastStatus = 0;
      lastError = timedOut
        ? `Request to ${safeUrl} timed out after ${timeoutMs} ms`
        : `Request to ${safeUrl} failed: ${e.message ?? "unknown network error"}`;

      if (timedOut && !retryOnTimeout) break;
      if (attempt > retries) break;
      await sleep(Math.min(retryDelayMs * 2 ** (attempt - 1), Math.max(0, remainingMs())));
    }
  }

  return {
    ok: false,
    status: lastStatus,
    body: "",
    durationMs: Date.now() - start,
    attempts: retries + 1,
    error: redactAll(lastError, redact),
  };
}

export interface HttpJsonResult<T> extends Omit<HttpResult, "body"> {
  data: T | null;
  /** Kept for error reporting; a caller that has `data` should not need it. */
  body: string;
}

/**
 * `httpGet` plus JSON parsing, with malformed JSON demoted to `ok: false`
 * rather than a thrown SyntaxError. A 200 carrying truncated JSON is a failed
 * request as far as every caller is concerned.
 */
export async function httpGetJson<T>(
  url: string | URL,
  options: HttpRequestOptions = {},
): Promise<HttpJsonResult<T>> {
  const result = await httpGet(url, options);
  if (!result.ok) return { ...result, data: null };

  try {
    return { ...result, data: JSON.parse(result.body) as T };
  } catch (err) {
    return {
      ...result,
      ok: false,
      data: null,
      error: redactAll(
        `Response from ${sanitizeUrl(url)} was not valid JSON: ${(err as Error).message}`,
        options.redact ?? [],
      ),
    };
  }
}
