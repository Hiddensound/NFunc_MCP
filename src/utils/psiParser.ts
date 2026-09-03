/**
 * PageSpeed Insights response parsing.
 *
 * One PSI call returns two unrelated datasets: `lighthouseResult` (a lab run
 * on Google's hardware) and `loadingExperience` (CrUX field data from real
 * Chrome users). They are measured differently, they disagree routinely, and
 * conflating them produces confidently wrong reports — so they stay separate
 * all the way through this module and only meet in the comparator.
 *
 * The lab half is the same LHR schema `parseLighthouseJSON` already handles
 * and is delegated to it unchanged. Everything here is about the field half
 * and about pulling numeric lab metrics that survive aggregation.
 */

import { parseLighthouseJSON, type ParsedLighthouse } from "./outputParsers.js";

export type CruxCategory = "FAST" | "AVERAGE" | "SLOW" | "NONE";

/** The five field metrics PSI reports. `fid` is deliberately absent — see below. */
export type WebVital = "lcp" | "inp" | "cls" | "fcp" | "ttfb";

export type FieldSource = "url" | "origin";

export interface CruxMetric {
  /**
   * 75th percentile across the collection window. Milliseconds for every
   * metric except `cls`, which is unitless.
   */
  p75: number;
  category: CruxCategory;
  /** Share of real users in each bucket. Sums to ~1. */
  distribution: { good: number; needsImprovement: number; poor: number };
  /**
   * Whether this specific metric came from the URL or from origin-wide data.
   * Per metric, not per response — see the note on `parseCrux`.
   */
  source: FieldSource;
}

export interface ParsedCrux {
  /**
   * Always 28. PSI does not return the collection window, but CrUX in PSI is
   * defined as a trailing 28-day aggregate, so this is a documented constant
   * rather than a parsed value. Stated explicitly because reports must not
   * describe field data as real-time.
   */
  collectionPeriodDays: 28;
  overallCategory: CruxCategory | null;
  /** Which source the majority of metrics came from, for a one-line summary. */
  primarySource: FieldSource;
  metrics: Partial<Record<WebVital, CruxMetric>>;
}

export interface LabMetrics {
  lcpMs: number | null;
  fcpMs: number | null;
  cls: number | null;
  tbtMs: number | null;
  speedIndexMs: number | null;
  ttiMs: number | null;
  ttfbMs: number | null;
}

export interface ParsedPsi {
  requestedUrl: string;
  finalUrl: string;
  strategy: string;
  fetchTime: string | null;
  lighthouseVersion: string | null;
  scores: Record<string, number>;
  lab: LabMetrics;
  /** Null when the URL has too little real-user traffic and origin fallback is off or empty. */
  field: ParsedCrux | null;
  lighthouse: ParsedLighthouse;
  /** Lighthouse audits that failed, for the existing defect formatter. */
  runWarnings: string[];
}

/** PSI returned a 200 whose Lighthouse run did not actually complete. */
export class PsiRuntimeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PsiRuntimeError";
  }
}

// --- Raw response shapes (only the fields we read) --------------------------

interface RawCruxMetric {
  percentile?: number;
  category?: string;
  distributions?: Array<{ min?: number; max?: number; proportion?: number }>;
}

interface RawLoadingExperience {
  id?: string;
  overall_category?: string;
  metrics?: Record<string, RawCruxMetric>;
}

interface RawPsiResponse {
  loadingExperience?: RawLoadingExperience;
  originLoadingExperience?: RawLoadingExperience;
  lighthouseResult?: {
    requestedUrl?: string;
    finalUrl?: string;
    finalDisplayedUrl?: string;
    fetchTime?: string;
    lighthouseVersion?: string;
    runWarnings?: string[];
    runtimeError?: { code?: string; message?: string };
    configSettings?: { formFactor?: string };
  };
}

/**
 * CrUX metric key → our vital name.
 *
 * FIRST_INPUT_DELAY_MS is intentionally not mapped. FID was retired in March
 * 2024 and replaced by INP; it still appears in some responses, and treating
 * it as a current metric would report a defect against a standard Google no
 * longer measures. Read it only if a caller ever needs historical data.
 */
