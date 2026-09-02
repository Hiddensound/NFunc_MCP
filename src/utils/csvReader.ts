/**
 * URL extraction from a CSV.
 *
 * People arrive with a spreadsheet — an SEO export, a analytics top-pages
 * report, a hand-written list — and the URL column is never in the same place
 * twice. This finds it rather than demanding a fixed format, because the
 * alternative is a tool that rejects the file the user actually has.
 *
 * The parser is a small RFC4180 implementation instead of a split on commas:
 * URLs contain commas inside quoted fields often enough that naive splitting
 * silently truncates them.
 */

import { readFileSync } from "node:fs";

export interface CsvUrlResult {
  urls: string[];
  /** Header name of the column used, or a positional description. */
  column: string;
  rowsRead: number;
  warnings: string[];
}

/** Delimiters worth guessing between, in preference order. */
const DELIMITERS = [",", ";", "\t", "|"];

/** Header names that mean "this is the URL column", lowercased. */
const URL_HEADERS = new Set([
  "url", "urls", "page", "page url", "page_url", "address", "link", "loc",
  "landing page", "landing_page", "full url", "final url", "request url",
]);

function detectDelimiter(sample: string): string {
  let best = ",";
  let bestCount = 0;
  for (const d of DELIMITERS) {
    // Count on the header line only; body rows can contain stray delimiters.
    const count = (sample.split(d).length - 1);
    if (count > bestCount) {
      best = d;
      bestCount = count;
    }
  }
  return best;
}

/** RFC4180: quoted fields may contain the delimiter, newlines, and "" escapes. */
function parseCsv(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch !== "\r") {
      field += ch;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

function looksLikeUrl(value: string): boolean {
  const v = value.trim();
  if (!/^https?:\/\//i.test(v)) return false;
  try {
    new URL(v);
    return true;
  } catch {
    return false;
  }
}

/**
 * Pick the URL column.
 *
 * Header match first, because a file that names its columns is telling us
 * where to look. Falling back to content sniffing covers headerless exports
 * and files whose URL column is called something unguessable — the column
 * where the most cells parse as URLs is the column, regardless of its name.
 */
function pickUrlColumn(rows: string[][]): { index: number; label: string; hasHeader: boolean } | null {
  if (rows.length === 0) return null;

  const header = rows[0].map((h) => h.trim().toLowerCase());
  const headerIsData = header.some(looksLikeUrl);

  if (!headerIsData) {
    const named = header.findIndex((h) => URL_HEADERS.has(h));
    if (named >= 0) {
      return { index: named, label: rows[0][named].trim(), hasHeader: true };
    }
  }

  const body = headerIsData ? rows : rows.slice(1);
  const width = Math.max(...rows.map((r) => r.length));
  let bestIndex = -1;
  let bestHits = 0;
  for (let col = 0; col < width; col++) {
    const hits = body.filter((r) => looksLikeUrl(r[col] ?? "")).length;
    if (hits > bestHits) {
      bestHits = hits;
      bestIndex = col;
    }
  }
  if (bestIndex < 0 || bestHits === 0) return null;

  return {
    index: bestIndex,
    label: headerIsData ? `column ${bestIndex + 1}` : (rows[0][bestIndex]?.trim() || `column ${bestIndex + 1}`),
    hasHeader: !headerIsData,
  };
}

export function readUrlsFromCsv(path: string): CsvUrlResult {
  const warnings: string[] = [];
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`Could not read CSV at ${path}: ${(err as Error).message}`);
  }

  // Strip a UTF-8 BOM; Excel adds one and it corrupts the first header name.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const rows = parseCsv(text, detectDelimiter(firstLine));
  const column = pickUrlColumn(rows);

  if (!column) {
    throw new Error(
      `No URL column found in ${path}. Expected a column named one of ` +
        `${[...URL_HEADERS].slice(0, 5).join(", ")}, or any column whose ` +
        `values start with http:// or https://.`,
    );
  }

  const body = column.hasHeader ? rows.slice(1) : rows;
  const urls: string[] = [];
  const seen = new Set<string>();
  let skipped = 0;

  for (const row of body) {
    const cell = (row[column.index] ?? "").trim();
    if (!cell) continue;
    if (!looksLikeUrl(cell)) {
      skipped++;
      continue;
    }
    if (seen.has(cell)) continue;
    seen.add(cell);
    urls.push(cell);
  }

  if (skipped > 0) {
    warnings.push(
      `Skipped ${skipped} row(s) in "${column.label}" that did not contain an http(s) URL.`,
    );
  }

  return { urls, column: column.label, rowsRead: body.length, warnings };
}
