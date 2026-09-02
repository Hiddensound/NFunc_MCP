# PSI performance audit — report spec

How to turn the output of `run_performance_audit` into the written report.

The tool owns the arithmetic; you own the prose. This file exists so the
document comes out the same shape every time instead of being re-improvised,
and so the specific mistakes that a human (or a model) makes when reading
twenty-odd JSON files by hand are designed out rather than left to care.

Structure below is derived from a real executive audit that worked. Follow it.

---

## The three rules

These are not style preferences. Each one exists because it was got wrong in a
real report.

### 1. Never do arithmetic. Quote `aggregate`.

Every cross-page number — counts, means, ranges, percentages, verdict tallies —
is already computed in the `aggregate` block of the final tool response. Quote
it. Do not add up scores, do not count failures across pages, do not compute a
mean by eye.

A hand-written audit of 22 runs got "TBT fails on 22/22" right and the
direction of the CrUX CLS comparison backwards, in the same document. Counting
is easy to get right and easy to get wrong; the difference is whether a machine
did it.

If a number you want is not in `aggregate`, say so in the report rather than
deriving it.

### 2. Field data leads. Lab data explains.

When lab and field disagree, **the field number is the headline and the lab
number is context**. Real users outrank a simulation.

`aggregate.lab_vs_field_summary` and each run's `lab_vs_field` array give you
the verdicts:

| Verdict | What to write |
|---|---|
| `worse_in_field` | **Lead with this.** The test environment is not reproducing production. No local tool can find it. Section 1 material. |
| `confirmed` | Two independent measurements agree. Highest confidence — state it plainly and prioritise. |
| `worse_in_lab` | The lab profile is harsher than the real audience. Report as a stress signal, explicitly *not* as user-experienced harm. Do not lead with it. |
| `both_pass` | Mention only in the coverage table. |

The failure this prevents: an audit that opened with "mobile LCP averages
17.3 s — material at-risk conversion" when the field data on the same pages
showed real users at 2.8 s, while burying a 0.55 field CLS that 70% of real
users were hitting. The lab numbers were real; they were not what users
experienced.

Never describe CrUX as "real-time". It is a **28-day trailing aggregate at the
75th percentile**. The right phrase is "real users, 28-day p75".

### 3. State coverage where the sample is described.

`coverage` from the plan tool and `aggregate.by_template` tell you what
fraction of the site the sample represents. "3 of 3,904 product pages" belongs
in section 2.2 as a caveat, not in a footnote and not omitted.

Where a metric came from origin-level CrUX rather than the URL's own data
(`field_source: "origin"`), say so at the point the number appears. Origin data
for a homepage says nothing about a checkout page.

This matters more than it looks, because **PSI substitutes origin data
silently**. A low-traffic URL comes back with `loadingExperience` fully
populated from origin-wide numbers, and the only tell is that its `id` holds
the origin rather than the URL. The parser checks for this, so trust
`field_source` — but never assume a populated field block describes the page
you asked about. A giveaway in the data itself: two different URLs reporting
identical p75 values are both being served origin data.

---

## Document structure

### 1. Executive summary
- **Overall health** — one paragraph. Use `aggregate.by_strategy` and
  `aggregate.cwv_verdicts`.
- **Headline findings** — three to five bullets, worst first. Anything in
  `worse_in_field` goes here. So does anything in `lab_metric_failures` with
  `universal: true` — a metric failing on 80%+ of runs. A lower percentage is a
  section 6 finding, not a headline: "TBT fails on 2 of 8 runs" does not belong
  in an executive summary as though it were sitewide.
- **Business impact** — what the numbers mean for the people using the site.
  This is the one section that is genuinely yours to write; ground every claim
  in a quoted number.
- **Recommended priority** — the single highest-leverage fix and why.

### 2. Scope and methodology
- **2.1 Purpose** — synthetic lab audit plus real-user field data. Say
  explicitly that load and stress testing are out of scope.
- **2.2 Page sample** — table of template, representative URL, devices, and
  **coverage** (rule 3). Include templates that were *not* audited and why —
  session-gated pages routed to `run_lighthouse`, templates below the sampling
  budget.
- **2.3 Tools and data sources** — PageSpeed Insights API v5 (Lighthouse on
  Google's infrastructure) for lab; CrUX 28-day p75 for field. Name the
  categories captured.
- **2.4 Test conditions** — `runs_per_url`, date, `strategy`, anonymous
  session. If `runs_per_url` is 1, say that single extreme readings are
  flagged for confirmation rather than validated, and point at
  `aggregate.outliers`.
- **2.5 Out of scope** — load testing, authenticated flows, third-party
  backends.

### 3. Scorecard
One row per page/device from the index. Columns: page, device, performance
score, LCP (lab), LCP (field), CLS (lab), CLS (field), INP (field), TBT (lab),
CWV verdict. Mark every field cell that came from origin-level data.

### 4. Core Web Vitals reference
The threshold table, and a short lab-versus-field explanation. Keep it; readers
outside the engineering team need it, and it is where you establish the
vocabulary the rest of the report uses.

### 5. Diagnostic checklist
Root-cause categories — render-blocking, images, JavaScript, third parties,
caching, layout stability, mobile. Check items off **against the per-page JSON
reports on disk**, which hold the individual Lighthouse audits. Do not tick a
box from the summary index; if you have not opened the audit, say the item is
unverified.

### 6. Key findings
Ranked by material impact. One row each: finding, affected pages, severity,
evidence. Draw from `lab_metric_failures`, `systemic_findings`, and the P1s in
each run's `findings`.

**Report systemic findings once.** Note these are computed only from URL-level
field data — origin-level CrUX is the same number repeated for every page that
falls back to it, so it cannot evidence a claim about variation between pages.
If `aggregate.collapsed_vitals` names a vital, that vital is a site-wide
characteristic — write it as one finding about
shared code, never as N per-page findings. The `collapse_note` says which.

### 7. Prioritised recommendations
Impact / effort / priority / owner / target pages. Split into quick wins and
strategic work. Effort and owner are your judgement — mark them as estimates.

### 8. Field data callout
The lab-versus-field table in full, with the `note` from each comparison. This
is the section that justifies having run PSI instead of local Lighthouse.

### 9. Appendix
Report inventory (`output_dir` and `_index.json`), glossary, revision log.

---

## Failure and gap handling

PSI fails intermittently — roughly one run in three on some origins. Report the
audit you actually have:

- If `progress.failed` is non-zero and the gaps were not filled, list the
  missing page/device combinations in section 2.2. Do not present a partial
  sample as complete.
- If `aggregate.lab_vs_field_summary.no_field_data` is non-zero, name those
  pages. Absent field data means insufficient real-user traffic, which is
  itself worth knowing — it usually marks a long-tail page.
- If the site is behind a bot wall or the origin is non-public, the audit is
  lab-only by definition. Say so in 2.3 rather than implying field coverage.

## Output format

Markdown by default. For a .docx deliverable, convert:

```
pandoc report.md -o report.docx
```

Do not attempt to produce .docx directly.
