import type { ShellResult } from "./shellRunner.js";

interface McpErrorResponse {
  [x: string]: unknown;
  content: { type: "text"; text: string }[];
  isError: true;
}

function envelope(payload: Record<string, unknown>): McpErrorResponse {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    isError: true,
  };
}

// External tool ran but produced no usable stdout (missing output, wrong exit
// code, etc.). Use this when the failure is in the upstream process itself.
export function shellErrorResponse(
  reason: string,
  result: ShellResult,
): McpErrorResponse {
  return envelope({
    error: reason,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    stderr: result.stderr.slice(0, 2000),
  });
}

// External tool produced output but parsing/normalising it failed. Use this
// when we have stdout but it didn't conform to the expected shape.
export function parseErrorResponse(
  reason: string,
  err: unknown,
  result: ShellResult,
): McpErrorResponse {
  return envelope({
    error: reason,
    message: err instanceof Error ? err.message : String(err),
    stderrPreview: result.stderr.slice(0, 500),
  });
}
