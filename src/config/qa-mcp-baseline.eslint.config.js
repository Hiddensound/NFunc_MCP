// QA MCP baseline ESLint config — purely bug-risk rules, no style/formatting.
// Targets JS/JSX files only; TypeScript files require @typescript-eslint/parser.
// Used as fallback when the target repo has no ESLint config of its own.
export default [
  {
    files: ["**/*.js", "**/*.mjs", "**/*.cjs", "**/*.jsx"],
    ignores: ["**/node_modules/**", "**/dist/**"],
    rules: {
      "no-unused-vars": "error",
      "no-undef": "error",
      eqeqeq: "error",
      "no-unreachable": "error",
      "no-console": "warn",
      "no-empty": "error",
      "no-constant-condition": "error",
    },
  },
];
