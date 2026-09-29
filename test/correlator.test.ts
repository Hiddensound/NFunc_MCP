import { test } from "node:test";
import assert from "node:assert/strict";
import { correlate } from "../src/mappers/correlator.js";
import { collapseLighthouse } from "../src/tools/qaGate.js";
import type { Finding } from "../src/types.js";
import { a11yRun, lighthouseRun, staticFindings } from "./helpers.js";

const URL = "http://localhost:3000/";

function reports() {
  const lh = lighthouseRun("lighthouse-desktop.json", URL);
  const a11y = a11yRun("pa11y-desktop.json", URL);
  return {
    lighthouse: lh,
    a11y: { violation_count: a11y.violation_count, findings: a11y.findings },
    static: null,
  };
}

test("Rule 1: Lighthouse and pa11y on the same technique merge and promote one tier", () => {
  const { correlated_findings, unique_findings, correlations_count } = correlate(reports(), { url: URL });

  // image-alt ↔ H37 (P1 stays P1), color-contrast ↔ G18 (P2 → P1)
  assert.equal(correlations_count, 2);
  const byAudit = (id: string) => correlated_findings.find((f) => f.evidence["audit_id"] === id)!;
  assert.equal(byAudit("color-contrast").priority, "P1");
  assert.equal(byAudit("image-alt").priority, "P1");
  assert.deepEqual(byAudit("color-contrast").confirmed_by, ["lighthouse", "pa11y"]);
  assert.deepEqual(byAudit("color-contrast").evidence["pa11y_selectors"], ["p.small"]);

  // Consumed findings do not reappear as uncorroborated copies.
  assert.ok(!unique_findings.some((f) => f.source_tool === "a11y"));
  assert.deepEqual(
    unique_findings.map((f) => f.evidence["audit_id"]),
    ["largest-contentful-paint"],
  );
});

test("Rule 1 claims every matching pa11y element, not just the first", () => {
  const lh = lighthouseRun("lighthouse-desktop.json", URL);
  const contrast = (selector: string): Finding => ({
    priority: "P2", title: "contrast", description: "", id: `pa11y-${selector}`,
    evidence: { rule_code: "WCAG2AA.Principle1.Guideline1_4.1_4_3.G18.Fail", selector },
  });
  const { correlated_findings, unique_findings } = correlate({
    lighthouse: lh,
    a11y: { violation_count: 2, findings: [contrast("p.a"), contrast("p.b")] },
    static: null,
  });
  const merged = correlated_findings.find((f) => f.evidence["audit_id"] === "color-contrast")!;
  assert.equal(merged.evidence["pa11y_elements_affected"], 2);
  assert.ok(!unique_findings.some((f) => f.source_tool === "a11y"));
});

test("correlated ids are stable and upstream ids are preserved", () => {
  const first = correlate(reports(), { url: URL });
  const second = correlate(reports(), { url: URL });
  assert.deepEqual(
    first.correlated_findings.map((f) => f.id),
    second.correlated_findings.map((f) => f.id),
  );
  const lcp = first.unique_findings.find((f) => f.evidence["audit_id"] === "largest-contentful-paint")!;
  const upstream = reports().lighthouse.findings.find((f) => f.evidence["audit_id"] === "largest-contentful-paint")!;
  assert.equal(lcp.id, upstream.id);
  assert.match(first.correlated_findings[0]!.id, /^lighthouse\+pa11y-[0-9a-f]{12}$/);
});

test("correlated findings keep the Lighthouse side's form-factor breakdown", () => {
  const lh = collapseLighthouse(
    [
      { ff: "desktop", data: lighthouseRun("lighthouse-desktop.json", URL) },
      { ff: "mobile", data: lighthouseRun("lighthouse-mobile.json", URL) },
    ],
    "desktop",
  );
  const a11y = a11yRun("pa11y-desktop.json", URL);
  const { correlated_findings } = correlate(
    { lighthouse: lh, a11y: { violation_count: a11y.violation_count, findings: a11y.findings }, static: null },
    { url: URL },
  );
  const cc = correlated_findings.find((f) => f.evidence["audit_id"] === "color-contrast")! as unknown as Record<string, unknown>;
  assert.deepEqual(cc["affects_form_factors"], ["desktop", "mobile"]);
  assert.deepEqual(cc["priority_by_form_factor"], { desktop: "P2", mobile: "P2" });
});

test("Rule 2: a performance finding naming a file links the static finding", () => {
  const perf: Finding = {
    priority: "P2", title: "Reduce unused JavaScript", id: "lighthouse-x",
    description: "Large bundle", evidence: { audit_id: "unused-javascript", value: "legacy/util.js 120 KiB" },
  };
  const statics = staticFindings("/repo");
  const { unique_findings } = correlate({
    lighthouse: { scores: {}, ttfb_ms: null, findings: [perf] },
    a11y: null,
    static: { issue_count: statics.length, findings: statics },
  });
  const linked = unique_findings.find((f) => f.id === "lighthouse-x")!;
  const util = statics.find((f) => String(f.evidence["file"]).endsWith("util.js"))!;
  assert.deepEqual(linked.related_findings, [util.id]);
});
