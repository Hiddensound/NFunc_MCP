# Changelog

All notable changes to `nfunc-mcp`. Versions match the npm package and the
`v*` git tags.

## 0.8.0 — 2026-09-29

Bundled browser and lint CLIs, and a dependency check. Includes everything in
0.7.0, which was tagged but never published to npm.

### Breaking

- **Requires Node `^22.19.0 || >=24`** (was `>=18`). The bundled Lighthouse 13
  needs Node 22.19+, and pa11y 10 supports `^22.13 || >=24`, which rules out
  Node 23. CI now runs on Node 22 and 24.

### Added

- **Lighthouse (`^13.5.0`), pa11y (`^10.0.0`) and ESLint (`^10.11.0`) are now
  dependencies.** Binaries resolve from this package's `node_modules/.bin`, or
  the enclosing `node_modules/.bin` npm hoists them into, before falling back
  to `PATH`. ESLint still prefers the scanned project's own binary first, so
  projects on legacy `.eslintrc` keep their pinned ESLint; the bundled ESLint
  10 reads flat config only. Installing pa11y downloads a headless Chrome
  (~150 MB) through puppeteer. Semgrep and Trivy remain `PATH` installs.
- **`check_dependencies` tool.** Returns
  `{ tool, binary, found, version, source, path, install_hint }` for
  lighthouse, pa11y, eslint, semgrep and trivy, where `source` is
  `"bundled" | "project" | "path" | null`. The trivy entry also carries
  `trivy_db_updated_at` and `trivy_db_age_days`. It warns when Trivy's database
  is older than 7 days or missing.
- `run_security_scan` `db_status` now includes `trivy_db_age_days`.

### Changed

- `unavailable[].install_hint` for lighthouse, pa11y and eslint now says the
  tool is bundled and suggests a reinstall, with a global install as the
  fallback.

## 0.7.0 — 2026-09-29 (tagged, not published to npm)

Pre-merge review support: form-factor-aware gating, diff tagging, stable ids,
and structured reporting of tools that could not run. PSI tools
(`plan_performance_audit`, `run_performance_audit`) are unchanged.

### Changed — behaviour

- **`run_qa_gate` headline scores now follow `primary_form_factor`** (default
  `desktop`). Previously, with `form_factor: "both"`, the scorecard's
  Lighthouse `breakdown` and `sub_scores.lighthouse` took the *worst* score per
  category across the two profiles. They now come from the primary profile;
  both profiles are in the new `scores_by_form_factor`. `sub_scores.pa11y` is
  likewise computed from the primary profile's findings. This is the one
  existing field whose meaning changes.
- `run_qa_gate` with `form_factor: "both"` no longer lets the mobile run decide
  every merged finding's priority and evidence (first-profile-wins). The
  primary profile's priority and evidence apply; findings only the other
  profile reports are **demoted one tier** (P1→P2, P2→P3).
  `release_readiness` is computed from these adjusted priorities.
- `run_qa_gate` now runs pa11y at the mobile viewport (the same 412×823 config
  `run_accessibility_check` uses) when `form_factor` is `mobile` or `both`. It
  previously always ran at desktop size.
- `run_qa_gate`'s static scorecard entry is `UNAVAILABLE` and
  `sub_scores.static` is `null` when neither ESLint nor Semgrep ran. It used to
  report `PASS` and a clean 100.
- `run_qa_gate`'s Semgrep leg now reports Semgrep errors (exit code 2), matching
  `run_static_analysis`. The two share one implementation.
- `id` on `run_qa_gate` findings changed format, from readable keys such as
  `lh:image-alt` and `static:eslint:app.js:12` to stable hashes (below).
  `related_findings` references use the new ids.

### Added

- **`primary_form_factor`** on `run_qa_gate`. Every Lighthouse and pa11y finding
  carries `priority_by_form_factor`, `affects_form_factors`, and (when both
  profiles ran) `form_factor_specific`. pa11y findings are merged across
  profiles by `(rule_code, selector)`. New top-level `scores`,
  `scores_by_form_factor`, `form_factor` and `primary_form_factor`.
- **`changed_files`** on `run_qa_gate`, `run_static_analysis` and
  `run_security_scan`. File-based findings get `in_diff`: ESLint, Semgrep, and
  Trivy secret and misconfig findings by file, Trivy vulnerabilities by their
  lockfile or its manifest. Nothing is filtered. The report adds
  `diff_summary: { in_diff: {P1,P2,P3}, preexisting: {P1,P2,P3} }`.
- **Stable finding `id`** on every finding from `run_qa_gate`, `run_lighthouse`,
  `run_accessibility_check`, `run_static_analysis` and `run_security_scan`: the
  tool name plus 12 hex characters of a SHA-256 over tool, rule, location and
  URL. Form factor is excluded, and file paths are made relative to the scan
  root.
- **`output_dir`** on `run_qa_gate`: writes the HTML report and a JSON copy of
  the result there. Paths are returned in `report_paths`.
- **`unavailable: [{ tool, binary, reason, install_hint }]`** on `run_qa_gate`,
  `run_static_analysis` and `run_security_scan`, for a missing binary
  (`reason: "not_installed"`) or Semgrep registry rulesets that could not be
  downloaded (`reason: "network"`).
- **`ruleset`** on `run_qa_gate`, passed through to Semgrep. On both tools it
  now also accepts an array or a comma-separated string.
- `language` on `run_static_analysis` is now implemented. It was accepted before
  but ignored. `js` → `p/javascript`, `ts` → `p/javascript` + `p/typescript`,
  `python` → `p/python` with ESLint skipped. `run_static_analysis` also returns
  `semgrep_rulesets`.
- `context` on `run_qa_gate` is now echoed into the report and the HTML header.
  It was accepted before but ignored. It changes no check.
- `npm test` (node:test with fixture JSON), `npm run typecheck`, and a GitHub
  Actions workflow that runs build, typecheck and tests on Node 20 and 22.

### Fixed — docs

- `docs/manual.md`: `run_qa_gate` `form_factor` defaults to `desktop`, not
  `mobile`. The composite-score section now describes the decay-based
  weighted mean instead of the retired "100 − 15/7/3" formula. ESLint errors
  are P2, not P1.

## 0.6.0

- `run_security_scan`: Trivy vulnerabilities, secrets and misconfigurations,
  grouped per remediation and prioritised on remediability.
- This release was published to npm from commit `332d04f` before that commit
  was pushed. It and the `v0.2.0`–`v0.6.0` tags are now on GitHub.
