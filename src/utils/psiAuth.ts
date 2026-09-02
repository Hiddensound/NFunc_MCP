/**
 * PSI API key resolution.
 *
 * Precedence: explicit tool input → PAGESPEED_API_KEY → keyless.
 *
 * The preferred setup is the `env` block in the MCP client config, because the
 * client launches this server and we do not control its flags — `--env-file`
 * is not available to us. An explicit input is supported for people who want
 * to paste a key once, but it is the worst option: it lands in the
 * conversation transcript and in any client-side logging, so it is never
 * echoed back and every error that touches a request URL is redacted.
 */

export type KeySource = "input" | "env" | "none";

export interface ResolvedKey {
  key: string | null;
  source: KeySource;
}

export const KEY_ENV_VAR = "PAGESPEED_API_KEY";

/**
 * Keyless PSI is rate-limited hard enough that a batch will 429 partway
 * through, leaving a half-finished audit and a confusing error. Refusing up
 * front with instructions is a better failure than discovering it at run 12.
 */
export const KEYLESS_RUN_CAP = 4;

export function resolveApiKey(explicit?: string): ResolvedKey {
  const trimmed = explicit?.trim();
  if (trimmed) return { key: trimmed, source: "input" };

  const fromEnv = process.env[KEY_ENV_VAR]?.trim();
  if (fromEnv) return { key: fromEnv, source: "env" };

  return { key: null, source: "none" };
}

export function keylessWarning(runs: number): string {
  return (
    `No ${KEY_ENV_VAR} set — running unauthenticated against a shared, ` +
    `heavily rate-limited quota. This is fine for ${KEYLESS_RUN_CAP} runs or ` +
    `fewer; ${runs} runs will almost certainly hit HTTP 429 partway through. ` +
    `Get a key from the Google Cloud console (enable the PageSpeed Insights ` +
    `API) and set ${KEY_ENV_VAR} in your MCP client config.`
  );
}
