import { test } from "node:test";
import assert from "node:assert/strict";
import { diffSummary, tagInDiff } from "../src/mappers/diffTagger.js";
import { staticFindings, trivyFindings } from "./helpers.js";

const ROOT = "/repo";

test("no changed_files → findings are returned untagged", () => {
  const findings = tagInDiff(staticFindings(ROOT), undefined, ROOT);
  assert.ok(findings.every((f) => !("in_diff" in f)));
});

test("ESLint (absolute paths) and Semgrep (relative paths) tag against the same relative list", () => {
  const findings = tagInDiff(staticFindings(ROOT), ["src/app.js", "src/api.ts"], ROOT);
  const at = (file: string, line: number) =>
    findings.find((f) => String(f.evidence["file"]).endsWith(file) && f.evidence["line"] === line)!;

  assert.equal(at("src/app.js", 12).in_diff, true);
  assert.equal(at("src/app.js", 30).in_diff, true);
  assert.equal(at("src/api.ts", 41).in_diff, true);
  assert.equal(at("src/legacy/util.js", 4).in_diff, false);
  assert.equal(findings.length, 4); // nothing filtered
});

test("changed_files tolerates ./ prefixes and absolute paths under the root", () => {
  const findings = tagInDiff(staticFindings(ROOT), ["./src/legacy/util.js", "/repo/src/api.ts"], ROOT);
  assert.equal(findings.filter((f) => f.in_diff).length, 2);
});

test("Trivy: secrets and misconfigs by file, vulnerabilities by lockfile or its manifest", () => {
  const findings = tagInDiff(
    trivyFindings(ROOT),
    ["src/config.ts", "packages/web/package.json"],
    ROOT,
  );
  const byTitle = (s: string) => findings.find((f) => f.title.includes(s))!;

  assert.equal(byTitle("AWS Access Key ID").in_diff, true); // secret, file changed
  assert.equal(byTitle("minimist").in_diff, true); // yarn.lock's manifest changed
  assert.equal(byTitle("axios").in_diff, false); // root package-lock untouched
  assert.equal(byTitle("root").in_diff, false); // Dockerfile untouched
});

test("Trivy: a lockfile change alone marks its vulnerabilities in_diff", () => {
  const findings = tagInDiff(trivyFindings(ROOT), ["package-lock.json"], ROOT);
  assert.equal(findings.find((f) => f.title.includes("axios"))!.in_diff, true);
  assert.equal(findings.find((f) => f.title.includes("minimist"))!.in_diff, false);
});

test("diffSummary counts tagged findings per tier and ignores untagged ones", () => {
  const tagged = tagInDiff(
    trivyFindings(ROOT),
    ["src/config.ts", "packages/web/package.json"],
    ROOT,
  );
  const untaggedUrlFinding = {
    priority: "P1" as const, title: "LCP", description: "", evidence: { audit_id: "lcp" },
  };
  assert.deepEqual(diffSummary([...tagged, untaggedUrlFinding]), {
    in_diff: { P1: 1, P2: 1, P3: 0 }, // secret P1, minimist P2
    preexisting: { P1: 1, P2: 1, P3: 0 }, // axios P1, Dockerfile P2
  });
});
