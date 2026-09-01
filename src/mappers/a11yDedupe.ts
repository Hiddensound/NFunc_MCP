import type { Finding, Priority } from "../types.js";

const PRIORITY_ORDER: Record<Priority, number> = { P1: 0, P2: 1, P3: 2 };

export interface A11yDedupeResult {
  findings: Finding[];
  rawCount: number;
}

/**
 * pa11y emits one violation per occurrence. For page-wide rules — F77
 * (duplicate id) above all — every occurrence resolves back to the same
 * selector, so a single defect can surface as dozens of byte-identical
 * findings. A real run against a commerce category page produced 70 of 85
 * findings from just two defects repeated 35 times each, which buried the
 * genuine issues and floored the qa_gate composite score.
 *
 * Collapse on (rule_code, selector). That pair is the narrowest key that still
 * identifies one fixable defect: two different elements failing the same rule
 * have different selectors and stay separate, while the same element reported
 * N times collapses to one entry.
 *
 * The collapsed count survives as evidence.occurrences (written only when > 1)
 * so the volume signal is preserved without N copies of the finding.
 */
export function dedupeA11yFindings(findings: Finding[]): A11yDedupeResult {
  const byKey = new Map<string, { finding: Finding; count: number }>();

  for (const f of findings) {
    const key =
      `${String(f.evidence["rule_code"] ?? "")}|` +
      `${String(f.evidence["selector"] ?? "")}`;

    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { finding: f, count: 1 });
      continue;
    }

    existing.count += 1;
    // pa11y can grade occurrences of one rule differently (error vs warning);
    // keep the most severe so dedup never downgrades a defect.
    if (PRIORITY_ORDER[f.priority] < PRIORITY_ORDER[existing.finding.priority]) {
      existing.finding = f;
    }
  }

  const deduped = Array.from(byKey.values()).map(({ finding, count }) =>
    count > 1
      ? { ...finding, evidence: { ...finding.evidence, occurrences: count } }
      : finding,
  );

  return { findings: deduped, rawCount: findings.length };
}
