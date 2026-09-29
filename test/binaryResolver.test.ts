import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bundledBinDirs,
  packageRoot,
  resolveBinary,
  resolveESLint,
} from "../src/utils/binaryResolver.js";
import { dbAgeDays, parseVersion } from "../src/tools/checkDependencies.js";

function fakeBin(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, "#!/bin/sh\n");
  chmodSync(file, 0o755);
  return file;
}

const tmp = () => mkdtempSync(join(tmpdir(), "nfunc-bin-"));

test("bundled: the package's own node_modules/.bin wins over PATH", () => {
  const root = join(tmp(), "nfunc-mcp");
  const bin = fakeBin(join(root, "node_modules", ".bin"), "lighthouse");
  assert.deepEqual(resolveBinary("lighthouse", { root }), { command: bin, source: "bundled" });
});

test("bundled: hoisted dependencies in the enclosing node_modules/.bin are found", () => {
  const tree = join(tmp(), "node_modules");
  const root = join(tree, "nfunc-mcp");
  mkdirSync(root, { recursive: true });
  const bin = fakeBin(join(tree, ".bin"), "pa11y");
  assert.deepEqual(resolveBinary("pa11y", { root }), { command: bin, source: "bundled" });
  assert.deepEqual(bundledBinDirs(root), [join(root, "node_modules", ".bin"), join(tree, ".bin")]);
});

test("bundled: scoped installs resolve to the enclosing node_modules", () => {
  const tree = join(tmp(), "node_modules");
  const root = join(tree, "@orium", "nfunc-mcp");
  assert.deepEqual(bundledBinDirs(root), [join(root, "node_modules", ".bin"), join(tree, ".bin")]);
});

test("path: falls back to the bare name when nothing is bundled", () => {
  const root = join(tmp(), "nfunc-mcp");
  assert.deepEqual(resolveBinary("semgrep", { root }), { command: "semgrep", source: "path" });
});

test("eslint: project-local first, then bundled, then PATH", () => {
  const root = join(tmp(), "nfunc-mcp");
  const bundled = fakeBin(join(root, "node_modules", ".bin"), "eslint");
  const project = join(tmp(), "app");
  const local = fakeBin(join(project, "node_modules", ".bin"), "eslint");

  assert.deepEqual(resolveESLint(join(project, "src"), { root }), { command: local, source: "project" });
  const bare = join(tmp(), "bare-app");
  mkdirSync(bare);
  assert.deepEqual(resolveESLint(bare, { root }), { command: bundled, source: "bundled" });
  assert.deepEqual(resolveESLint(bare, { root: join(tmp(), "empty") }), { command: "eslint", source: "path" });
});

test("this checkout bundles lighthouse, pa11y and eslint", () => {
  for (const name of ["lighthouse", "pa11y", "eslint"]) {
    assert.equal(resolveBinary(name, { root: packageRoot() }).source, "bundled", name);
  }
});

test("parseVersion reads each CLI's format", () => {
  assert.equal(parseVersion("13.5.0\n"), "13.5.0");
  assert.equal(parseVersion("v10.11.0"), "10.11.0");
  assert.equal(parseVersion("Version: 0.74.0\nVulnerability DB:\n  Version: 2"), "0.74.0");
  assert.equal(parseVersion("1.140.0-rc1"), "1.140.0-rc1");
  assert.equal(parseVersion("no version here"), null);
});

test("dbAgeDays counts whole days and tolerates bad input", () => {
  const now = new Date("2026-09-29T12:00:00Z");
  assert.equal(dbAgeDays("2026-09-29T06:00:00Z", now), 0);
  assert.equal(dbAgeDays("2026-09-20T12:00:00Z", now), 9);
  assert.equal(dbAgeDays(null, now), null);
  assert.equal(dbAgeDays("not a date", now), null);
});
