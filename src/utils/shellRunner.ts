import { execa, type ExecaError } from "execa";

export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

export interface ShellRunOptions {
  timeoutMs?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export async function runShell(
  command: string,
  args: string[] = [],
  options: ShellRunOptions = {},
): Promise<ShellResult> {
  const { timeoutMs = 60_000, cwd, env } = options;
  const start = Date.now();
  try {
    const result = await execa(command, args, {
      timeout: timeoutMs,
      cwd,
      env,
      reject: false,
    });
    return {
      stdout: typeof result.stdout === "string" ? result.stdout : "",
      stderr: typeof result.stderr === "string" ? result.stderr : "",
      exitCode: typeof result.exitCode === "number" ? result.exitCode : -1,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    const e = err as ExecaError;
    return {
      stdout: typeof e.stdout === "string" ? e.stdout : "",
      stderr:
        typeof e.stderr === "string"
          ? e.stderr
          : (e.message ?? "shellRunner: unknown error"),
      exitCode: typeof e.exitCode === "number" ? e.exitCode : -1,
      durationMs: Date.now() - start,
    };
  }
}
