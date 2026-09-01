import type { Finding, Priority } from "../types.js";

const PRIORITY_ORDER: Record<Priority, number> = { P1: 0, P2: 1, P3: 2 };

export interface A11yDedupeResult {
  findings: Finding[];
  rawCount: number;
}

/**
 * Above this many distinct elements failing one rule, the individual findings
 * stop being separately actionable and start being one systemic defect — a
 * component used everywhere, not N unrelated bugs. At or below it, each
 * element keeps its own line.
 *
 * Set at 10 rather than lower because distinct elements failing the same rule
 * are often still separate fixes: ten duplicate ids on a page are ten ids to
 * rename, and collapsing them hides the list a developer needs. It takes a
 * genuine flood — axe reported 41 aria-allowed-attr failures from one reused
 * component — before the group is more useful than its members.
 */
const SYSTEMIC_THRESHOLD = 10;

/**
 * Collapses the two ways pa11y over-reports a single defect.
 *
 * Pass 1 — exact repeats. pa11y emits one violation per occurrence, and for
 * page-wide rules (F77, duplicate id, above all) every occurrence resolves
 * back to the same selector. A real commerce page produced 70 of 85 findings
 * from two defects repeated 35 times each, burying the genuine issues and
 * flooring the qa_gate composite score. Collapsing on (rule_code, selector)
 * removes those while keeping two different elements failing the same rule
 * separate, since they are separate fixes.
 *
 * Pass 2 — systemic defects. One rule failing across many *different*
 * elements, which (rule_code, selector) cannot catch. The axe runner produces
 * these routinely: one mis-authored component reused across a page gave 41
 * distinct aria-allowed-attr findings. See SYSTEMIC_THRESHOLD.
 *
 * Counts survive as evidence.occurrences (written only when > 1), so the
 * volume signal is preserved without N copies of the finding.
 */
export function dedupeA11yFindings(findings: Finding[]): A11yDedupeResult {
  // Pass 1 — exact repeats: same rule on the same selector.
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

  const exact = Array.from(byKey.values()).map(({ finding, count }) =>
    count > 1
      ? { ...finding, evidence: { ...finding.evidence, occurrences: count } }
      : finding,
  );

  // Pass 2 — systemic defects: one rule failing across many *different*
  // elements. htmlcs rarely does this (its repeats share a selector, which
  // pass 1 already caught) but axe routinely does: a single mis-authored
  // component reused across a page produced 41 separate aria-allowed-attr
  // findings, which drowned everything else and inflated the P1 count.
  const byRule = new Map<string, Finding[]>();
  for (const f of exact) {
    const rule = String(f.evidence["rule_code"] ?? "");
    const group = byRule.get(rule);
    if (group) group.push(f);
    else byRule.set(rule, [f]);
  }

  const out: Finding[] = [];
  for (const [, group] of byRule) {
    if (group.length <= SYSTEMIC_THRESHOLD) {
      out.push(...group);
      continue;
    }
    const worst = group.reduce((a, b) =>
      PRIORITY_ORDER[a.priority] <= PRIORITY_ORDER[b.priority] ? a : b,
    );
    const elements = group.reduce(
      (n, f) => n + Number(f.evidence["occurrences"] ?? 1),
      0,
    );
    out.push({
      ...worst,
      description:
        `${worst.description} This rule fails on ${elements} elements across the page, ` +
        `which usually means one shared component rather than ${elements} separate defects — ` +
        `fix the component and all of them clear.`,
      evidence: {
        ...worst.evidence,
        occurrences: elements,
        distinct_elements: group.length,
        systemic: true,
        sample_selectors: group
          .slice(0, 10)
          .map((f) => String(f.evidence["selector"] ?? "")),
      },
    });
  }

  return { findings: out, rawCount: findings.length };
}
