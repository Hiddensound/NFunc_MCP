# nfunc-mcp

[![npm](https://img.shields.io/npm/v/nfunc-mcp)](https://www.npmjs.com/package/nfunc-mcp)

A local MCP server that gives Claude (or any MCP client) a full non-functional QA toolkit. Run Lighthouse, WCAG accessibility checks, and static code analysis — individually or all at once — and get back structured, prioritised findings you can act on immediately.

---

## Table of contents

1. [What it does](#what-it-does)
2. [Prerequisites](#prerequisites)
3. [Install & build](#install--build)
4. [Register with Claude Code](#register-with-claude-code)
5. [Tools](#tools)
6. [run_qa_gate — the main tool](#run_qa_gate--the-main-tool)
   - [Inputs](#inputs)
   - [Release readiness tiers](#release-readiness-tiers)
   - [Composite score](#composite-score)
   - [Scorecard](#scorecard)
   - [Cross-tool corroboration](#cross-tool-corroboration)
   - [HTML report](#html-report)
   - [Output shape](#output-shape)
7. [Individual tools](#individual-tools)
   - [Mobile vs desktop](#mobile-vs-desktop)
   - [Choosing an accessibility engine](#choosing-an-accessibility-engine)
8. [Priority system](#priority-system)
9. [Project layout](#project-layout)
10. [How to prompt](#how-to-prompt)

---

## What it does

`nfunc-mcp` wires four QA tools into Claude's tool-use loop:

| Capability | Tools | What it checks |
|---|---|---|
| Performance | Lighthouse | LCP, TTI, TBT, CLS, bundle size, caching |
| Accessibility | Lighthouse + pa11y | WCAG 2 AA violations, ARIA, contrast, labels |
| SEO | Lighthouse | Crawlability, robots.txt, meta, link text |
| Best practices | Lighthouse | HTTPS, deprecated APIs, third-party cookies |
| Code quality | ESLint | Dead code, undeclared vars, swallowed errors |
| Security patterns | Semgrep | OWASP JS/TS patterns |

The `run_qa_gate` orchestrator runs all of them in parallel, cross-correlates findings across tools, and produces a single structured report with a release readiness verdict, a composite health score, a per-tool scorecard, and a browser-openable HTML report.

---

## Prerequisites

`nfunc-mcp` is a thin wrapper around four CLI tools. Install the ones you need before registering the server:

| Tool | Install | Used by |
|---|---|---|
| Lighthouse | `npm install -g lighthouse` | `run_lighthouse`, `run_qa_gate` (URL) |
| pa11y | `npm install -g pa11y` | `run_accessibility_check`, `run_qa_gate` (URL) |
| ESLint | `npm install -g eslint` | `run_static_analysis`, `run_qa_gate` (path) |
| Semgrep | `brew install semgrep` or `pip install semgrep` | `run_static_analysis`, `run_qa_gate` (path) |

Verify each is reachable:

```bash
lighthouse --version
pa11y --version
eslint --version
semgrep --version
```

**You don't need all four.** If a tool is missing or not installed, the gate still runs — that tool's scorecard entry shows `UNAVAILABLE` and its findings are skipped. URL-only runs only need Lighthouse and pa11y; path-only runs only need ESLint and Semgrep.

---

## Install & register

### Option A — npm (recommended, no cloning needed)

```bash
claude mcp add nfunc-mcp -- npx -y nfunc-mcp
```

That's it. `npx` downloads and runs the server on your machine automatically. No repo clone, no build step.

### Option B — Manual config (npm)

Add to `~/.claude.json` under `mcpServers`:

```json
{
  "mcpServers": {
    "nfunc-mcp": {
      "command": "npx",
      "args": ["-y", "nfunc-mcp"]
    }
  }
}
```

### Option C — From source (contributors / local dev)

```bash
git clone https://github.com/Hiddensound/NFunc_MCP.git
cd NFunc_MCP
npm install
npm run build
claude mcp add nfunc-mcp -- node /absolute/path/to/NFunc_MCP/dist/index.js
```

### Scripts (source only)

| Script | Purpose |
|---|---|
| `npm run build` | Compile TypeScript → `dist/` |
| `npm start` | Run the compiled server |
| `npm run dev` | Run from source with hot reload (`tsx watch`) |

### Verify the connection

1. Run `/mcp` in Claude Code — `nfunc-mcp` should show as `connected`.
2. Ask Claude: *"Call the nfunc-mcp ping tool."*
3. Expected response:
   ```json
   { "status": "ok", "timestamp": "2026-05-20T12:00:00.000Z" }
   ```

---

## Tools

| Tool | Description | Inputs |
|---|---|---|
| `ping` | Health check — confirms the server is up | — |
| `run_lighthouse` | Full Lighthouse audit for a URL | `url`, `form_factor` (optional), `categories` (optional), `thresholds` (optional) |
| `run_accessibility_check` | pa11y WCAG audit for a URL | `url`, `runner` (optional), `standard` (optional), `ignore` (optional) |
| `run_static_analysis` | ESLint + Semgrep scan for a local codebase | `path` |
| `run_qa_gate` | All tools in parallel + correlation + HTML report | `url` and/or `path`, `form_factor` (optional), `a11y_runner` (optional) |

---

## run_qa_gate — the main tool

This is the tool to reach for in nearly every QA workflow. It replaces running tools individually and adds cross-tool intelligence on top.

### Inputs

Both inputs are **optional** — provide whichever you have. At least one is required.

| Input | Type | When to provide |
|---|---|---|
| `url` | string (URL) | You have a running page — production, staging, preview URL, or localhost. Enables Lighthouse and pa11y. |
| `path` | string (path) | You have a local codebase. Enables ESLint and Semgrep. |
| `context` | string | Optional. Free-text description of the project (e.g. `"React e-commerce checkout"`). Helps Claude interpret results. |
| `form_factor` | `mobile` \| `desktop` \| `both` | Optional, default `mobile`. Lighthouse device profile — see [Mobile vs desktop](#mobile-vs-desktop). |
| `a11y_runner` | `htmlcs` \| `axe` \| `both` | Optional, default `htmlcs`. pa11y engine — see [Choosing an accessibility engine](#choosing-an-accessibility-engine). |

**URL only** — browser-based checks, static analysis skipped:
```
QA snapshot — https://staging.myapp.com
```

**Path only** — static analysis only, browser checks skipped:
```
QA snapshot — /path/to/my-feature-branch
```

**Both** — full suite:
```
QA snapshot — https://staging.myapp.com, code at /path/to/repo
```

### Release readiness tiers

The `release_readiness` field replaces a binary pass/fail with four actionable tiers:

| Value | Meaning | Condition |
|---|---|---|
| `BLOCKED` | Cannot ship — P1 issues exist | Any P1 finding |
| `CONDITIONAL` | Shippable with caveats — track P2s before merging | P2 findings, no P1s |
| `ADVISORY` | Safe to ship — P3s are tech debt to log | Only P3 findings |
| `CLEAR` | No issues detected | Zero findings |

### Composite score

A single `composite_score` (0–100) gives a continuous health measure across all tools.

**Formula:** Start at 100, deduct by finding severity:

| Priority | Deduction |
|---|---|
| P1 | −15 per finding |
| P2 | −7 per finding |
| P3 | −3 per finding |

Score is floored at 0. Tracks improvement over time — a score trending upward sprint-over-sprint is a healthy signal.

### Scorecard

A compact `scorecard` array gives a one-line status per tool:

```json
[
  { "tool": "Lighthouse",       "gate": "WARN", "score": 75,
    "breakdown": { "performance": 52, "accessibility": 98, "seo": 100, "best-practices": 58 } },
  { "tool": "pa11y",            "gate": "PASS", "issues": 0 },
  { "tool": "ESLint / Semgrep", "gate": "SKIPPED" }
]
```

Gate values:

| Gate | Meaning |
|---|---|
| `PASS` | No issues at this tool's threshold |
| `WARN` | Issues exist but below the FAIL threshold |
| `FAIL` | Issues at P1 level (or Lighthouse avg < 50) |
| `SKIPPED` | Input not provided (URL or path not supplied) |
| `UNAVAILABLE` | Tool was invoked but is not installed or errored |

### Cross-tool corroboration

When Lighthouse and pa11y independently flag the same accessibility gap, those findings are:

1. **Merged** into a single entry in `corroborated_findings`
2. **Priority-promoted** one tier (P3→P2, P2→P1)
3. **Annotated** with `confidence: "high"` and `confirmed_by: ["lighthouse", "pa11y"]`

These are the highest-confidence findings in any report — two independent tools agreeing is stronger evidence than either alone. They appear in their own dedicated section above all other findings, and bubble to the top of `top_issues`.

**Corroboration mapping (Rule 1):**

| Lighthouse audit | pa11y technique |
|---|---|
| `color-contrast` | `.G18`, `.G145`, `.G174` |
| `image-alt` | `.H37`, `.H67`, `.F65` |
| `label` | `.H44`, `.F68`, `.H91.Input` |
| `link-name` | `.H30`, `.H91.A.` |
| `html-has-lang` | `.H57` |
| `button-name` | `.H91.Button` |
| *(and more)* | |

**Performance ↔ code linkage (Rule 2):** If a Lighthouse performance finding's display value contains a filename that also appears in a static analysis finding, the static finding is added as `related_findings` on the Lighthouse entry. Findings are not merged — they remain linked by reference.

### HTML report

Every `run_qa_gate` call automatically writes a self-contained HTML file to `/tmp` and returns its path as `report_file`:

```json
{
  "report_file": "file:///tmp/qa-report-myapp-com-1234567890.html"
}
```

Open the path in any browser to get:

- Release readiness banner (colour-coded)
- Composite score gauge (SVG arc, 0–100)
- Per-tool scorecard table
- Cross-confirmed findings section (highlighted)
- Collapsible finding cards grouped by P1 / P2 / P3
- Evidence and selector for each finding

No server required — the file is fully self-contained with inline CSS.

### Output shape

```jsonc
{
  "release_readiness": "BLOCKED",        // BLOCKED | CONDITIONAL | ADVISORY | CLEAR
  "composite_score": 22,                 // 0–100
  "report_file": "file:///tmp/qa-report-xxx.html",
  "scorecard": [ ... ],                  // per-tool gate + score/issues
  "eslint_config_used": "project",       // present only when path was supplied
  "summary": "110 findings (101 P1, 9 P2) across 2 tools. ...",
  "corroborated_findings": [ ... ],      // cross-confirmed, confidence: "high"
  "top_issues": [ ... ],                 // top 3 findings (corroborated first)
  "all_findings": [ ... ],               // all findings sorted by priority
  "correlations_found": 1,
  "errors": [ ... ]                      // present only if a tool errored
}
```

Each finding:

```jsonc
{
  "priority": "P1",                      // P1 | P2 | P3
  "title": "Largest Contentful Paint",
  "description": "Users see main content 34s after navigation...",
  "evidence": { "audit_id": "largest-contentful-paint", "value": "34.3 s" },
  "source_tool": "lighthouse",
  // corroborated findings also have:
  "confirmed_by": ["lighthouse", "pa11y"],
  "confidence": "high"
}
```

---

## Individual tools

### run_lighthouse

Runs a full Lighthouse audit against a URL.

```
Run Lighthouse on https://myapp.com
Run Lighthouse on https://myapp.com for mobile and desktop
```

Returns: `url`, `form_factor`, `scores` (per category), `ttfb_ms`, `findings` (priority-ordered).

#### Mobile vs desktop

`form_factor` accepts `desktop` (default), `mobile`, or `both`.

**This default deliberately differs from the Lighthouse CLI's**, which is mobile: a 412×823 screen, a mid-range Android user agent, simulated slow 4G, and a **4× CPU slowdown**. That profile is much harsher and reports substantially lower performance scores for the same page, so passing `mobile` here is not a like-for-like comparison with a default run — check `form_factor` in the response before comparing two reports.

**The two are not interchangeable.** They render different DOM, so they find different defects — not just different performance numbers. Measured against one commerce category page:

| | Mobile | Desktop |
|---|---|---|
| performance | 54 | 62 |
| accessibility | **87** | **73** |
| seo | 77 | 69 |

Five accessibility audits failed on desktop that mobile never reported — `image-alt`, `aria-required-children`, `aria-required-parent`, `aria-allowed-attr`, `aria-valid-attr-value` — while three others failed only on mobile. Neither profile is a superset of the other.

With `form_factor: "both"`, the two run concurrently (so it costs little more wall time than one), `scores` is keyed by form factor, and each finding carries `affects_form_factors` and `form_factor_specific` so device-only regressions are obvious at a glance.

### run_accessibility_check

Runs pa11y against a URL at WCAG 2 AA by default. Returns only violations (errors) — use the CLI directly with `--include-notices --include-warnings` for the full checklist.

```
Run an accessibility check on https://myapp.com
Run accessibility check at AAA standard on https://myapp.com
Run an accessibility check on https://myapp.com using the axe runner
```

Returns: `url`, `standard`, `runners`, `violation_count`, `raw_violation_count`, `findings`.

#### Choosing an accessibility engine

`runner` accepts `htmlcs` (default), `axe`, or `both`.

| Engine | Strongest at | Severity source |
|---|---|---|
| `htmlcs` | WCAG techniques, document structure, form labelling, duplicate ids | WCAG technique class |
| `axe` | **ARIA** — invalid roles, missing required parent/child relationships, prohibited and unsupported attributes — and computed colour contrast | axe's own `impact` rating |

**Reach for `axe` whenever the work under test involves ARIA, a component library, or a design system.** The overlap between the engines is smaller than you would expect. On the same page:

- htmlcs found unlabelled inputs, forms with no submit mechanism, and ten duplicate ids that axe did not report.
- axe found `aria-allowed-attr`, `aria-prohibited-attr`, `aria-required-parent`, `aria-required-children` and `image-alt` failures that htmlcs missed entirely.

`both` runs them concurrently and merges the results. Note that an element flagged by both engines appears twice, because they emit different rule codes for the same defect — that is deliberate, since two independent engines agreeing is corroboration worth seeing.

Findings from axe carry `axe_impact` in evidence, and `needs_manual_review: true` where axe wants a human to confirm (those are demoted one priority tier — a maybe should not gate a release as hard as a certainty).

### run_static_analysis

Runs ESLint and Semgrep in parallel against a local directory. Automatically uses the project's own ESLint config if one is found; otherwise falls back to a QA-focused baseline config.

```
Run static analysis on /path/to/repo
```

Returns: `path`, `tools_run`, `eslint_config_used`, `issue_count`, `findings`, `warnings`.

---

## Priority system

| Priority | Meaning | Lighthouse threshold | WCAG level | ESLint / Semgrep |
|---|---|---|---|---|
| P1 | Blocker — fix before shipping | Score < 50 | Level A | Semgrep security, ESLint error |
| P2 | Warning — track before merging | Score 50–79 | Level AA | ESLint warning |
| P3 | Advisory — log as tech debt | Score 80–89 | Level AAA | — |
| *(suppressed)* | Passing — not reported | Score ≥ 90 | — | — |

Corroborated findings are promoted one tier above where either tool would place them individually.

---

## Project layout

```
qa-mcp/
├── src/
│   ├── index.ts                         # MCP server bootstrap + tool registration
│   ├── types.ts                         # Shared types (Finding, Priority)
│   ├── config/
│   │   └── qa-mcp-baseline.eslint.config.js  # Fallback ESLint config
│   ├── tools/
│   │   ├── qaGate.ts                    # Orchestrator — runs all tools, builds report
│   │   ├── lighthouse.ts                # run_lighthouse tool
│   │   ├── accessibility.ts             # run_accessibility_check tool
│   │   └── staticAnalysis.ts            # run_static_analysis tool
│   ├── mappers/
│   │   ├── correlator.ts                # Cross-tool correlation engine (Rule 1 + 2)
│   │   ├── defectFormatter.ts           # Raw tool output → Finding objects
│   │   └── priorityMapper.ts            # Score/severity → P1/P2/P3
│   └── utils/
│       ├── reportGenerator.ts           # HTML report builder
│       ├── shellRunner.ts               # CLI execution with timeout + error handling
│       ├── outputParsers.ts             # JSON parsers for each tool's output
│       ├── eslintConfigDetector.ts      # Detects project ESLint config
│       └── toolResponse.ts             # MCP error response helpers
├── dist/                                # Compiled output (gitignored)
├── package.json
├── tsconfig.json
└── README.md
```

---

## How to prompt

The shortest working prompts:

```
# Full suite
QA snapshot — https://myapp.com, code at /path/to/repo

# URL only (Lighthouse + pa11y)
QA snapshot — https://myapp.com

# Local branch only (ESLint + Semgrep)
QA snapshot — /path/to/my-feature-branch
```

Alternative trigger phrases (all invoke `run_qa_gate`):

```
Health check on https://myapp.com
Is https://myapp.com ready to ship? Code at /path/to/repo
Any red flags? /path/to/repo
```

After the run, Claude will surface the `report_file` path. Open it in your browser for the full visual dashboard.
