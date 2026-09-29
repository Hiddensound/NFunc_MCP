import { test } from "node:test";
import assert from "node:assert/strict";
import { a11yFindingId, findingId, toRelativePath } from "../src/mappers/findingId.js";
import { a11yRun, lighthouseRun, staticFindings, trivyFindings } from "./helpers.js";
import { fixture } from "./helpers.js";

const URL = "http://localhost:3000/";
const ids = (fs: Array<{ id?: string }>) => fs.map((f) => f.id);

test("ids are deterministic across re-runs of the same input", () => {
  assert.deepEqual(ids(lighthouseRun("lighthouse-desktop.json", URL).findings),
    ids(lighthouseRun("lighthouse-desktop.json", URL).findings));
  assert.deepEqual(ids(a11yRun("pa11y-desktop.json", URL).findings),
    ids(a11yRun("pa11y-desktop.json", URL).findings));
  assert.deepEqual(ids(staticFindings("/repo")), ids(staticFindings("/repo")));
  assert.deepEqual(ids(trivyFindings("/repo")), ids(trivyFindings("/repo")));
});

test("every finding has an id, and ids are unique within a run", () => {
  for (const findings of [
    lighthouseRun("lighthouse-mobile.json", URL).findings,
    a11yRun("pa11y-mobile.json", URL).findings,
    staticFindings("/repo"),
    trivyFindings("/repo"),
  ]) {
    const list = ids(findings);
    assert.ok(list.every((id) => typeof id === "string" && /^[a-z0-9+]+-[0-9a-f]{12}$/.test(id!)), String(list));
    assert.equal(new Set(list).size, list.length);
  }
});

test("form factor is not part of the id", () => {
  const d = lighthouseRun("lighthouse-desktop.json", URL).findings;
  const m = lighthouseRun("lighthouse-mobile.json", URL).findings;
  const cc = (fs: typeof d) => fs.find((f) => f.evidence["audit_id"] === "color-contrast")!.id;
  assert.equal(cc(d), cc(m));
});

test("the URL is part of the id; trivial URL spellings are folded", () => {
  const a = lighthouseRun("lighthouse-desktop.json", "http://localhost:3000/").findings[0]!.id;
  const b = lighthouseRun("lighthouse-desktop.json", "http://LOCALHOST:3000").findings[0]!.id;
  const c = lighthouseRun("lighthouse-desktop.json", "http://localhost:3000/checkout").findings[0]!.id;
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test("static ids do not depend on where the checkout lives", () => {
  const moved = fixture("eslint.json").replaceAll("/repo/", "/home/ci/work/repo/");
  assert.deepEqual(ids(staticFindings("/repo")), ids(staticFindings("/home/ci/work/repo", moved)));
  assert.deepEqual(ids(trivyFindings("/repo")), ids(trivyFindings("/somewhere/else")));
});

test("a systemic pa11y finding's id ignores which element sorted first", () => {
  const systemic = (selector: string) => ({
    priority: "P2" as const, title: "dup id", description: "",
    evidence: { rule_code: "WCAG2AA.Principle4.Guideline4_1.4_1_1.F77", selector, systemic: true },
  });
  assert.equal(a11yFindingId(systemic("#a"), URL), a11yFindingId(systemic("#b"), URL));
});

test("findingId and toRelativePath basics", () => {
  const one = findingId({ tool: "eslint", rule: "no-undef", location: "src/a.js:1" });
  assert.equal(one, findingId({ tool: "eslint", rule: "no-undef", location: "src/a.js:1" }));
  assert.notEqual(one, findingId({ tool: "eslint", rule: "no-undef", location: "src/a.js:2" }));
  assert.match(one, /^eslint-[0-9a-f]{12}$/);
  assert.equal(toRelativePath("/repo", "/repo/src/a.js"), "src/a.js");
  assert.equal(toRelativePath("/repo", "./src/a.js"), "src/a.js");
  assert.equal(toRelativePath("/repo", "src/a.js"), "src/a.js");
});
