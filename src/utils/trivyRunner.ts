import { runShell, type ShellResult } from "./shellRunner.js";

/**
 * Trivy invocation, kept in one place for the same reason `eslintRunner` is:
 * the flags carry decisions, and those decisions have to hold everywhere the
 * scanner is called from — the standalone tool now, the release gate later.
 */

export type TrivyScanner = "vuln" | "secret" | "misconfig" | "license";

/**
 * Licence scanning is off by default and stays opt-in.
 *
 * A GPL transitive dependency is a legal call with commercial consequences,
 * not a bug a QA engineer closes, so it does not belong in a default QA scan
 * and never contributes to a release verdict.
 *
 * Misconfig, by contrast, is on. Trivy's own default for `trivy filesystem` is
 * `vuln,secret` — IaC scanning simply does not run unless asked for, which is
 * a quiet way to ship a security tool that never looks at the Dockerfile.
 */
export const DEFAULT_SCANNERS: TrivyScanner[] = ["vuln", "secret", "misconfig"];

/**
 * Five minutes, matching Trivy's own `--timeout` default rather than the 60s
 * shellRunner default or the 180s Semgrep uses.
 *
 * A cold first run downloads the vulnerability database before it scans
 * anything — from mirror.gcr.io, falling back to ghcr.io — and that download
 * alone can outlast a 60s budget on a slow link. The tool documents
 * `trivy fs --download-db-only` as a one-time setup step so this ceiling is
 * only ever reached once.
 */
export const TRIVY_TIMEOUT_MS = 300_000;

/**
 * Trivy's JSON carries a full package inventory alongside the findings —
 * `--list-all-pkgs` defaults to true and the direct/indirect join depends on
 * it — so stdout is proportional to the size of the tree rather than to the
 * number of findings. Raised well above execa's default; if a monorepo ever
 * exceeds even this, the fallback is `--output <tmpfile>` and a read from disk.
 */
const TRIVY_MAX_BUFFER = 256 * 1024 * 1024;

export interface TrivyRun {
  /** True when Trivy produced parseable-looking output. */
  ran: boolean;
  stdout: string;
  warnings: string[];
  durationMs: number;
}

/**
 * Neither Homebrew nor npm is universal here. Trivy is a Go binary, unlike
 * every other CLI this server wraps except Semgrep, so the "not installed"
 * message has to name a command the user can actually run.
 */
export function trivyInstallHint(): string {
  if (process.platform === "darwin") return "brew install trivy";
  if (process.platform === "win32") return "choco install trivy";
  return "see https://trivy.dev/latest/getting-started/installation/ for apt/yum/apk packages";
}

/**
 * Same shape as `isSemgrepNotInstalled`: execa reports a spawn failure as exit
 * code -1 with nothing on either stream.
 */
export function isTrivyNotInstalled(result: ShellResult): boolean {
  if (result.exitCode !== -1) return false;
  if (!result.stderr && !result.stdout) return true;
  return (
    result.stderr.includes("ENOENT") ||
    result.stderr.includes("not found") ||
    result.stderr.includes("command not found") ||
    result.stderr.includes("No such file")
  );
}

/**
 * Database trouble is a warning, never a failure.
 *
 * The registries Trivy pulls from rate-limit, and it falls back between them
 * on 429 and 5xx — but a cold start behind an exhausted quota still fails. A
 * secret scan and an IaC scan need no database at all, so a DB problem should
 * cost the caller the vulnerability class, not the whole report.
 */
function describeDbProblem(stderr: string): string | null {
  const haystack = stderr.toLowerCase();
  const markers = [
    "toomanyrequests",
    "429",
    "failed to download vulnerability db",
    "failed to download db",
    "unable to initialize the db",
    "database is in use",
    "db update failed",
  ];
  if (!markers.some((m) => haystack.includes(m))) return null;
  return (
    "Trivy could not update its vulnerability database — dependency findings may be " +
    "incomplete or missing. Run `trivy fs --download-db-only` once on a good connection, " +
    "then re-run. Secret and misconfiguration findings are unaffected."
  );
}