const CRUX_KEYS: Record<string, WebVital> = {
  LARGEST_CONTENTFUL_PAINT_MS: "lcp",
  INTERACTION_TO_NEXT_PAINT: "inp",
  CUMULATIVE_LAYOUT_SHIFT_SCORE: "cls",
  FIRST_CONTENTFUL_PAINT_MS: "fcp",
  EXPERIMENTAL_TIME_TO_FIRST_BYTE: "ttfb",
};

/**
 * CLS is the one field metric PSI returns scaled by 100: a `percentile` of 55
 * means a CLS of 0.55, and the distribution bucket boundaries (0-10, 10-25)
 * are scaled the same way. Comparing the raw integer against the 0.25 "poor"
 * threshold marks every site on earth as catastrophic; forgetting the scaling
 * entirely turns a 0.55 into a 55. Verified against real responses.
 */
function scaleCruxValue(vital: WebVital, percentile: number): number {
  return vital === "cls" ? percentile / 100 : percentile;
}

function toCategory(raw: string | undefined): CruxCategory {
  return raw === "FAST" || raw === "AVERAGE" || raw === "SLOW" ? raw : "NONE";
}

function toDistribution(
  raw: RawCruxMetric["distributions"],
): CruxMetric["distribution"] {
  const share = (i: number): number => {
    const p = raw?.[i]?.proportion;
    return typeof p === "number" ? Number(p.toFixed(4)) : 0;
  };
  // PSI always emits exactly three buckets, ordered good → poor.
  return { good: share(0), needsImprovement: share(1), poor: share(2) };
}

function readMetric(
  raw: RawCruxMetric | undefined,
  vital: WebVital,
  source: FieldSource,
): CruxMetric | null {
  if (!raw || typeof raw.percentile !== "number") return null;
  return {
    p75: scaleCruxValue(vital, raw.percentile),
    category: toCategory(raw.category),
    distribution: toDistribution(raw.distributions),
    source,
  };
}

/**
 * Merge URL-level and origin-level CrUX into one metric set.
 *
 * Field availability is **per metric, not per URL** — a page can have enough
 * traffic for CrUX to report CLS but not LCP. A real response in the Five
 * Below batch carried two of the five metrics at URL level while the origin
 * carried all five, which is why the manual audit shows "No field data" for
 * one metric and a category for another on the same row.
 *
 * So the fallback runs per metric, and each metric records where it came from.
 * A single response-level `field_source` flag would have to either discard the
 * URL-level metrics that do exist or silently label origin data as page data,
 * and origin CrUX for a homepage says nothing about a checkout page.
 */
export function parseCrux(
  urlLevel: RawLoadingExperience | undefined,
  originLevel: RawLoadingExperience | undefined,
  originFallback: boolean,
): ParsedCrux | null {
  const metrics: Partial<Record<WebVital, CruxMetric>> = {};
  let fromUrl = 0;
  let fromOrigin = 0;

  /**
   * PSI performs its own origin fallback, and does it silently.
   *
   * When a URL has too little traffic, `loadingExperience` comes back populated
   * with **origin-level** numbers and the only signal is its `id`, which holds
   * the origin instead of the URL. Trusting the block's position in the
   * response therefore labels origin data as page data: two different paginated
   * URLs came back with byte-identical p75 values, both marked `source: "url"`.
   *
   * Comparing the two blocks' ids catches it without needing the requested URL.
   */
  const psiSubstitutedOrigin =
    Boolean(urlLevel?.id) && Boolean(originLevel?.id) && urlLevel?.id === originLevel?.id;
  const urlLevelSource: FieldSource = psiSubstitutedOrigin ? "origin" : "url";

  for (const [cruxKey, vital] of Object.entries(CRUX_KEYS)) {
    const atUrl = readMetric(urlLevel?.metrics?.[cruxKey], vital, urlLevelSource);
    if (atUrl) {
      metrics[vital] = atUrl;
      if (urlLevelSource === "url") fromUrl++;
      else fromOrigin++;
      continue;
    }
    if (!originFallback) continue;
    const atOrigin = readMetric(originLevel?.metrics?.[cruxKey], vital, "origin");
    if (atOrigin) {
      metrics[vital] = atOrigin;
      fromOrigin++;
    }
  }

  if (fromUrl === 0 && fromOrigin === 0) return null;

  // Only trust the URL-level verdict when the URL actually supplied data;
  // otherwise the origin's verdict is the one describing these numbers.
  const overallRaw =
    fromUrl > 0 ? urlLevel?.overall_category : originLevel?.overall_category;

  return {
    collectionPeriodDays: 28,
    overallCategory: overallRaw ? toCategory(overallRaw) : null,
    primarySource: fromUrl >= fromOrigin ? "url" : "origin",
    metrics,
  };
}

