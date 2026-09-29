import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runShell } from "../utils/shellRunner.js";
import {
  resolveBinary,
  resolveESLint,
  type BinarySource,
  type ResolvedBinary,
} from "../utils/binaryResolver.js";
import { readTrivyDbDate } from "../utils/trivyRunner.js";
import { notInstalled } from "../utils/unavailable.js";

/**
 * One call that answers "can this machine run every check?" before a gate is
 * trusted — OCS runs it at session start so a missing Semgrep or a month-old
 * Trivy database is reported once, up front, rather than as a quietly thinner
 * report later.
 */

/** Trivy refreshes its database every 24h when online; a week means it has not been. */
export const TRIVY_DB_STALE_DAYS = 7;

export interface DependencyStatus {
  tool: string;
  binary: string;
  found: boolean;
  version: string | null;
  /** null when the binary was not found anywhere. */
  source: BinarySource | null;
  /** What was spawned: an absolute path for project/bundled, the bare name for PATH. */
  path: string | null;
  install_hint: string;
  trivy_db_updated_at?: string | null;
  trivy_db_age_days?: number | null;
}

/** First x.y.z in the output — every one of these CLIs prints it differently. */
export function parseVersion(output: string): string | null {
  return output.match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/)?.[0] ?? null;
}

export function dbAgeDays(updatedAt: string | null, now: Date = new Date()): number | null {
  if (!updatedAt) return null;
  const t = Date.parse(updatedAt);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((now.getTime() - t) / 86_400_000));
}

async function probe(tool: string, resolved: ResolvedBinary, args: string[]): Promise<DependencyStatus> {
  const result = await runShell(resolved.command, args, {
    timeoutMs: 30_000,
    // Semgrep otherwise phones home for a version check on every invocation.
    env: { ...process.env, SEMGREP_ENABLE_VERSION_CHECK: "0" },
  });
  const found = result.exitCode === 0;
  return {
    tool,
    binary: tool,
    found,
    version: found ? parseVersion(`${result.stdout}\n${result.stderr}`) : null,
    source: found ? resolved.source : null,
    path: found ? resolved.command : null,
    install_hint: notInstalled(tool).install_hint,
  };
}

const inputShape = {
  path: z
    .string()
    .optional()
    .describe(
      "Optional project path. When given, a project-local ESLint (the project's own " +
        "node_modules/.bin) is reported, since that is the one run_static_analysis would use.",
    ),
};

export function registerCheckDependenciesTool(server: McpServer): void {
  server.registerTool(
    "check_dependencies",
    {
      description:
        "Reports whether each CLI the QA tools depend on — lighthouse, pa11y, eslint, semgrep, " +
        "trivy — is available, its version, and where it resolves from ('bundled' with this " +
        "package, 'project' for a project-local ESLint, or 'path'), with an install command for " +
        "anything missing. Also reports how old Trivy's vulnerability database is " +
        "(trivy_db_age_days) so a stale database is visible before a security scan relies on it. " +
        "Use it to diagnose UNAVAILABLE tools or before running a release gate.",
      inputSchema: inputShape,
    },
    async ({ path }) => {
      const [lighthouse, pa11y, eslint, semgrep, trivy, dbDate] = await Promise.all([
        probe("lighthouse", resolveBinary("lighthouse"), ["--version"]),
        probe("pa11y", resolveBinary("pa11y"), ["--version"]),
        probe("eslint", resolveESLint(path), ["--version"]),
        probe("semgrep", resolveBinary("semgrep"), ["--version"]),
        probe("trivy", resolveBinary("trivy"), ["--version"]),
        readTrivyDbDate(),
      ]);

      const age = trivy.found ? dbAgeDays(dbDate) : null;
      trivy.trivy_db_updated_at = trivy.found ? dbDate : null;
      trivy.trivy_db_age_days = age;

      const dependencies = [lighthouse, pa11y, eslint, semgrep, trivy];
      const warnings: string[] = [];
      for (const d of dependencies) {
        if (!d.found) warnings.push(`${d.tool} not found — ${d.install_hint}`);
      }
      if (trivy.found && dbDate === null) {
        warnings.push(
          "Trivy has no vulnerability database yet. Run `trivy fs --download-db-only` once on a good connection.",
        );
      } else if (age !== null && age > TRIVY_DB_STALE_DAYS) {
        warnings.push(
          `Trivy's vulnerability database is ${age} days old, so recent advisories are missing and a clean ` +
            "scan may be falsely clean. Run `trivy fs --download-db-only` to refresh it.",
        );
      }

      const payload = {
        node_version: process.version,
        all_found: dependencies.every((d) => d.found),
        dependencies,
        ...(warnings.length > 0 ? { warnings } : {}),
      };
      return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
    },
  );
}
