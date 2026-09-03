# nfunc-mcp — operating manual

Everything past the quick start: installation options, per-tool reference,
output shapes, and troubleshooting. The [README](../README.md) covers what the
tools are and how to ask for them; this covers how to run and interpret them.

**Contents**

1. [Prerequisites](#prerequisites)
2. [Install and register](#install-and-register)
3. [`run_qa_gate` reference](#run_qa_gate-reference)
4. [Individual tool reference](#individual-tool-reference)
   - [Auditing several URLs at once](#auditing-several-urls-at-once)
   - [Comparing two runs (before vs after)](#comparing-two-runs-before-vs-after)
5. [PSI performance audit](#psi-performance-audit)
6. [Priority system](#priority-system)
7. [Project layout](#project-layout)
8. [Troubleshooting](#troubleshooting)

---

## Prerequisites

Four of the tools wrap CLIs. Install the ones you need:

| Tool | Install | Used by |
|---|---|---|
| Lighthouse | `npm install -g lighthouse` | `run_lighthouse`, `run_qa_gate` (URL) |
| pa11y | `npm install -g pa11y` | `run_accessibility_check`, `run_qa_gate` (URL) |
| ESLint | `npm install -g eslint` | `run_static_analysis`, `run_qa_gate` (path) |
| Semgrep | `brew install semgrep` or `pip install semgrep` | `run_static_analysis`, `run_qa_gate` (path) |

Verify:

```bash
lighthouse --version && pa11y --version && eslint --version && semgrep --version
```

**You don't need all four.** A missing tool shows `UNAVAILABLE` in the
scorecard and its findings are skipped; the gate still runs. URL-only runs need
Lighthouse and pa11y; path-only runs need ESLint and Semgrep.

### PageSpeed Insights API key

The PSI tools call an HTTP API rather than a CLI, but they want a key:

1. Enable the **PageSpeed Insights API** in the Google Cloud console.
2. Create an API key, restricted to that API.
3. Put it in the `env` block of your MCP client config — the client launches
   this server, so it owns the environment:

```bash
claude mcp remove nfunc-mcp -s local
claude mcp add nfunc-mcp -s local -e PAGESPEED_API_KEY=your_key -- npx -y nfunc-mcp
```

Confirm with any `plan_performance_audit` call: the response carries
`api_key: { present: true, source: "env" }` and never the key itself.

**Without a key the tools still load but are capped at 4 runs.** The shared
anonymous quota is exhausted in practice — expect `429 Quota exceeded` on the
first real request. A key gives 25,000 requests/day.

An `api_key` tool input also works but is discouraged: it lands in the
conversation transcript and in client logs. It is redacted from every error
message either way.

---

## Install and register

### Option A — npm (recommended)

```bash
claude mcp add nfunc-mcp -- npx -y nfunc-mcp
```

`npx` fetches and runs the server. No clone, no build.

### Option B — manual config

In `~/.claude.json` under `mcpServers`:

```json
{
  "mcpServers": {
    "nfunc-mcp": {
      "command": "npx",
      "args": ["-y", "nfunc-mcp"],
      "env": { "PAGESPEED_API_KEY": "your_key" }
    }
  }
}
```

### Option C — from source (contributors)

```bash
git clone https://github.com/Hiddensound/NFunc_MCP.git
cd NFunc_MCP
npm install
npm run build
claude mcp add nfunc-mcp -- node /absolute/path/to/NFunc_MCP/dist/index.js
```

| Script | Purpose |
|---|---|
| `npm run build` | Compile TypeScript → `dist/` |
| `npm start` | Run the compiled server |
| `npm run dev` | Run from source with hot reload (`tsx watch`) |

For local development, registering `tsx src/index.ts` instead of
`dist/index.js` means edits need only an MCP reconnect, not a rebuild.

### Verify

1. `/mcp` in Claude Code — `nfunc-mcp` shows as connected.
2. Ask: *"Call the nfunc-mcp ping tool."*
3. Expect `{ "status": "ok", "timestamp": "..." }`

After changing the server's code or environment, reconnect via `/mcp` — the
running process does not pick up changes on its own.

---

## `run_qa_gate` reference

### Inputs

Both `url` and `path` are optional; at least one is required.

| Input | Type | When to provide |
|---|---|---|
| `url` | string (URL) | A running page — production, staging, preview, or localhost. Enables Lighthouse and pa11y. |
| `path` | string (path) | A local codebase. Enables ESLint and Semgrep. |
| `context` | string | Optional free-text description (e.g. `"React e-commerce checkout"`). Helps interpretation. |
| `form_factor` | `mobile` \| `desktop` \| `both` | Optional, default `mobile`. See [mobile vs desktop](#mobile-vs-desktop). |
| `a11y_runner` | `htmlcs` \| `axe` \| `both` | Optional, default `htmlcs`. See [choosing an engine](#choosing-an-accessibility-engine). |

### Release readiness tiers

| Value | Meaning | Condition |
|---|---|---|
| `BLOCKED` | Cannot ship | Any P1 finding |
| `CONDITIONAL` | Shippable with caveats | P2 findings, no P1s |
| `ADVISORY` | Safe to ship; P3s are tech debt | Only P3 findings |
| `CLEAR` | No issues detected | Zero findings |

### Composite score

A single 0–100 health measure. Start at 100 and deduct: **P1 −15, P2 −7,
P3 −3**, floored at 0. Most useful as a trend line across sprints rather than
as an absolute grade.

### Scorecard

One line per tool:

```json
[
  { "tool": "Lighthouse",       "gate": "WARN", "score": 75,
    "breakdown": { "performance": 52, "accessibility": 98, "seo": 100, "best-practices": 58 } },
  { "tool": "pa11y",            "gate": "PASS", "issues": 0 },
  { "tool": "ESLint / Semgrep", "gate": "SKIPPED" }
]
```

| Gate | Meaning |
|---|---|
| `PASS` | No issues at this tool's threshold |
| `WARN` | Issues below the FAIL threshold |
| `FAIL` | P1-level issues (or Lighthouse average < 50) |
| `SKIPPED` | Input not provided |
| `UNAVAILABLE` | Tool invoked but not installed, or errored |

### Cross-tool corroboration

When Lighthouse and pa11y independently flag the same accessibility gap, the
findings are **merged** into `corroborated_findings`, **promoted one tier**
(P3→P2, P2→P1), and annotated `confidence: "high"` with
`confirmed_by: ["lighthouse", "pa11y"]`.

Two independent tools agreeing is stronger evidence than either alone, so these
appear above all other findings and bubble to the top of `top_issues`.

**Rule 1 — accessibility mapping:**

| Lighthouse audit | pa11y technique |
|---|---|
| `color-contrast` | `.G18`, `.G145`, `.G174` |
| `image-alt` | `.H37`, `.H67`, `.F65` |
| `label` | `.H44`, `.F68`, `.H91.Input` |
| `link-name` | `.H30`, `.H91.A.` |
| `html-has-lang` | `.H57` |
| `button-name` | `.H91.Button` |
| *(and more)* | |

**Rule 2 — performance ↔ code:** when a Lighthouse performance finding's
display value contains a filename that also appears in a static analysis
finding, the static finding is attached as `related_findings`. They are linked
by reference, not merged.

### HTML report

Every call writes a self-contained HTML file to `/tmp` and returns its path as
`report_file`. It contains the readiness banner, a composite-score gauge,
the scorecard, cross-confirmed findings, and collapsible finding cards grouped
by priority. Inline CSS, no server needed.

### Output shape

```jsonc
{
  "release_readiness": "BLOCKED",        // BLOCKED | CONDITIONAL | ADVISORY | CLEAR
  "composite_score": 22,                 // 0–100
  "report_file": "file:///tmp/qa-report-xxx.html",
  "scorecard": [ ... ],
  "eslint_config_used": "project",       // only when path was supplied
  "summary": "110 findings (101 P1, 9 P2) across 2 tools. ...",
  "corroborated_findings": [ ... ],      // cross-confirmed, confidence: "high"
  "top_issues": [ ... ],                 // top 3 (corroborated first)
  "all_findings": [ ... ],               // all, sorted by priority
  "correlations_found": 1,
  "errors": [ ... ]                      // only if a tool errored
}
```

Each finding:

```jsonc
{
  "priority": "P1",
  "title": "Largest Contentful Paint",
  "description": "Users see main content 34s after navigation...",
  "evidence": { "audit_id": "largest-contentful-paint", "value": "34.3 s" },
  "source_tool": "lighthouse",
  // corroborated findings also carry:
  "confirmed_by": ["lighthouse", "pa11y"],
  "confidence": "high"
}
```

---

## Individual tool reference

### `run_lighthouse`

Returns `url`, `form_factor`, `scores` per category, `ttfb_ms`, and
priority-ordered `findings`.

#### Mobile vs desktop

`form_factor` accepts `desktop` (default), `mobile`, or `both`.

**This default deliberately differs from the Lighthouse CLI's**, which is
mobile: a 412×823 screen, mid-range Android user agent, simulated slow 4G, and
a **4× CPU slowdown**. That profile reports substantially lower performance
scores for the same page, so `mobile` here is not a like-for-like comparison
with a default CLI run — check `form_factor` in the response before comparing
two reports.

**The two are not interchangeable.** They render different DOM, so they find
different defects, not just different numbers. On one commerce category page:

| | Mobile | Desktop |
|---|---|---|
| performance | 54 | 62 |
| accessibility | **87** | **73** |
| seo | 77 | 69 |

Five accessibility audits failed on desktop that mobile never reported —
`image-alt`, `aria-required-children`, `aria-required-parent`,
`aria-allowed-attr`, `aria-valid-attr-value` — while three others failed only
on mobile. Neither profile is a superset of the other.

With `both`, the two run concurrently (little more wall time than one), `scores`
is keyed by form factor, and each finding carries `affects_form_factors` and
`form_factor_specific`.

### `run_accessibility_check`

pa11y at WCAG 2 AA by default, violations only. Returns `url`, `standard`,
`runners`, `violation_count`, `raw_violation_count`, `findings`.

`raw_violation_count` versus `violation_count` shows the dedup at work: a rule
failing on more than two elements collapses into one systemic finding carrying
`distinct_elements` and the full `sample_selectors` list, rather than one line
per element. Three gallery images with no alt text are one template to fix, not
three authoring mistakes.

This matters across pages as much as within one. Before the threshold was
lowered, a homepage with 11 duplicate ids collapsed to a single finding while a
category page with 10 listed every one — the same component, but one page
appeared four times worse. Collapsing consistently is what makes per-page counts
comparable at all.

#### WCAG conformance and priority

Findings are priced by what they cost a **conformance claim**, not by how bad
the defect feels. `target_level` names the level the project has committed to —
default `AA`, the legal and industry bar for essentially all commercial work.

| Finding | Priority | Why |
|---|---|---|
| Level **A** criterion fails | **P1** | The floor. While any Level A criterion fails, no higher level is achievable — AA conformance is impossible regardless of how the AA-specific criteria score |
| Level **AA** criterion fails | **P2** | Blocks an AA commitment |
| Criterion **above** the target | **P3** | An enhancement, not a gap. `target-size` is 2.5.5, Level **AAA** in WCAG 2.1 — it should not fail an AA audit |
| Not a success criterion | **P3** | A best-practice rule. Worth fixing; does not affect a conformance claim |

Two demotions apply after that: axe's `needsFurtherReview` (a maybe should not
gate a release as hard as a certainty) and an axe impact of `minor` — the "very
minor AA issue" tier.

Every finding carries `wcag_criterion`, `wcag_name`, `wcag_level` and
`blocks_target` in its evidence, and its description states what the failure
means for the claim.

Each run also returns a `conformance` block, and a batch adds a cross-page
rollup:

```jsonc
"conformance": {
  "target_level": "AA",
  "conformant": false,
  "failing_criteria": { "A": 6, "AA": 1, "AAA": 0 },
  "beyond_target": 0,
  "failed_criteria": [
    { "criterion": "4.1.1", "name": "Parsing", "level": "A", "findings": 5, "blocks_target": true }
  ],
  "summary": "Not Level AA conformant. 6 Level A criteria fail... Level A is the floor..."
}
```

**The unit is the criterion, not the finding.** Twelve findings against one
criterion is one thing to fix and one line in a conformance statement. The
finding count answers "how much work"; the criterion count answers "are we
conformant". A report giving only the first is how a page ends up described as
having 22 accessibility issues when it fails five criteria.

Criterion levels are transcribed from
[WCAG 2.1](https://www.w3.org/TR/WCAG21/). htmlcs encodes the criterion in its
rule code; axe does not expose WCAG tags through pa11y, so its rule ids go
through a lookup table in `src/mappers/wcagLevels.ts`. Rules axe classifies as
best-practice map to no criterion deliberately — reporting one as a conformance
failure would overstate the legal position.

**Automated testing reaches roughly a third of WCAG criteria.** A `conformant:
true` result means nothing automated failed, not that the page conforms. Focus
order, keyboard traps, meaningful sequence, error suggestion and content on
hover all need a human.

#### Choosing an accessibility engine

| Engine | Strongest at | Severity source |
|---|---|---|
| `htmlcs` (default) | WCAG techniques, document structure, form labelling, duplicate ids | WCAG technique class |
| `axe` | **ARIA** — invalid roles, missing required parent/child relationships, prohibited and unsupported attributes — and computed colour contrast | axe's own `impact` |

**Reach for `axe` whenever the work involves ARIA, a component library, or a
design system.** The overlap is smaller than expected. On the same page:

- htmlcs found unlabelled inputs, forms with no submit mechanism, and ten
  duplicate ids that axe did not report.
- axe found `aria-allowed-attr`, `aria-prohibited-attr`,
  `aria-required-parent`, `aria-required-children` and `image-alt` failures
  htmlcs missed entirely.

`both` runs them concurrently and merges. An element flagged by both appears
twice, because they emit different rule codes — deliberate, since two engines
agreeing is corroboration worth seeing.

axe findings carry `axe_impact`, and `needs_manual_review: true` where axe
wants human confirmation. Those are demoted one tier: a maybe should not gate a
release as hard as a certainty.

### `run_static_analysis`

ESLint and Semgrep in parallel against a local directory. Uses the project's own
ESLint config when it finds one, otherwise a QA-focused baseline. Returns
`path`, `tools_run`, `eslint_config_used`, `issue_count`, `findings`,
`warnings`.


### Auditing several URLs at once

`run_lighthouse` and `run_accessibility_check` both accept three input shapes in
the same `url` field, and detect which they were given:

| You pass | Detected as |
|---|---|
| `https://site.com/page` | a single URL — one report, returned immediately |
| `https://a.com, https://b.com` (or newline-separated) | a list — batch mode |
| `./top-pages.csv` | a CSV — the URL column is found by name or by content |

A bare domain gets `https://` assumed, duplicates are dropped, and unparseable
entries are reported rather than silently skipped. An explicit `urls` array
works too.

**One URL behaves exactly as before** — same response shape, no batch fields.
Several URLs switch to batch mode:

- Each call is bounded by `max_seconds_per_call` (default **100 s**, chosen to
  stay under the 120 s at which Claude Code backgrounds a tool call) and returns
  a `cursor`. Keep calling until `complete` is true.
- Every report is written to `output_dir` as it lands — the **raw** Lighthouse
  LHR, so the individual audits survive — and merged into a running
  `_index.json`.
- **Re-run to fill gaps.** Call again with the same input and *no cursor*;
  completed URL/variant pairs are skipped automatically. `skip_completed: false`
  forces fresh measurements.
- The final call adds an `aggregate` block. Quote its numbers rather than
  recomputing them.

Lighthouse runs **sequentially** in batch mode, unlike the single-URL path.
Two Chrome instances on one machine contend for CPU, and a performance audit
whose numbers came from a half-busy machine is not worth having. pa11y still
runs its engines concurrently — it is not measuring time.

#### What the aggregates tell you

`run_lighthouse` returns per-strategy means, a **per-template rollup** (the same
classifier the PSI plan tool uses, so twelve product URLs report as "PDP average
61" rather than as twelve rows), CWV verdict tallies, and outlier detection
against the median.

`run_accessibility_check` returns something a single-page run cannot: **which
rules fail across most pages**. A rule failing on 80%+ of pages is marked
`shared_layout: true` — it lives in the header, footer or base template, so one
fix clears every page. A rule failing on one page is that page's own bug. On a
four-page sample, `color-contrast` hit 4/4 while `image-alt` and `link-name` hit
1/4: two completely different pieces of work, and volume alone cannot separate
them.

#### Mobile accessibility

`form_factor` on `run_accessibility_check` defaults to `desktop` and accepts
`mobile` or `both`. Mobile emulates 412×823 at 2× DPR with touch, matching
`run_lighthouse`'s mobile profile so the two describe the same rendered page.

The viewport genuinely applies — a screenshot from the mobile run measures
824×23418 against 1280×2418 for the default. **But temper expectations:** on a
test site, neither htmlcs nor axe reported a single different violation between
the two viewports, because the rules both engines run here are structural —
missing labels, duplicate ids, absent alt text — and structure does not change
with width. It earns its keep on sites whose mobile DOM genuinely differs (a
hamburger nav, different components rendered), which is common on real commerce
sites.

For viewport-*dependent* accessibility defects today, `run_lighthouse` with
`form_factor: "both"` is the stronger tool: it reported `target-size` tagged
`form_factor_specific: true`, a touch-target failure that exists only on mobile
and that pa11y did not surface at all.


### Comparing two runs (before vs after)

A snapshot answers "what is wrong with this page". A developer about to open a
PR is asking something else: *did my fix work, and did I break anything?* A
violation count cannot separate those.

Both tools take `baseline_dir`. Point it at an earlier `output_dir`:

```
# 1. capture a baseline before touching anything
Run an accessibility check on http://localhost:3000, save to ./a11y-base

# 2. make the fix, then re-scan against it
Scan http://localhost:3000 again and compare to ./a11y-base
```

The response gains a `comparison` block:

```jsonc
"comparison": {
  "verdict": "mixed",          // clean | improved | mixed | regression | unchanged
  "summary": "5 defect(s) fixed, but 1 newly introduced (worst: P2). Total went 6 to 2; the drop is real but incomplete — check newly_introduced before treating this as a clean fix.",
  "fixed":            [{ "id": "image-alt", "was": "P1", ... }],
  "still_failing":    [{ "id": "color-contrast", "priority": "P3", ... }],
  "newly_introduced": [{ "id": "aria-valid-attr-value", "priority": "P2", ... }],
  "score_changes":    [{ "category": "accessibility", "before": 94, "after": 64, "delta": -30 }]
}
```

`newly_introduced` is the half that earns this feature. Measured on a real
page: adding `alt` text, an `aria-label` and a `<label>` fixed **five P1s** and
introduced one **P2**, because the `aria-labelledby` also added pointed at an id
that did not exist. A Lighthouse run against a page given a render-blocking
script reported `regression` with accessibility **94 → 64** and named all four
injected defects.

Notes on how it behaves:

- **This works with a single URL**, not only batches. A single-URL run touches
  disk only when `output_dir` is given, so a one-off check stays a one-off while
  the same call can seed a baseline.
- **`localhost` is fully supported** — pa11y and Lighthouse run Chrome on your
  machine. This is the pre-PR check PSI cannot do.
- **`baseline_dir` may equal `output_dir`.** The baseline is read before
  anything is written, so "compare against the last run in here" works.
- **`skip_completed` flips to `false` when comparing.** Re-measuring is the
  whole point; skipping completed work would compare a run against itself.
- **Comparison is per `(url, variant, defect id)`.** Only runs present on both
  sides are compared — a page that was not re-tested is reported under
  `not_in_current` rather than counted as fixed, since a defect can only be
  called fixed if the page was measured again.
- A defect that changed priority between runs counts as **still failing**, not
  as fixed-and-reintroduced. It is the same defect on the same element.

---

## PSI performance audit

`plan_performance_audit` and `run_performance_audit` wrap the Google PageSpeed
Insights API. They are **exclusive and opt-in** — `run_qa_gate` never calls
them. Use them when someone asks for a PSI audit, a Core Web Vitals report, or
real-user field data.

### Why two tools

An MCP tool cannot ask a question mid-call, and a useful audit needs decisions
first — which URLs, how many per template, what to do about pages PSI cannot
reach. So:

1. `plan_performance_audit` discovers, classifies and costs the run, then
   returns a `questions` array. **Spends no quota.**
2. Those questions go to the user.
3. `run_performance_audit` executes the approved page list.

A misclassified template should cost a conversation turn, not forty API calls.

### What PSI adds over `run_lighthouse`

One call returns two independent datasets: a Lighthouse run on Google's
infrastructure (**lab**) and Chrome UX Report data for the URL (**field** — real
users, 28-day 75th percentile). `run_lighthouse` gives you the first. Only PSI
gives the second, and the disagreement is the point:

| Lab | Field | Meaning |
|---|---|---|
| Pass | Pass | Genuinely fine |
| Fail | Pass | Lab profile harsher than the real audience — deprioritise |
| **Pass** | **Fail** | **The test environment is lying to you.** Real users hit something the simulation does not |
| Fail | Fail | Confirmed by two independent measurements |

Row three is invisible to every other tool here. On one commerce homepage the
lab reported a perfect CLS of 0 while real users were at 0.55 — 5.5× the "poor"
threshold, affecting 70% of them. On another site the lab reported TTFB of 2 ms
(Google's network sits next to the origin) against 1.5 s in the field.

CrUX is **not real-time** — it is a 28-day trailing aggregate. It is valuable
because it is real users, not because it is current.

### Where PSI does not work

- **Localhost and private hosts** — PSI fetches from Google's infrastructure.
  Rejected at preflight; use `run_lighthouse`.
- **Cart, checkout, account pages** — PSI fetches anonymously, so it would
  measure an empty cart or a login redirect. The plan tool flags these and
  routes them to `run_lighthouse`, which can carry session cookies.
- **Low-traffic URLs** — reachable, but with little or no CrUX data. You get a
  lab-only audit, labelled as such. Staging and preview deployments are always
  in this category, which is why PSI is optional for non-production and
  authoritative for hosted sites.

### URL discovery

`discovery` accepts:

| Mode | Behaviour |
|---|---|
| `sitemap` (default) | robots.txt, then `/sitemap.xml` and `/sitemap_index.xml`, then `<link rel="sitemap">`, then seven common CMS locations. Tiers only advance when earlier ones find nothing. |
| `list` | Explicit `urls` array. |
| `csv` | `csv_path` — column detected by name or by content. An analytics top-pages export is the best input for a performance audit, being traffic-weighted. |
| `crawl` | Not implemented, and declined deliberately — see below. |

**Why there is no crawler.** Static link extraction was measured against real
homepages and found 11 internal paths on nodejs.org (whose sitemap has 1,723),
7 on gap.com, and nothing at all on a site behind a bot wall. The pages most
likely to lack a sitemap are the same ones that are client-rendered or
bot-protected, so a crawler fails precisely where it would be needed. An
analytics top-pages export is a better input anyway, being weighted by real
traffic. If one is ever built it should drive a headless browser rather than
parse static HTML.

Discovered URLs are clustered into **templates** by path shape, and the plan
tool proposes representative samples per template. Passing a URL with a path
(e.g. `https://site.com/shop/`) scopes discovery to that subtree.

### Chunking and time

PSI is slow and erratic: measured latency on live runs ranged from **10 s to
57 s for the same URL**, with occasional hangs and intermittent 500s. Roughly
one run in three failed on one origin.

So `run_performance_audit` runs in chunks. Each call is bounded by
`max_seconds_per_call` (default 150) and returns a `cursor`; keep calling until
`complete` is true. Raw reports are written to `output_dir` as they land and
merged into `_index.json`, so nothing completed is ever lost.

**Re-run to fill gaps.** Call again with the same pages and *no cursor* —
completed page/strategy pairs are skipped automatically, so only failures are
retried. Pass `skip_completed: false` to force fresh measurements.

`runs_per_url` defaults to 1. Raising it to 3 takes the median run and removes
single-run outlier risk, at three times the wall clock.

### Reading the output

The final call returns an `aggregate` block with every cross-page number:
per-strategy means, `lab_metric_failures`, CWV verdict tallies,
`lab_vs_field_summary`, and outliers. **Quote those rather than recomputing
them.**

Two redundancy rules apply there:

- **Systemic collapse** — a vital failing on 80%+ of runs *with little
  variation between pages* collapses into one site-wide finding. Computed only
  from URL-level field data, since origin-level CrUX is one number repeated and
  cannot evidence a claim about variation.
- **Component suppression** — FCP is folded into LCP when both fail on a page,
  since FCP is a component of LCP rather than an independent defect.

`field_source` on every field metric says whether the number describes the URL
or the whole origin. **PSI substitutes origin data silently**, so trust that
field rather than the presence of a populated field block.

[`psi-report-spec.md`](psi-report-spec.md) is the full guide to turning this
output into a written report.

---

## Priority system

| Priority | Meaning | Lighthouse | WCAG | ESLint / Semgrep | CrUX field |
|---|---|---|---|---|---|
| P1 | Blocker — fix before shipping | Score < 50 | **Level A failure** — puts the target out of reach | Semgrep security, ESLint error | Core vital rated poor |
| P2 | Warning — track before merging | 50–79 | **Level AA failure** | ESLint warning | Needs improvement, or any diagnostic |
| P3 | Advisory — log as tech debt | 80–89 | **Above the target**, or a best-practice rule | — | — |
| *(suppressed)* | Passing — never reported | ≥ 90 | — | — | Good |

Lighthouse findings are actually ranked by `weight × (1 − score)` — the category
points an audit really costs — rather than by score alone, so a weight-30 metric
failing outright outranks a weight-1 SEO check that also scores 0.

Adjustments:

- **Corroborated** findings (two tools agreeing) are promoted one tier.
- **Field-confirmed** findings are promoted one tier; **lab-only** findings
  contradicted by healthy field data are demoted and tagged `lab_only`.
- **Non-core vitals** (FCP, TTFB) never exceed P2 — they explain a Core Web
  Vital rather than being one.

---

## Project layout

```
├── src/
│   ├── index.ts                     # MCP server bootstrap + tool registration
│   ├── types.ts                     # Shared types (Finding, Priority)
│   ├── config/
│   │   └── qa-mcp-baseline.eslint.config.js  # Fallback ESLint config
│   ├── tools/                       # One file per MCP tool
│   │   ├── qaGate.ts                # Orchestrator
│   │   ├── lighthouse.ts
│   │   ├── accessibility.ts
│   │   ├── staticAnalysis.ts
│   │   ├── performanceAuditPlan.ts  # plan_performance_audit
│   │   └── performanceAudit.ts      # run_performance_audit
│   ├── mappers/                     # Raw output → QA report shape
│   │   ├── correlator.ts            # Cross-tool correlation (Rule 1 + 2)
│   │   ├── defectFormatter.ts       # Findings and defect prose
│   │   ├── priorityMapper.ts        # Score/severity → P1/P2/P3
│   │   ├── a11yDedupe.ts            # Systemic a11y collapse
│   │   ├── compositeScore.ts        # Per-tool sub-scores
│   │   ├── webVitalsMapper.ts       # CrUX thresholds → priorities → prose
│   │   ├── labFieldComparator.ts    # Lab vs field verdicts
│   │   ├── psiAggregator.ts         # Cross-run arithmetic + redundancy rules
│   │   ├── runComparator.ts         # Before/after diff: fixed, still failing, new
│   │   └── wcagLevels.ts            # WCAG 2.1 criteria, levels, conformance rollup
│   └── utils/                       # Cross-tool helpers
│       ├── shellRunner.ts           # Subprocess choke point
│       ├── httpClient.ts            # HTTP choke point (retry, deadline, redaction)
│       ├── reportGenerator.ts       # HTML report builder
│       ├── outputParsers.ts         # Per-tool JSON parsers
│       ├── psiParser.ts             # PSI response → lab + field
│       ├── psiAuth.ts               # API key resolution
│       ├── sitemapReader.ts         # Tiered sitemap discovery
│       ├── urlClassifier.ts         # URL list → page templates
│       ├── csvReader.ts             # URL extraction from CSV
│       ├── publicUrl.ts             # Reachability + session-gate checks
│       ├── urlInput.ts              # One URL / list / CSV → URL array
│       ├── batchState.ts            # Cursor, budget, index merge, gap-fill
│       ├── eslintConfigDetector.ts
│       └── toolResponse.ts
├── docs/
│   ├── manual.md                    # This file
│   └── psi-report-spec.md           # How to write the PSI audit report
└── dist/                            # Compiled output (gitignored)
```

External calls go through exactly two choke points: `shellRunner` for
subprocesses, `httpClient` for HTTP. Anything holding an API key must use
`httpClient`, which redacts secrets from every error.

---

## Troubleshooting

### The new tools don't appear after an update

Reconnect: `/mcp` → the server → **Reconnect**. The running process does not
reload code or environment changes on its own.

### `429 Quota exceeded` on the first PSI call

No API key. The shared anonymous quota is exhausted in practice, so keyless PSI
fails immediately rather than working slowly. See
[the key setup](#pagespeed-insights-api-key).

### A PSI call gets "moved to the background"

Claude Code backgrounds an MCP call at 120 s, and the default
`max_seconds_per_call` is 150. Results still arrive by notification. To keep
runs in the foreground, pass `max_seconds_per_call: 100` or lower.

### PSI runs fail intermittently

Expected — roughly one in three on some origins, as PSI 500s or hangs. Call the
tool again with the same pages and no cursor; completed pairs are skipped and
only the gaps are retried.

### The plan tool warns about HTTP 403

A bot wall (Cloudflare and similar) blocking the preflight. It says nothing
about PSI, which fetches from Google's address space and is usually
allowlisted. Not a reason to stop — but if the audit returns nothing, the
challenge page is the first suspect.

### "No sitemap found"

Nine locations were tried. Supply URLs with `discovery: "list"`, or point at a
CSV export — an analytics top-pages export is a better input for a performance
audit anyway, being weighted by real traffic.

### Field data says "site-wide data"

That URL has too little traffic for its own CrUX entry, so the numbers describe
the whole origin. They are still real, but they do not describe the page you
asked about. Two different URLs reporting identical p75 values are both being
served origin data.

### A tool shows `UNAVAILABLE`

Its CLI is not on PATH. Install it (see
[prerequisites](#prerequisites)) or ignore it — the rest of the gate still runs.

### A comparison reports nothing was compared

`baseline_dir` had no index, or it covers different URLs than this run. Check
`not_in_baseline` and `not_in_current` in the comparison block — only runs
present on both sides can be compared. Create a baseline by running once with
`output_dir` set.

### Lighthouse scores look far worse than expected

Check `form_factor`. The mobile profile applies a 4× CPU slowdown and simulated
slow 4G; it is not comparable to a desktop run of the same page.
