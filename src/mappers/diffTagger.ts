import { posix } from "node:path";
import type { Finding, Priority } from "../types.js";
import { toRelativePath } from "./findingId.js";

/**
 * `in_diff` tagging for file-based findings.
 *
 * Nothing is filtered. A pre-existing P1 is still a P1, and hiding it because
 * the current change did not introduce it is how a gate ends up green on a
 * tree with a committed credential in it. The tag lets the caller decide —
 * OCS blocks on in-diff P1s and reports the rest.
 *
 * URL findings (Lighthouse, pa11y) are never tagged: a rendered page has no
 * file to compare against the diff.
 */

/**
 * Which manifest a lockfile belongs to. Trivy attributes a vulnerability to
 * the lockfile it read, but a dependency bump usually shows up in the diff as
 * a manifest edit first — so a change to the sibling manifest counts too.
 */
const LOCKFILE_MANIFEST: Record<string, string> = {
  "package-lock.json": "package.json",
  "npm-shrinkwrap.json": "package.json",
  "yarn.lock": "package.json",
  "pnpm-lock.yaml": "package.json",
  "bun.lock": "package.json",
  "bun.lockb": "package.json",
  "poetry.lock": "pyproject.toml",
  "uv.lock": "pyproject.toml",
  "Pipfile.lock": "Pipfile",
  "Gemfile.lock": "Gemfile",
  "go.sum": "go.mod",
  "Cargo.lock": "Cargo.toml",
  "composer.lock": "composer.json",
};

/** Files a finding is attributed to, relative to the scan root. */
function filesOf(f: Finding, root: string): string[] {
  const e = f.evidence;

  // Trivy vulnerability group: attributed to a lockfile (or manifest) target.
  if (typeof e["package"] === "string") {
    const target = toRelativePath(root, String(e["target"] ?? ""));
    if (!target) return [];
    const manifest = LOCKFILE_MANIFEST[posix.basename(target)];
    return manifest ? [target, posix.join(posix.dirname(target), manifest)] : [target];
  }

  const file = toRelativePath(root, String(e["file"] ?? ""));
  return file ? [file] : [];
}

export function tagInDiff<T extends Finding>(
  findings: T[],
  changedFiles: string[] | undefined,
  root: string,
): T[] {
  if (!changedFiles) return findings;
  const changed = new Set(changedFiles.map((p) => toRelativePath(root, p)));
  return findings.map((f) => ({
    ...f,
    in_diff: filesOf(f, root).some((file) => changed.has(file)),
  }));
}

type TierCounts = Record<Priority, number>;

export interface DiffSummary {
  in_diff: TierCounts;
  preexisting: TierCounts;
}

/** Counts over tagged findings only; untagged (URL) findings are not counted. */
export function diffSummary(findings: Finding[]): DiffSummary {
  const summary: DiffSummary = {
    in_diff: { P1: 0, P2: 0, P3: 0 },
    preexisting: { P1: 0, P2: 0, P3: 0 },
  };
  for (const f of findings) {
    if (f.in_diff === undefined) continue;
    summary[f.in_diff ? "in_diff" : "preexisting"][f.priority] += 1;
  }
  return summary;
}
