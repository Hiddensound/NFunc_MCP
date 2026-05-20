import type { Finding, Priority } from "../types.js";

export type { Priority };

const PRIORITY_ORDER: Record<Priority, number> = { P1: 0, P2: 1, P3: 2 };

export function lighthouseScoreToPriority(score: number): Priority | null {
  if (score < 50) return "P1";
  if (score < 80) return "P2";
  if (score < 90) return "P3";
  return null;
}

// Pass "notice" (or "warning" / "unknown") to suppress the finding.
export function wcagLevelToPriority(level: string): Priority | null {
  if (level === "A") return "P1";
  if (level === "AA") return "P2";
  if (level === "AAA") return "P3";
  return null;
}

export function staticAnalysisToPriority(
  source: "eslint" | "semgrep",
  severity: number | string,
  category?: string,
): Priority | null {
  // Security findings always win regardless of severity level.
  if (source === "semgrep" && category === "security") return "P1";
  if (source === "eslint" && severity === 2) return "P2";
  if (source === "semgrep" && (severity === "warning" || severity === "error")) return "P2";
  if (source === "eslint" && severity === 1) return "P3";
  // "info" or anything unrecognised → suppress
  return null;
}

export function sortFindingsByPriority<T extends Finding>(findings: T[]): T[] {
  return findings.sort(
    (a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority],
  );
}
