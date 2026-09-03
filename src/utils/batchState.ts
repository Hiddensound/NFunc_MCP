/**
 * Shared machinery for tools that process a list of URLs across several calls.
 *
 * Extracted from the PSI runner, where every piece of it was earned the hard
 * way: an MCP client backgrounds a tool call at 120 seconds, local Lighthouse
 * takes 20-40 seconds per URL per form factor, and both PSI and pa11y fail
 * intermittently on real sites. A batch therefore cannot be one long call, and
 * a failure partway through must not cost the runs that already succeeded.
 *
 * The contract is: bound each call by a clock, write results to disk as they
 * land, merge rather than overwrite an index, and hand back a cursor.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Default per-call ceiling. Below the 120s at which Claude Code backgrounds a call. */
export const DEFAULT_MAX_SECONDS_PER_CALL = 100;

export interface BatchUnit {
  url: string;
  /** Device profile, engine, or whatever second dimension the tool runs over. */
  variant: string;
}

/** Anything the index can hold. Tools define their own richer result types. */
export interface BatchRecord {
  url: string;
  variant: string;
  [key: string]: unknown;
}

export function encodeCursor(index: number): string {
  return Buffer.from(JSON.stringify({ i: index })).toString("base64url");
}

export function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { i?: number };
    return typeof parsed.i === "number" && parsed.i >= 0 ? parsed.i : 0;
  } catch {
    return 0;
  }
}

/** Cross-product of URLs and variants, in URL-major order so a partial run covers whole pages. */
export function buildUnits(urls: string[], variants: string[]): BatchUnit[] {
  const units: BatchUnit[] = [];
  for (const url of urls) for (const variant of variants) units.push({ url, variant });
  return units;
}

/**
 * A filesystem-safe stem for a URL.
 *
 * Derived from the path rather than hashed so the files are browsable: someone
 * opening `output_dir` should be able to tell which page each report is for.
 */
export function slugForUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/^\/|\/$/g, "").replace(/\//g, "-");
    const query = parsed.search ? `-${parsed.search.slice(1).replace(/[^a-z0-9]+/gi, "-")}` : "";
    const stem = `${path || "homepage"}${query}`.replace(/-+/g, "-").replace(/^-|-$/g, "");
    // Long paths make unreadable filenames; the tail is the distinguishing part.
    return stem.length > 80 ? stem.slice(-80).replace(/^-/, "") : stem;
  } catch {
    return "url";
  }
}

export interface IndexMergeResult {
  indexPath: string;
  total: number;
}

/**
 * Merge records into the running index, keyed on URL + variant.
 *
 * Merging rather than overwriting is what lets a second pass fill gaps without
 * discarding the first pass, and what lets the final aggregate cover the whole
 * batch instead of only the last chunk.
 */
export async function mergeIndex<T extends BatchRecord>(
  dir: string,
  records: T[],
  fileName = "_index.json",
): Promise<IndexMergeResult> {
  await mkdir(dir, { recursive: true });
  const indexPath = join(dir, fileName);
  let existing: T[] = [];
  try {
    existing = JSON.parse(await readFile(indexPath, "utf8")) as T[];
  } catch {
    existing = [];
  }
  const byKey = new Map(existing.map((r) => [`${r.url}|${r.variant}`, r]));
  for (const record of records) byKey.set(`${record.url}|${record.variant}`, record);
  const merged = [...byKey.values()];
  await writeFile(indexPath, JSON.stringify(merged, null, 2), "utf8");
  return { indexPath, total: merged.length };
}

export async function readIndex<T extends BatchRecord>(
  dir: string,
  fileName = "_index.json",
): Promise<T[]> {
  try {
    return JSON.parse(await readFile(join(dir, fileName), "utf8")) as T[];
  } catch {
    return [];
  }
}

/**
 * Drop work already recorded in the index.
 *
 * Re-running to fill gaps is the normal workflow, not an edge case, because
 * these tools fail intermittently on real sites. Without this, the advice
 * "just run it again" silently re-does — and on metered APIs re-charges for —
 * everything that already worked.
 *
 * Only applies when no cursor is in play: a cursor indexes into the unfiltered
 * list, so filtering would misalign it.
 */
export async function filterCompleted(
  dir: string,
  units: BatchUnit[],
  skipCompleted: boolean,
  cursor: string | undefined,
): Promise<{ units: BatchUnit[]; skipped: number }> {
  if (!skipCompleted || cursor) return { units, skipped: 0 };
  const existing = await readIndex(dir);
  if (existing.length === 0) return { units, skipped: 0 };
  const done = new Set(existing.map((r) => `${r.url}|${r.variant}`));
  const remaining = units.filter((u) => !done.has(`${u.url}|${u.variant}`));
  return { units: remaining, skipped: units.length - remaining.length };
}

/**
 * Whether there is room to start another unit.
 *
 * Checked before a unit begins, never mid-unit, and it reserves the expected
 * cost of the work about to start rather than only asking whether the budget is
 * already spent — otherwise a 40-second run beginning at the 99-second mark
 * overshoots by a full unit. The PSI runner overran a 150s budget by 38s
 * before this reserve existed.
 */
export function hasBudget(
  startedAt: number,
  budgetMs: number,
  reserveMs: number,
  unitsDone: number,
): boolean {
  if (unitsDone === 0) return true; // always attempt at least one
  return Date.now() - startedAt + reserveMs < budgetMs;
}

export function elapsedSeconds(startedAt: number): number {
  return Math.round((Date.now() - startedAt) / 1000);
}