function buildArgs(
  scanners: TrivyScanner[],
  options: { minSeverity?: string; skipDirs?: string[] },
): string[] {
  const args = [
    "filesystem",
    // Always explicit. Trivy's default omits misconfig entirely, and a default
    // that silently narrows coverage is worse than a verbose command line.
    `--scanners=${scanners.join(",")}`,
    "--format=json",
    // Suppresses the progress bar, which would otherwise interleave with the
    // stderr we inspect for database problems.
    "--quiet",
    `--timeout=${Math.floor(TRIVY_TIMEOUT_MS / 1000)}s`,
    // Without this Trivy omits devDependencies from npm lockfiles entirely —
    // confirmed against 0.74.0, where lodash pinned as a devDependency
    // produced no package entry and no findings at all until the flag was
    // added. The priority model demotes dev findings one tier rather than
    // hiding them: the code does not ship, but it does run on developer
    // machines and in CI, which is where a build-time compromise starts.
    "--include-dev-deps",
  ];

  // Never --exit-code. Trivy returns 1 both for "issues found" and for its own
  // internal errors, so setting it makes the two indistinguishable; success is
  // determined by whether stdout parses instead. Never --ignore-unfixed
  // either: unfixable CVEs are the ones that need a mitigation decision, and
  // suppressing them means the decision never gets made.

  if (options.minSeverity) args.push(`--severity=${options.minSeverity}`);
  for (const dir of options.skipDirs ?? []) args.push(`--skip-dirs=${dir}`);

  args.push(".");
  return args;
}

export async function runTrivyFs(
  absPath: string,
  scanners: TrivyScanner[],
  options: { minSeverity?: string; skipDirs?: string[] } = {},
): Promise<TrivyRun> {
  const result = await runShell("trivy", buildArgs(scanners, options), {
    timeoutMs: TRIVY_TIMEOUT_MS,
    cwd: absPath,
    maxBuffer: TRIVY_MAX_BUFFER,
  });

  const warnings: string[] = [];

  if (isTrivyNotInstalled(result)) {
    return {
      ran: false,
      stdout: "",
      warnings: [
        `Trivy is not installed or not found in PATH — skipping security scan. Install with: ${trivyInstallHint()}`,
      ],
      durationMs: result.durationMs,
    };
  }

  const dbProblem = describeDbProblem(result.stderr);
  if (dbProblem) warnings.push(dbProblem);

  if (!result.stdout) {
    warnings.push(
      `Trivy produced no output (exit ${result.exitCode}): ${result.stderr.slice(0, 400)}`,
    );
    return { ran: false, stdout: "", warnings, durationMs: result.durationMs };
  }

  return { ran: true, stdout: result.stdout, warnings, durationMs: result.durationMs };
}

/**
 * Database build date, read from `trivy version`.
 *
 * A security report is only as current as the database behind it, and unlike a
 * stale Lighthouse run — which is merely old — a stale vulnerability database
 * produces a clean report that is actively misleading. The scan JSON does not
 * carry this, so it costs a second call; the call needs no database and no
 * network, so it is cheap and safe to run alongside the scan.
 *
 * Returns null rather than warning when it cannot be read. The field is
 * supporting context, and a Trivy version that reports it differently should
 * not turn into noise on every scan.
 */
export async function readTrivyDbDate(): Promise<string | null> {
  const result = await runShell("trivy", ["version", "--format=json"], {
    timeoutMs: 15_000,
  });
  if (!result.stdout) return null;
  try {
    const parsed = JSON.parse(result.stdout) as {
      VulnerabilityDB?: { UpdatedAt?: string; DownloadedAt?: string };
    };
    return parsed.VulnerabilityDB?.UpdatedAt ?? parsed.VulnerabilityDB?.DownloadedAt ?? null;
  } catch {
    return null;
  }
}
