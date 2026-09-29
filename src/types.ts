export type Priority = "P1" | "P2" | "P3";

export interface Finding {
  priority: Priority;
  title: string;
  description: string;
  evidence: Record<string, unknown>;
  /**
   * Deterministic finding id — see src/mappers/findingId.ts. Optional on the
   * type because formatters produce findings before the tool layer knows the
   * URL or scan root the id is derived from; every tool assigns it before
   * returning.
   */
  id?: string;
  /**
   * Whether the finding's file is in the caller's `changed_files`. Present only
   * on file-based findings, and only when `changed_files` was supplied.
   */
  in_diff?: boolean;
}

/**
 * A CLI that could not run. Structured so a caller (OCS `/self-review`) can
 * print the install step rather than parse a warning string.
 */
export interface UnavailableTool {
  tool: string;
  binary: string;
  /** "not_installed": binary missing from PATH. "network": needs network access it did not get. */
  reason: "not_installed" | "network";
  install_hint: string;
}
