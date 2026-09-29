import { test } from "node:test";
import assert from "node:assert/strict";
import { collapseA11y, collapseLighthouse } from "../src/tools/qaGate.js";
import { demote, mergeByFormFactor } from "../src/mappers/formFactorMerge.js";
import { buildVerdict } from "../src/mappers/releaseVerdict.js";
import { a11yRun, byAudit, lighthouseRun } from "./helpers.js";

const URL = "http://localhost:3000/";
const desktop = () => ({ ff: "desktop" as const, data: lighthouseRun("lighthouse-desktop.json", URL) });
const mobile = () => ({ ff: "mobile" as const, data: lighthouseRun("lighthouse-mobile.json", URL) });

test("demote drops one tier and floors at P3", () => {
  assert.equal(demote("P1"), "P2");
  assert.equal(demote("P2"), "P3");
  assert.equal(demote("P3"), "P3");
});

test("Lighthouse: finding on both profiles takes the primary's priority and evidence", () => {
  // Run order must not matter — mobile first was the old bug.
  const view = collapseLighthouse([mobile(), desktop()], "desktop");
  const lcp = byAudit(view.findings, "largest-contentful-paint") as unknown as Record<string, unknown> & {
    priority: string;
    evidence: Record<string, unknown>;
  };
  assert.equal(lcp.priority, "P2"); // desktop P2, not mobile P1
  assert.deepEqual(lcp["priority_by_form_factor"], { desktop: "P2", mobile: "P1" });
  assert.deepEqual(lcp["affects_form_factors"], ["desktop", "mobile"]);
  assert.equal(lcp["form_factor_specific"], false);
  assert.equal(lcp.evidence["value"], "2.9 s"); // desktop's evidence
});

test("Lighthouse: mobile-only finding is demoted one tier under a desktop primary", () => {
  const view = collapseLighthouse([mobile(), desktop()], "desktop");
  const tbt = byAudit(view.findings, "total-blocking-time") as unknown as Record<string, unknown>;
  assert.equal(tbt["priority"], "P2"); // mobile P1 → P2
  assert.deepEqual(tbt["priority_by_form_factor"], { mobile: "P1" });
  assert.deepEqual(tbt["affects_form_factors"], ["mobile"]);
  assert.equal(tbt["form_factor_specific"], true);
});

test("Lighthouse: primary-only finding keeps its priority", () => {
  const view = collapseLighthouse([mobile(), desktop()], "desktop");
  const alt = byAudit(view.findings, "image-alt") as unknown as Record<string, unknown>;
  assert.equal(alt["priority"], "P1");
  assert.deepEqual(alt["affects_form_factors"], ["desktop"]);
  assert.equal(alt["form_factor_specific"], true);
});

test("Lighthouse: primary_form_factor mobile flips the adjustments", () => {
  const view = collapseLighthouse([desktop(), mobile()], "mobile");
  assert.equal(byAudit(view.findings, "largest-contentful-paint").priority, "P1");
  assert.equal(byAudit(view.findings, "total-blocking-time").priority, "P1");
  assert.equal(byAudit(view.findings, "image-alt").priority, "P2"); // desktop-only, demoted
});

test("Lighthouse: headline scores come from the primary profile, not the worst of both", () => {
  const view = collapseLighthouse([mobile(), desktop()], "desktop");
  assert.deepEqual(view.scores, { performance: 85, accessibility: 73, seo: 90 });
  assert.deepEqual(view.scores_by_form_factor, {
    desktop: { performance: 85, accessibility: 73, seo: 90 },
    mobile: { performance: 40, accessibility: 87, seo: 77 },
  });
  assert.equal(view.ttfb_ms, 120);
  assert.equal(view.primary, "desktop");
});

test("Lighthouse: a single-profile run is never demoted, whatever the primary", () => {
  const view = collapseLighthouse([mobile()], "desktop");
  assert.equal(view.primary, "mobile");
  assert.equal(byAudit(view.findings, "total-blocking-time").priority, "P1");
  assert.deepEqual(view.scores, { performance: 40, accessibility: 87, seo: 77 });
  const tbt = byAudit(view.findings, "total-blocking-time") as unknown as Record<string, unknown>;
  assert.deepEqual(tbt["priority_by_form_factor"], { mobile: "P1" });
  assert.equal(tbt["form_factor_specific"], undefined); // only meaningful with two profiles
});

test("Lighthouse: a failed primary falls back to the profile that ran", () => {
  const failed = { ff: "desktop" as const, data: { scores: {}, ttfb_ms: null, findings: [], error: "boom" } };
  const view = collapseLighthouse([failed, mobile()], "desktop");
  assert.equal(view.primary, "mobile");
  assert.equal(byAudit(view.findings, "total-blocking-time").priority, "P1");
});

test("Lighthouse: merged findings keep one id across profiles", () => {
  const d = desktop().data.findings;
  const m = mobile().data.findings;
  const view = collapseLighthouse([mobile(), desktop()], "desktop");
  const lcp = byAudit(view.findings, "largest-contentful-paint");
  assert.equal(lcp.id, byAudit(d, "largest-contentful-paint").id);
  assert.equal(lcp.id, byAudit(m, "largest-contentful-paint").id);
});

test("pa11y: merged across profiles by (rule_code, selector) with demotion", () => {
  const view = collapseA11y(
    [
      { ff: "mobile", data: a11yRun("pa11y-mobile.json", URL) },
      { ff: "desktop", data: a11yRun("pa11y-desktop.json", URL) },
    ],
    "desktop",
  );
  assert.equal(view.violation_count, 3);
  const bySel = (s: string) =>
    view.findings.find((f) => f.evidence["selector"] === s) as unknown as Record<string, unknown>;

  const contrast = bySel("p.small");
  assert.deepEqual(contrast["affects_form_factors"], ["desktop", "mobile"]);
  assert.deepEqual(contrast["priority_by_form_factor"], { desktop: "P2", mobile: "P2" });

  const iframe = bySel("#chat > iframe");
  assert.equal(iframe["priority"], "P2"); // mobile-only P1 → P2
  assert.deepEqual(iframe["priority_by_form_factor"], { mobile: "P1" });
  assert.equal(iframe["form_factor_specific"], true);

  const hero = bySel("#hero > img");
  assert.equal(hero["priority"], "P1");
  assert.deepEqual(hero["affects_form_factors"], ["desktop"]);

  // Sub-score input is the primary profile alone.
  assert.equal(view.primary_findings.length, 2);
});

test("release_readiness is computed from adjusted priorities", () => {
  // Mobile-only P1s, desktop primary: nothing is P1 after demotion.
  const mobileOnly = mergeByFormFactor(
    [
      { ff: "desktop", findings: [] },
      { ff: "mobile", findings: mobile().data.findings },
    ],
    (f) => String(f.evidence["audit_id"]),
    "desktop",
  );
  assert.ok(mobile().data.findings.some((f) => f.priority === "P1"));
  assert.equal(buildVerdict(mobileOnly), "CONDITIONAL");
});