/**
 * Lab metrics as numbers.
 *
 * `numericValue`, never `displayValue`. The Five Below CSV recorded TTFB as
 * "Root document took 930 ms" — a localised string containing a non-breaking
 * space — because it read displayValue, which made the whole column
 * unaggregatable while `numericValue: 929` sat in the same audit object.
 * Formatting is a report-time concern; nothing upstream of the report should
 * hold a number as text.
 */
export function extractLabMetrics(auditsJson: string): LabMetrics {
  const audits = JSON.parse(auditsJson) as {
    audits?: Record<string, { numericValue?: number }>;
  };
  const num = (id: string): number | null => {
    const v = audits.audits?.[id]?.numericValue;
    return typeof v === "number" ? v : null;
  };
  const ms = (id: string): number | null => {
    const v = num(id);
    return v === null ? null : Math.round(v);
  };

  return {
    lcpMs: ms("largest-contentful-paint"),
    fcpMs: ms("first-contentful-paint"),
    // CLS is unitless and small; rounding it to an integer would destroy it.
    cls: num("cumulative-layout-shift"),
    tbtMs: ms("total-blocking-time"),
    speedIndexMs: ms("speed-index"),
    ttiMs: ms("interactive"),
    ttfbMs: ms("server-response-time"),
  };
}

export interface ParsePsiOptions {
  strategy: string;
  /** Fall back to origin-wide CrUX per metric when URL-level data is absent. */
  originFallback?: boolean;
}

/**
 * Parse a full PSI v5 response.
 *
 * Throws `PsiRuntimeError` when Lighthouse itself failed inside a 200
 * response. PSI does this routinely — a page that times out or refuses the
 * fetch comes back as HTTP 200 with `lighthouseResult.runtimeError` set and
 * every score null. Parsing it anyway records a real page as scoring zero
 * across the board, which is worse than a failed run, because a zero looks
 * like data. Callers should treat this as retryable.
 */
export function parsePsiResponse(
  rawJson: string,
  options: ParsePsiOptions,
): ParsedPsi {
  const { strategy, originFallback = true } = options;
  const response = JSON.parse(rawJson) as RawPsiResponse;
  const lhr = response.lighthouseResult;

  if (!lhr) {
    throw new PsiRuntimeError(
      "NO_LIGHTHOUSE_RESULT",
      "PSI response contained no lighthouseResult.",
    );
  }
  if (lhr.runtimeError?.code) {
    throw new PsiRuntimeError(
      lhr.runtimeError.code,
      lhr.runtimeError.message ?? "Lighthouse reported a runtime error.",
    );
  }

  // parseLighthouseJSON takes the serialised LHR. Re-serialising the object we
  // already hold is a little wasteful, but it keeps the Phase 2-13 parser and
  // its priority mapping untouched, which is worth more than the milliseconds.
  const lhrJson = JSON.stringify(lhr);
  const lighthouse = parseLighthouseJSON(lhrJson);

  return {
    requestedUrl: lhr.requestedUrl ?? "",
    finalUrl: lhr.finalDisplayedUrl ?? lhr.finalUrl ?? lhr.requestedUrl ?? "",
    strategy,
    fetchTime: lhr.fetchTime ?? null,
    lighthouseVersion: lhr.lighthouseVersion ?? null,
    scores: lighthouse.categoryScores,
    lab: extractLabMetrics(lhrJson),
    field: parseCrux(
      response.loadingExperience,
      response.originLoadingExperience,
      originFallback,
    ),
    lighthouse,
    runWarnings: lhr.runWarnings ?? [],
  };
}
