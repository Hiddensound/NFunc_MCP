import { createHash } from "node:crypto";
import { isAbsolute, normalize, relative, sep } from "node:path";
import type { Finding } from "../types.js";

/**
 * Deterministic finding ids.
 *
 * An id is a short hash of (tool, rule, location, url), so re-running the same
 * check against unchanged code produces the same id and a caller can confirm
 * that one specific finding is gone after a fix — which a count or a title
 * cannot do, since titles repeat across elements and counts move for
 * unrelated reasons.
 *
 * What goes in, per finding class:
 *
 *   Lighthouse   rule = audit_id                location = ""
 *   pa11y        rule = rule_code               location = selector ("*" when systemic)
 *   ESLint etc.  rule = rule_id                 location = relative file:line
 *                (Trivy misconfigs append #resource when Trivy names one)
 *   Trivy vuln   rule = package@version         location = relative target (lockfile)
 *
 * Form factor is deliberately never an input: the desktop and mobile copies
 * of one defect are one finding with one id.
 *
 * File paths are made relative to the scan root first, so the same checkout
 * in two directories (a CI runner and a laptop) produces the same ids.
 *
 * Line numbers are part of the location, as specified — which means an edit
 * above a finding shifts its line and changes its id. That is the price of
 * telling two identical rule hits in one file apart.
 */

const HASH_LENGTH = 12;

export function findingId(parts: {
  tool: string;
  rule: string;
  location: string;
  url?: string;
}): string {
  const input = [parts.tool, parts.rule, parts.location, normaliseUrl(parts.url)].join("␟");
  const hash = createHash("sha256").update(input).digest("hex").slice(0, HASH_LENGTH);
  return `${parts.tool}-${hash}`;
}

/**
 * `new URL().href` folds the trivial spellings of one URL — a missing trailing
 * slash on an origin, upper-case host — into one form, so they do not produce
 * two ids for one page.
 */
function normaliseUrl(url: string | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
}

/**
 * A tool-reported path → forward-slash path relative to `root`.
 *
 * ESLint reports absolute paths, Semgrep and Trivy report paths relative to
 * their cwd; both land in the same form here.
 */
export function toRelativePath(root: string, file: string): string {
  if (!file) return "";
  const rel = isAbsolute(file) ? relative(root, file) : normalize(file);
  return rel.split(sep).join("/").replace(/^\.\//, "");
}

export function lighthouseFindingId(f: Finding, url: string): string {
  return findingId({
    tool: "lighthouse",
    rule: String(f.evidence["audit_id"] ?? f.title),
    location: "",
    url,
  });
}

/**
 * Selector used for both the id and the cross-profile merge key. A systemic
 * finding (see a11yDedupe) stands for every element failing the rule, so its
 * own selector is whichever element happened to sort worst — not a stable
 * identity. "*" is.
 */
export function a11yLocation(f: Finding): string {
  return f.evidence["systemic"] === true ? "*" : String(f.evidence["selector"] ?? "");
}

export function a11yFindingId(f: Finding, url: string): string {
  return findingId({
    tool: "pa11y",
    rule: String(f.evidence["rule_code"] ?? f.title),
    location: a11yLocation(f),
    url,
  });
}

/**
 * ESLint, Semgrep and every Trivy class. The tool name comes from
 * `evidence.source`, which all of their formatters set.
 */
export function fileFindingId(f: Finding, root: string): string {
  const e = f.evidence;
  const tool = String(e["source"] ?? "static");

  // A vulnerability group is one version bump in one lockfile — the package
  // and the lockfile are its identity, and it has no line.
  if (typeof e["package"] === "string") {
    return findingId({
      tool,
      rule: e["package"],
      location: toRelativePath(root, String(e["target"] ?? "")),
    });
  }

  const rule = String(e["rule_id"] ?? e["check_id"] ?? f.title);
  const file = toRelativePath(root, String(e["file"] ?? ""));
  const line = e["line"] ?? e["start_line"];
  let location = line !== undefined && line !== null ? `${file}:${String(line)}` : file;
  // Trivy misconfigs: two resources in one file can fail the same check, and
  // Trivy does not always give a line to tell them apart.
  if (typeof e["resource"] === "string" && e["resource"]) location += `#${e["resource"]}`;
  return findingId({ tool, rule, location });
}

export function withIds<T extends Finding>(findings: T[], idOf: (f: T) => string): T[] {
  // id first, so it leads the finding in the JSON a human reads.
  return findings.map((f) => {
    const { id: _previous, ...rest } = f;
    return { id: idOf(f), ...rest } as T;
  });
}
