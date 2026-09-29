import type { Finding } from "../types.js";

// Four-tier readiness replaces binary pass/fail.
export type ReleaseReadiness = "BLOCKED" | "CONDITIONAL" | "ADVISORY" | "CLEAR";

/**
 * Worst priority present decides the tier. Runs over the final, adjusted
 * priorities — after cross-tool promotion and form-factor demotion — so a
 * mobile-only P1 demoted to P2 makes a run CONDITIONAL, not BLOCKED.
 */
export function buildVerdict(findings: Pick<Finding, "priority">[]): ReleaseReadiness {
  if (findings.some((f) => f.priority === "P1")) return "BLOCKED";
  if (findings.some((f) => f.priority === "P2")) return "CONDITIONAL";
  if (findings.some((f) => f.priority === "P3")) return "ADVISORY";
  return "CLEAR";
}
