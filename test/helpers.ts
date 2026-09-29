import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  parseESLintJSON,
  parseLighthouseJSON,
  parsePa11yJSON,
  parseSemgrepJSON,
  parseTrivyJSON,
} from "../src/utils/outputParsers.js";
import {
  formatA11yFinding,
  formatLighthouseFinding,
  formatTrivyMisconfigFinding,
  formatTrivySecretFinding,
  formatTrivyVulnFinding,
  type StaticAnalysisIssue,
} from "../src/mappers/defectFormatter.js";
import { dedupeA11yFindings } from "../src/mappers/a11yDedupe.js";
import { aggregateVulnerabilities } from "../src/mappers/vulnAggregator.js";
import {
  a11yFindingId,
  fileFindingId,
  lighthouseFindingId,
  withIds,
} from "../src/mappers/findingId.js";
import { buildStaticFindings } from "../src/utils/staticRunner.js";
import type { Finding } from "../src/types.js";

export function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");
}

/** Lighthouse JSON → the per-profile run shape run_qa_gate builds. */
export function lighthouseRun(name: string, url: string) {
  const parsed = parseLighthouseJSON(fixture(name));
  const findings = parsed.failedAudits
    .map(formatLighthouseFinding)
    .filter((f): f is Finding => f !== null);
  return {
    scores: parsed.categoryScores,
    ttfb_ms: parsed.ttfbMs,
    findings: withIds(findings, (f) => lighthouseFindingId(f, url)),
  };
}

/** pa11y JSON → the per-profile run shape run_qa_gate builds. */
export function a11yRun(name: string, url: string) {
  const raw = parsePa11yJSON(fixture(name))
    .violations.map((v) => formatA11yFinding(v))
    .filter((f): f is Finding => f !== null);
  const { findings, rawCount } = dedupeA11yFindings(raw);
  return {
    violation_count: findings.length,
    raw_violation_count: rawCount,
    findings: withIds(findings, (f) => a11yFindingId(f, url)),
  };
}

/** ESLint + Semgrep fixtures → static findings, as staticRunner builds them. */
export function staticFindings(root: string, eslintJson = fixture("eslint.json")): Finding[] {
  const issues: StaticAnalysisIssue[] = [
    ...parseESLintJSON(eslintJson).issues.map((i) => ({
      source: "eslint" as const,
      file: i.filePath,
      line: i.line,
      column: i.column,
      ruleId: i.ruleId,
      message: i.message,
      severity: i.severity,
    })),
    ...parseSemgrepJSON(fixture("semgrep.json")).findings.map((f) => ({
      source: "semgrep" as const,
      file: f.filePath,
      line: f.line,
      ruleId: f.ruleId,
      message: f.message,
      severity: f.severity,
      category: f.category,
    })),
  ];
  return buildStaticFindings(issues, root);
}

/** Trivy fixture → findings, as run_security_scan builds them (before tagging). */
export function trivyFindings(root: string): Finding[] {
  const parsed = parseTrivyJSON(fixture("trivy.json"));
  const { fixable } = aggregateVulnerabilities(parsed.vulnerabilities);
  return withIds(
    [
      ...parsed.secrets.map(formatTrivySecretFinding),
      ...fixable.map(formatTrivyVulnFinding),
      ...parsed.misconfigurations.map(formatTrivyMisconfigFinding),
    ],
    (f) => fileFindingId(f, root),
  );
}

export function byAudit<T extends Finding>(findings: T[], auditId: string): T {
  const f = findings.find((x) => x.evidence["audit_id"] === auditId);
  if (!f) throw new Error(`no finding for audit ${auditId}`);
  return f;
}
