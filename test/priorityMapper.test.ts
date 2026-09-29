import { test } from "node:test";
import assert from "node:assert/strict";
import {
  axeImpactToPriority,
  lighthouseImpactToPriority,
  lighthouseScoreToPriority,
  staticAnalysisToPriority,
  trivyMisconfigToPriority,
  trivySeverityToPriority,
  trivyVulnToPriority,
  wcagConformanceToPriority,
} from "../src/mappers/priorityMapper.js";

test("lighthouseScoreToPriority: <50 P1, 50–<80 P2, 80–<90 P3, ≥90 null", () => {
  assert.equal(lighthouseScoreToPriority(0), "P1");
  assert.equal(lighthouseScoreToPriority(49), "P1");
  assert.equal(lighthouseScoreToPriority(50), "P2");
  assert.equal(lighthouseScoreToPriority(79), "P2");
  assert.equal(lighthouseScoreToPriority(80), "P3");
  assert.equal(lighthouseScoreToPriority(89), "P3");
  assert.equal(lighthouseScoreToPriority(90), null);
});

test("lighthouseImpactToPriority ranks on weight × (1 − score)", () => {
  assert.equal(lighthouseImpactToPriority(0, 30), "P1"); // 30 points lost
  assert.equal(lighthouseImpactToPriority(80, 25), "P2"); // 5 points
  assert.equal(lighthouseImpactToPriority(0, 1), "P3"); // binary SEO check
  assert.equal(lighthouseImpactToPriority(0, 0), "P3"); // diagnostic never blocks
  assert.equal(lighthouseImpactToPriority(95, 30), null); // passing
  // No category at all falls back to the score-only mapping.
  assert.equal(lighthouseImpactToPriority(40, undefined), "P1");
});

test("staticAnalysisToPriority: Semgrep security P1, ESLint error P2, ESLint warning P3", () => {
  assert.equal(staticAnalysisToPriority("semgrep", "info", "security"), "P1");
  assert.equal(staticAnalysisToPriority("eslint", 2), "P2");
  assert.equal(staticAnalysisToPriority("semgrep", "error"), "P2");
  assert.equal(staticAnalysisToPriority("semgrep", "warning"), "P2");
  assert.equal(staticAnalysisToPriority("eslint", 1), "P3");
  assert.equal(staticAnalysisToPriority("semgrep", "info"), null);
});

test("trivyVulnToPriority prices remediability, demotes devDependencies", () => {
  const base = { unfixable: false, joined: true, dev: false };
  assert.equal(trivyVulnToPriority({ ...base, severity: "CRITICAL", relationship: "direct" }), "P1");
  assert.equal(trivyVulnToPriority({ ...base, severity: "HIGH", relationship: "indirect" }), "P2");
  assert.equal(trivyVulnToPriority({ ...base, severity: "MEDIUM", relationship: "direct" }), "P2");
  assert.equal(trivyVulnToPriority({ ...base, severity: "MEDIUM", relationship: "indirect" }), "P3");
  assert.equal(trivyVulnToPriority({ ...base, severity: "LOW", relationship: "direct" }), "P3");
  assert.equal(trivyVulnToPriority({ ...base, severity: "CRITICAL", relationship: "root" }), "P1");
  assert.equal(
    trivyVulnToPriority({ ...base, severity: "CRITICAL", relationship: "direct", dev: true }),
    "P2",
  );
  // Join miss: severity alone.
  assert.equal(
    trivyVulnToPriority({ ...base, joined: false, severity: "CRITICAL", relationship: "unknown" }),
    "P1",
  );
  assert.equal(trivySeverityToPriority("HIGH"), "P2");
});

test("trivyMisconfigToPriority is capped at P2", () => {
  assert.equal(trivyMisconfigToPriority("CRITICAL"), "P2");
  assert.equal(trivyMisconfigToPriority("HIGH"), "P2");
  assert.equal(trivyMisconfigToPriority("MEDIUM"), "P3");
});

test("wcagConformanceToPriority: A P1, AA P2, above target P3, demotions", () => {
  assert.deepEqual(wcagConformanceToPriority("A", "AA"), { priority: "P1", blocksTarget: true });
  assert.deepEqual(wcagConformanceToPriority("AA", "AA"), { priority: "P2", blocksTarget: true });
  assert.deepEqual(wcagConformanceToPriority("AAA", "AA"), { priority: "P3", blocksTarget: false });
  assert.deepEqual(wcagConformanceToPriority("unknown", "AA"), { priority: "P3", blocksTarget: false });
  assert.equal(wcagConformanceToPriority("A", "AA", { needsReview: true }).priority, "P2");
  assert.equal(wcagConformanceToPriority("A", "AA", { axeImpact: "minor" }).priority, "P2");
});

test("axeImpactToPriority: critical P1, serious P2, needs-review demoted", () => {
  assert.equal(axeImpactToPriority("critical", false), "P1");
  assert.equal(axeImpactToPriority("serious", false), "P2");
  assert.equal(axeImpactToPriority("minor", false), "P3");
  assert.equal(axeImpactToPriority("critical", true), "P2");
});
