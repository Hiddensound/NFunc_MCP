import { existsSync } from "fs";
import { join } from "path";

// Checked in priority order: flat config first, then legacy formats.
const CONFIG_FILES = [
  "eslint.config.js",
  "eslint.config.mjs",
  ".eslintrc.js",
  ".eslintrc.json",
  ".eslintrc.yml",
  ".eslintrc.yaml",
  ".eslintrc",
];

export interface ESLintConfigResult {
  hasConfig: boolean;
  configFile: string | null;
}

export function detectESLintConfig(targetPath: string): ESLintConfigResult {
  for (const file of CONFIG_FILES) {
    if (existsSync(join(targetPath, file))) {
      return { hasConfig: true, configFile: file };
    }
  }
  return { hasConfig: false, configFile: null };
}
