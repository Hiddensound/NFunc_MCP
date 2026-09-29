import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Where a CLI comes from. lighthouse, pa11y and eslint ship as dependencies of
 * this package, so a plain `npx nfunc-mcp` can run them without a global
 * install; semgrep and trivy are not npm packages and always come from PATH.
 *
 * Resolution order:
 *   1. "project" — eslint only: the scanned project's own node_modules/.bin,
 *      so a repo pinned to its ESLint major keeps using it.
 *   2. "bundled" — this package's node_modules/.bin, then the node_modules/.bin
 *      of the tree this package is installed into (npm hoists our
 *      dependencies there, so under `npx` or a normal install that is where
 *      they actually land).
 *   3. "path" — the bare command name, left to PATH.
 */
export type BinarySource = "project" | "bundled" | "path";

export interface ResolvedBinary {
  /** What to spawn: an absolute path, or the bare name for a PATH lookup. */
  command: string;
  source: BinarySource;
}

/** Repo / package root: this file lives at src/utils or dist/utils. */
export function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/**
 * The .bin directories that count as "bundled" for a package rooted at
 * `root`. When the package sits inside a node_modules tree
 * (…/node_modules/nfunc-mcp or …/node_modules/@scope/nfunc-mcp), that tree's
 * .bin is where hoisted dependencies' binaries are linked.
 */
export function bundledBinDirs(root: string = packageRoot()): string[] {
  const dirs = [join(root, "node_modules", ".bin")];
  const parent = dirname(root);
  const enclosing =
    basename(parent) === "node_modules"
      ? parent
      : basename(parent).startsWith("@") && basename(dirname(parent)) === "node_modules"
        ? dirname(parent)
        : null;
  if (enclosing) dirs.push(join(enclosing, ".bin"));
  return dirs;
}

/** npm writes a .cmd shim beside the unix one on Windows. */
function binIn(dir: string, name: string): string | null {
  const candidates = process.platform === "win32" ? [`${name}.cmd`, name] : [name];
  for (const c of candidates) {
    const full = join(dir, c);
    if (existsSync(full)) return full;
  }
  return null;
}

export function resolveBinary(name: string, options: { root?: string } = {}): ResolvedBinary {
  for (const dir of bundledBinDirs(options.root)) {
    const hit = binIn(dir, name);
    if (hit) return { command: hit, source: "bundled" };
  }
  return { command: name, source: "path" };
}

/**
 * ESLint: the project's own binary first (walking up from the scanned path,
 * as before — a project on ESLint 8 with .eslintrc must not be linted by the
 * bundled ESLint 10, which dropped that format), then bundled, then PATH.
 */
export function resolveESLint(startPath: string | undefined, options: { root?: string } = {}): ResolvedBinary {
  if (startPath) {
    let dir = resolve(startPath);
    for (let i = 0; i < 7; i++) {
      const hit = binIn(join(dir, "node_modules", ".bin"), "eslint");
      if (hit) return { command: hit, source: "project" };
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return resolveBinary("eslint", options);
}
