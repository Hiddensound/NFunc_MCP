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
 * **Lowered from 10 to 2 in Phase 26.** The original 10 was chosen on the
 * reasoning that "ten duplicate ids on a page are ten ids to rename, and
 * collapsing them hides the list a developer needs". That objection turned out
 * to be about `sample_selectors` being capped at 10, not about collapsing —
 * the ids are in the evidence either way, and the cap is now generous enough
 * that nothing is hidden.
 *
 * What forced the change was a boundary artifact seen on a live site. Two pages
 * sharing one WooCommerce sorting component reported the same duplicate-id
 * defect completely differently: the homepage had 11 instances and collapsed to
 * a single finding (3 violations total), while a category page had exactly 10
 * and listed every one (12 violations total). Identical underlying bug, and one
 * page looked four times worse than the other purely because of which side of
 * the threshold it fell on. A boundary that distorts cross-page comparison that
 * badly is in the wrong place.
 *
 * Two was chosen over an intermediate value after measuring the alternatives on
 * one product page: threshold 5 left 22 findings and collapsed nothing (its
 * duplicate-id group sat at exactly 5), threshold 3 gave 18, and threshold 2
 * gave 10 — one finding per rule, with every selector attached. At 2 the same
 * component is reported identically on every page, which is the property that
 * was actually missing. Three gallery images with no alt text are one template
 * to fix, not three authoring mistakes.
 *
 * The cost is real: two genuinely unrelated defects of the same rule on
 * different components now merge into one finding. `sample_selectors` makes
 * that recoverable, and the cross-page rollup in the batch aggregate answers
 * "shared or page-specific" without depending on this number at all.
 */
const SYSTEMIC_THRESHOLD = 2;

/**
 * How many selectors a systemic finding carries. Generous on purpose: the whole
 * objection to collapsing was that it hid the list, so the list has to survive.
 */
const MAX_SAMPLE_SELECTORS = 25;

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
          .slice(0, MAX_SAMPLE_SELECTORS)
          .map((f) => String(f.evidence["selector"] ?? "")),
        ...(group.length > MAX_SAMPLE_SELECTORS
          ? { selectors_truncated: group.length - MAX_SAMPLE_SELECTORS }
          : {}),
      },
    });
  }

  return { findings: out, rawCount: findings.length };
}
