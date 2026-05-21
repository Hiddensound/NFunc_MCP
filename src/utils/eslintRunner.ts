import { fileURLToPath } from "url";
import { relative } from "path";
import { runShell } from "./shellRunner.js";
import { parseESLintJSON } from "./outputParsers.js";
import {
  detectESLintConfig,
  discoverESLintPackages,
  resolveESLintBinary,
} from "./eslintConfigDetector.js";
import type { StaticAnalysisIssue } from "../mappers/defectFormatter.js";

const BASELINE_CONFIG_PATH = fileURLToPath(
  new URL("../config/qa-mcp-baseline.eslint.config.js", import.meta.url),
);

export interface ESLintRunResult {
  issues: StaticAnalysisIssue[];
  config_used: string;
  packages: string[];  // relative paths of per-package runs; empty otherwise
  warnings: string[];
  ran: boolean;
}

interface RunSpec {
  binary: string;
  args: string[];
  cwd: string;
  label: string; // relative path for warning messages
}

function buildSpecs(absPath: string): { specs: RunSpec[]; config_used: string; packages: string[] } {
  const { hasConfig } = detectESLintConfig(absPath);

  if (hasConfig) {
    return {
      specs: [{
        binary: resolveESLintBinary(absPath),
        args: [".", "--format", "json"],
        cwd: absPath,
        label: ".",
      }],
      config_used: "project",
      packages: [],
    };
  }

  const discovered = discoverESLintPackages(absPath);
  if (discovered.length > 0) {
    return {
      specs: discovered.map(pkg => ({
        binary: resolveESLintBinary(pkg),
        args: [".", "--format", "json"],
        cwd: pkg,
        label: relative(absPath, pkg),
      })),
      config_used: `per-package (${discovered.length} packages)`,
      packages: discovered.map(pkg => relative(absPath, pkg)),
    };
  }

  // No config anywhere — fall back to the QA MCP baseline (JS/JSX only).
  return {
    specs: [{
      binary: resolveESLintBinary(absPath),
      args: [".", "--format", "json", "--config", BASELINE_CONFIG_PATH],
      cwd: absPath,
      label: ".",
    }],
    config_used: "qa-mcp-baseline",
    packages: [],
  };
}

export async function runESLint(absPath: string): Promise<ESLintRunResult> {
  const { specs, config_used, packages } = buildSpecs(absPath);
  const results = await Promise.all(
    specs.map(s => runShell(s.binary, s.args, { timeoutMs: 120_000, cwd: s.cwd })),
  );

  const issues: StaticAnalysisIssue[] = [];
  const warnings: string[] = [];
  let ran = false;
  let notInstalled = false;

  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    const spec = specs[i]!;

    // Tool not found: exitCode -1 with no output.
    if (r.exitCode === -1 && !r.stdout && !r.stderr) {
      notInstalled = true;
      break;
    }
    // Also catch ENOENT in stderr (execa surfaces it there on some platforms).
    if (
      r.exitCode === -1 &&
      (r.stderr.includes("ENOENT") ||
        r.stderr.includes("not found") ||
        r.stderr.includes("command not found"))
    ) {
      notInstalled = true;
      break;
    }

    // Exit 2 = fatal config or parse error.
    if (r.exitCode === 2) {
      warnings.push(`ESLint config error (${spec.label}): ${r.stderr.slice(0, 300)}`);
      continue;
    }

    if (r.stdout) {
      try {
        for (const issue of parseESLintJSON(r.stdout).issues) {
          issues.push({
            source: "eslint",
            file: issue.filePath,
            line: issue.line,
            column: issue.column,
            ruleId: issue.ruleId,
            message: issue.message,
            severity: issue.severity,
          });
        }
        ran = true;
      } catch {
        warnings.push(`Failed to parse ESLint JSON output (${spec.label}).`);
      }
    } else {
      // Exit 0/1 with no stdout = no matched files or no issues.
      ran = true;
    }
  }

  if (notInstalled) {
    warnings.push("ESLint is not installed or not found in PATH — ESLint analysis skipped.");
  }

  return { issues, config_used, packages, warnings, ran: ran && !notInstalled };
}