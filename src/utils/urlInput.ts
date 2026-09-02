/**
 * One input, three shapes.
 *
 * People arrive with a URL, a list they pasted from a spreadsheet, or a CSV
 * export. Making them say which is which is a tax on the common case, and an
 * agent relaying a user's request should not have to guess a parameter name.
 * So the `url` input accepts any of the three and this module works out what it
 * was given.
 *
 * Detection is by shape, not by a flag, and deliberately conservative: anything
 * ambiguous is reported rather than guessed at, because silently auditing the
 * wrong set of pages is worse than an error.
 */

import { existsSync } from "node:fs";
import { readUrlsFromCsv } from "./csvReader.js";

export type UrlInputKind = "single" | "list" | "csv";

export interface ResolvedUrls {
  urls: string[];
  kind: UrlInputKind;
  /** Where a CSV was read from, or the column used. Empty for the other kinds. */
  source?: string;
  warnings: string[];
}

const LOOKS_LIKE_URL = /^https?:\/\//i;

function normalise(raw: string): string | null {
  const trimmed = raw.trim().replace(/^['"]|['"]$/g, "");
  if (!trimmed) return null;
  // A bare domain is what people actually paste; assume https rather than
  // rejecting it, and say so in a warning.
  const candidate = LOOKS_LIKE_URL.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    return new URL(candidate).toString();
  } catch {
    return null;
  }
}

function looksLikeCsvPath(value: string): boolean {
  const trimmed = value.trim();
  if (LOOKS_LIKE_URL.test(trimmed)) return false;
  if (trimmed.includes(",")) return false; // a list, not a path
  return /\.(csv|tsv|txt)$/i.test(trimmed) || existsSync(trimmed);
}

/**
 * Resolve whatever was handed in into a URL list.
 *
 * Order matters: the CSV check runs first because a path can contain no commas
 * and no scheme, which would otherwise be coerced into `https://./file.csv`.
 */
export function resolveUrlInput(input: string): ResolvedUrls {
  const warnings: string[] = [];
  const raw = input.trim();

  if (!raw) throw new Error("No URL, list, or CSV path was provided.");

  if (looksLikeCsvPath(raw)) {
    if (!existsSync(raw)) {
      throw new Error(
        `"${raw}" looks like a file path but does not exist. Pass a URL, a ` +
          `comma-separated list of URLs, or the path to a readable CSV.`,
      );
    }
    const csv = readUrlsFromCsv(raw);
    warnings.push(...csv.warnings);
    if (csv.urls.length === 0) {
      throw new Error(`No usable URLs found in ${raw}.`);
    }
    return {
      urls: csv.urls,
      kind: "csv",
      source: `${raw} (column "${csv.column}")`,
      warnings,
    };
  }

  // Split on commas and newlines — pasted lists arrive both ways, and a
  // multi-line paste is the same intent as a comma-separated one.
  const parts = raw
    .split(/[,\n]/)
    .map((p) => p.trim())
    .filter(Boolean);

  const urls: string[] = [];
  const rejected: string[] = [];
  const seen = new Set<string>();
  let coerced = 0;

  for (const part of parts) {
    const url = normalise(part);
    if (!url) {
      rejected.push(part);
      continue;
    }
    if (!LOOKS_LIKE_URL.test(part.trim())) coerced++;
    if (seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }

  if (urls.length === 0) {
    throw new Error(
      `Could not read any URL from "${raw.slice(0, 120)}". Pass a URL, a ` +
        `comma-separated list, or a path to a CSV.`,
    );
  }
  if (rejected.length > 0) {
    warnings.push(`Ignored ${rejected.length} unparseable entr${rejected.length === 1 ? "y" : "ies"}: ${rejected.slice(0, 3).join(", ")}`);
  }
  if (coerced > 0) {
    warnings.push(`Assumed https:// for ${coerced} entr${coerced === 1 ? "y" : "ies"} that had no scheme.`);
  }
  if (parts.length > urls.length + rejected.length) {
    warnings.push(`Removed ${parts.length - urls.length - rejected.length} duplicate URL(s).`);
  }

  return { urls, kind: urls.length === 1 ? "single" : "list", warnings };
}

/** Accept an explicit array too, for callers that already have one. */
export function resolveUrlInputs(
  input: string | undefined,
  urls: string[] | undefined,
): ResolvedUrls {
  if (urls && urls.length > 0) {
    const resolved: string[] = [];
    const seen = new Set<string>();
    const warnings: string[] = [];
    for (const raw of urls) {
      const url = normalise(raw);
      if (!url) {
        warnings.push(`Ignored unparseable URL "${raw}".`);
        continue;
      }
      if (seen.has(url)) continue;
      seen.add(url);
      resolved.push(url);
    }
    if (resolved.length === 0) throw new Error("None of the supplied urls were parseable.");
    return { urls: resolved, kind: resolved.length === 1 ? "single" : "list", warnings };
  }
  if (!input) throw new Error("Provide `url` (a URL, comma-separated list, or CSV path) or `urls`.");
  return resolveUrlInput(input);
}
