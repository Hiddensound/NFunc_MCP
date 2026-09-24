import { z } from "zod";
import { resolve } from "path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  DEFAULT_SCANNERS,
  readTrivyDbDate,
  runTrivyFs,
  type TrivyScanner,
} from "../utils/trivyRunner.js";
import { parseTrivyJSON } from "../utils/outputParsers.js";
import { aggregateVulnerabilities } from "../mappers/vulnAggregator.js";
import {
  formatTrivyMisconfigFinding,
  formatTrivySecretFinding,
  formatTrivyVulnFinding,
} from "../mappers/defectFormatter.js";
import { securitySubScore } from "../mappers/compositeScore.js";
import { sortFindingsByPriority } from "../mappers/priorityMapper.js";
import type { Finding, Priority } from "../types.js";

const PRIORITY_ORDER: Record<Priority, number> = { P1: 0, P2: 1, P3: 2 };

const inputShape = {
  path: z
    .string()
    .describe("Absolute or relative path to the directory to scan"),
  scanners: z
    .array(z.enum(["vuln", "secret", "misconfig", "license"]))
    .optional()
    .describe(
      "Which Trivy scanners to run. Default: vuln, secret, misconfig. " +
        "Add 'license' to inventory dependency licences — reported separately and never gating.",
    ),
  min_severity: z
    .enum(["UNKNOWN", "LOW", "MEDIUM", "HIGH", "CRITICAL"])
    .optional()
    .describe(
      "Lowest Trivy severity to report. Omit to see everything; findings are " +
        "prioritised on remediability rather than severity, so filtering here is rarely needed.",
    ),
  skip_dirs: z
    .array(z.string())
    .optional()
    .describe("Directories or glob patterns to skip, e.g. ['dist', 'fixtures']"),
};

export function registerSecurityScanTool(server: McpServer): void {
  server.registerTool(
    "run_security_scan",
    {
      description:
        "Scans a local directory with Trivy for dependency vulnerabilities, committed secrets " +
        "and infrastructure misconfiguration, and returns a QA-style report with prioritised " +
        "findings (P1/P2/P3). Vulnerabilities are grouped into one finding per remediation — " +
        "one version bump, not one CVE — and ranked on how cheaply they can be fixed rather " +
        "than on raw severity. Vulnerabilities with no upstream fix are listed separately as a " +
        "decision queue instead of blocking the work queue. Requires Trivy on PATH; a missing " +
        "Trivy is reported as a warning rather than an error.",
      inputSchema: inputShape,
    },
    async ({ path: targetPath, scanners, min_severity, skip_dirs }) => {
      const absPath = resolve(targetPath);
      const activeScanners: TrivyScanner[] =
        scanners && scanners.length > 0 ? scanners : DEFAULT_SCANNERS;

      // The version probe needs no database and no network, so it runs
      // alongside the scan rather than adding to the critical path.
      const [run, dbDate] = await Promise.all([
        runTrivyFs(absPath, activeScanners, {
          minSeverity: min_severity,
          skipDirs: skip_dirs,
        }),
        readTrivyDbDate(),
      ]);

      const warnings: string[] = [...run.warnings];

      if (!run.ran) {
        return textResponse({
          path: absPath,
          tools_run: [],
          scanners: activeScanners,
          issue_count: 0,
          findings: [],
          warnings,
        });
      }

      let parsed;
      try {
        parsed = parseTrivyJSON(run.stdout);
      } catch (err) {
        warnings.push(
          `Failed to parse Trivy JSON output: ${err instanceof Error ? err.message : String(err)}`,
        );
        return textResponse({
          path: absPath,
          tools_run: [],
          scanners: activeScanners,
          issue_count: 0,
          findings: [],
          warnings,
        });
      }

      const { fixable, unfixable } = aggregateVulnerabilities(parsed.vulnerabilities);

      const findings: Finding[] = [
        ...parsed.secrets.map(formatTrivySecretFinding),
        ...fixable.map(formatTrivyVulnFinding),
        ...parsed.misconfigurations.map(formatTrivyMisconfigFinding),
      ];

      sortFindingsByPriority(findings);
      // Stable secondary ordering so two runs over an unchanged tree produce
      // byte-identical reports — `runComparator` diffs these.
      findings.sort(
        (a, b) =>
          PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] ||
          a.title.localeCompare(b.title),
      );

      // A join miss means a finding was priced on severity alone. That is a
      // silent degradation otherwise, and a silent degradation in a priority
      // model is exactly the thing worth shouting about.
      if (parsed.unjoinedCount > 0) {
        warnings.push(
          `${parsed.unjoinedCount} vulnerabilit${parsed.unjoinedCount === 1 ? "y" : "ies"} ` +
            `could not be matched to a package entry, so direct-vs-transitive was unavailable and ` +
            `they were ranked on severity alone. They are marked relationship_unknown in evidence.`,
        );
      }

      const report: Record<string, unknown> = {
        path: absPath,
        tools_run: ["trivy"],
        scanners: activeScanners,
        ...(dbDate ? { db_status: { trivy_db_updated_at: dbDate } } : {}),
        scores: { security: securitySubScore(findings) },
        issue_count: findings.length,
        counts: {
          vulnerabilities: parsed.vulnerabilities.length,
          secrets: parsed.secrets.length,
          misconfigurations: parsed.misconfigurations.length,
          remediation_groups: fixable.length,
          unfixable_groups: unfixable.length,
        },
        findings,
      };

      // A decision queue, not a work queue — see the priority mapper. Kept out
      // of `findings` so that "how much work is there" and "what needs a call"
      // stay separate questions.
      if (unfixable.length > 0) {
        report["unfixable"] = unfixable.map((g) => ({
          package: `${g.pkgName}@${g.installedVersion}`,
          // Named as in the findings above: Trivy mixes CVE, GHSA and
          // ecosystem-specific ids (NSWG-ECO-516) in this field.
          advisory_ids: g.cveIds,
          max_severity: g.maxSeverity,
          statuses: g.statuses,
          relationship: g.relationship,
          ...(g.dev ? { dev_dependency: true } : {}),
          target: g.target,
          note:
            "No upstream fix is available. Needs a mitigation decision — compensating control, " +
            "dependency replacement, or documented acceptance — not a version bump.",
        }));
      }

      // Licences are an inventory, not defects: no priority, excluded from the
      // score, and only present when explicitly asked for.
      if (activeScanners.includes("license") && parsed.licenses.length > 0) {
        report["licenses"] = parsed.licenses.map((l) => ({
          package: l.pkgName,
          license: l.name,
          category: l.category,
          severity: l.severity,
          file: l.filePath,
        }));
      }

      if (warnings.length > 0) report["warnings"] = warnings;

      return textResponse(report);
    },
  );
}

function textResponse(payload: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}
