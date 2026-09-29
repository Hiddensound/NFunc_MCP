import type { Finding, Priority } from "../types.js";

/**
 * Cross-profile merge for run_qa_gate.
 *
 * One primary profile (desktop by default) speaks for the page. A finding the
 * primary profile also reports takes the primary's priority and evidence; a
 * finding that only the other profile reports is still reported, one tier
 * lower, because it affects fewer of the users the caller has said matter
 * most. Both raw priorities stay on the finding so the demotion is auditable.
 *
 * This replaces a first-profile-wins merge in which the profile order
 * (mobile, then desktop) quietly decided every priority.
 */

export type FormFactor = "desktop" | "mobile";

/** Canonical order for affects_form_factors, independent of run order. */
const ORDER: FormFactor[] = ["desktop", "mobile"];

const DEMOTE: Record<Priority, Priority> = { P1: "P2", P2: "P3", P3: "P3" };

export function demote(p: Priority): Priority {
  return DEMOTE[p];
}

export interface ProfileFindings {
  ff: FormFactor;
  findings: Finding[];
}

export interface FormFactorFinding extends Finding {
  priority_by_form_factor: Partial<Record<FormFactor, Priority>>;
  affects_form_factors: FormFactor[];
  /** Only when more than one profile ran: true when one profile alone reports it. */
  form_factor_specific?: boolean;
}

/**
 * The primary that actually applies. Demotion only makes sense when the
 * requested primary produced results: a mobile-only run has no desktop to
 * defer to, and demoting every finding in it would be reporting nothing but
 * the absence of a run that was never asked for.
 */
export function effectivePrimary(
  requested: FormFactor,
  ran: FormFactor[],
): FormFactor | null {
  if (ran.includes(requested)) return requested;
  return ran[0] ?? null;
}

/**
 * @param keyOf  identity across profiles — audit_id for Lighthouse,
 *               (rule_code, selector) for pa11y.
 * @param legacyEvidence  also write affects_form_factors / form_factor_specific
 *               into evidence, where earlier versions of the Lighthouse merge
 *               put them. Kept for callers reading the old location.
 */
export function mergeByFormFactor(
  runs: ProfileFindings[],
  keyOf: (f: Finding) => string,
  requestedPrimary: FormFactor,
  options: { legacyEvidence?: boolean } = {},
): FormFactorFinding[] {
  const primary = effectivePrimary(requestedPrimary, runs.map((r) => r.ff));
  if (!primary) return [];
  const multi = runs.length > 1;

  const byKey = new Map<string, Map<FormFactor, Finding>>();
  const order: string[] = [];
  // Primary first, so output order follows the primary profile's own ordering.
  const ordered = [...runs].sort((a, b) => (a.ff === primary ? -1 : b.ff === primary ? 1 : 0));
  for (const { ff, findings } of ordered) {
    for (const f of findings) {
      const key = keyOf(f);
      let slot = byKey.get(key);
      if (!slot) {
        slot = new Map();
        byKey.set(key, slot);
        order.push(key);
      }
      // Within one profile the first occurrence wins; the inputs are already
      // deduplicated per profile, so a repeat here is not expected.
      if (!slot.has(ff)) slot.set(ff, f);
    }
  }

  return order.map((key) => {
    const slot = byKey.get(key)!;
    const affects = ORDER.filter((ff) => slot.has(ff));
    const priorityBy: Partial<Record<FormFactor, Priority>> = {};
    for (const ff of affects) priorityBy[ff] = slot.get(ff)!.priority;

    const primaryHit = slot.get(primary);
    const base = primaryHit ?? slot.get(affects[0]!)!;
    const priority = primaryHit ? primaryHit.priority : demote(base.priority);

    const merged: FormFactorFinding = {
      ...base,
      priority,
      priority_by_form_factor: priorityBy,
      affects_form_factors: affects,
      ...(multi ? { form_factor_specific: affects.length === 1 } : {}),
    };
    if (multi && options.legacyEvidence) {
      merged.evidence = {
        ...base.evidence,
        affects_form_factors: affects,
        form_factor_specific: affects.length === 1,
      };
    }
    return merged;
  });
}
