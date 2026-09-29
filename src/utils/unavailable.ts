import type { ShellResult } from "./shellRunner.js";
import type { UnavailableTool } from "../types.js";
import { trivyInstallHint } from "./trivyRunner.js";

/**
 * One place for "this CLI could not run" — detection and the install line.
 * The hints name a command the user can actually paste on their platform.
 */

/** execa reports a spawn failure as exit -1, usually with nothing on either stream. */
export function isNotInstalled(result: ShellResult): boolean {
  if (result.exitCode !== -1) return false;
  if (!result.stderr && !result.stdout) return true;
  return (
    result.stderr.includes("ENOENT") ||
    result.stderr.includes("not found") ||
    result.stderr.includes("command not found") ||
    result.stderr.includes("No such file")
  );
}

const HINTS: Record<string, () => string> = {
  lighthouse: () => "npm install -g lighthouse",
  pa11y: () => "npm install -g pa11y",
  eslint: () => "npm install --save-dev eslint (in the project) or npm install -g eslint",
  semgrep: () =>
    process.platform === "darwin" ? "brew install semgrep" : "python3 -m pip install semgrep",
  trivy: trivyInstallHint,
};

export function notInstalled(tool: string, binary = tool): UnavailableTool {
  return {
    tool,
    binary,
    reason: "not_installed",
    install_hint: HINTS[tool]?.() ?? `install ${binary} and make sure it is on PATH`,
  };
}

export function needsNetwork(tool: string, binary: string, hint: string): UnavailableTool {
  return { tool, binary, reason: "network", install_hint: hint };
}
