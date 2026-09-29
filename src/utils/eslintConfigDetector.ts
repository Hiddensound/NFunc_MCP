import { existsSync, readdirSync, statSync } from "fs";
import { join, resolve } from "path";
import { resolveESLint } from "./binaryResolver.js";

// Checked in priority order: flat config first, then legacy formats.
const CONFIG_FILES = [
  "eslint.config.js",
  "eslint.config.mjs",
  ".eslintrc.js",
  ".eslintrc.json",
  ".eslintrc.yml",
  ".eslintrc.yaml",
  ".eslintrc",
];

const SKIP_DIRS = new Set([
  "node_modules", "dist", ".git", ".next", "build", "out", "coverage",
  ".turbo", ".cache", ".vercel", "__pycache__",
]);

export interface ESLintConfigResult {
  hasConfig: boolean;
  configFile: string | null;
}

export function detectESLintConfig(targetPath: string): ESLintConfigResult {
  for (const file of CONFIG_FILES) {
    if (existsSync(join(targetPath, file))) {
      return { hasConfig: true, configFile: file };
    }
  }
  return { hasConfig: false, configFile: null };
}

/**
 * Recursively discovers subdirectories (up to maxDepth) that have their own
 * ESLint config. Does not recurse into a directory that already has a config —
 * ESLint handles nested configs from that point on.
 */
export function discoverESLintPackages(rootPath: string, maxDepth = 3): string[] {
  const packages: string[] = [];

  function walk(dir: string, depth: number): void {
    if (depth > maxDepth) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry)) continue;
      const full = join(dir, entry);
      try {
        if (!statSync(full).isDirectory()) continue;
      } catch {
        continue;
      }
      if (detectESLintConfig(full).hasConfig) {
        packages.push(full);
        // Stop descending — ESLint resolves nested configs from here.
      } else {
        walk(full, depth + 1);
      }
    }
  }

  walk(rootPath, 1);
  return packages;
}

/**
 * Project-local ESLint first (walking up from startPath, so a project keeps
 * the major it is pinned to), then the ESLint bundled with this package, then
 * PATH. See binaryResolver.
 */
export function resolveESLintBinary(startPath: string): string {
  return resolveESLint(startPath).command;
}
