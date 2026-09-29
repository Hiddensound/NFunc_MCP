import { mkdir, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join, resolve } from "path";

export interface ReportData {
  url?: string;
  path?: string;
  context?: string;
  release_readiness: string;
  composite_score: number;
  scorecard: Array<{
    tool: string;
    gate: string;
    score?: number;
    breakdown?: Record<string, number>;
    issues?: number;
  }>;
  summary: string;
  corroborated_findings: Array<Record<string, unknown>>;
  all_findings: Array<Record<string, unknown>>;
  correlations_found: number;
  errors?: string[];
  generated_at: string;
}

// ---------------------------------------------------------------------------
// Colour helpers
// ---------------------------------------------------------------------------

function readinessColors(r: string): { bg: string; text: string; border: string } {
  if (r === "BLOCKED")     return { bg: "#fef2f2", text: "#b91c1c", border: "#fca5a5" };
  if (r === "CONDITIONAL") return { bg: "#fffbeb", text: "#b45309", border: "#fcd34d" };
  if (r === "ADVISORY")    return { bg: "#fefce8", text: "#854d0e", border: "#fde047" };
  return                          { bg: "#f0fdf4", text: "#15803d", border: "#86efac" };
}

function gateStyle(g: string): { bg: string; text: string } {
  if (g === "PASS")        return { bg: "#dcfce7", text: "#15803d" };
  if (g === "WARN")        return { bg: "#fef9c3", text: "#854d0e" };
  if (g === "FAIL")        return { bg: "#fee2e2", text: "#b91c1c" };
  if (g === "SKIPPED")     return { bg: "#f3f4f6", text: "#6b7280" };
  return                          { bg: "#f3f4f6", text: "#374151" }; // UNAVAILABLE
}

function priorityStyle(p: string): { bg: string; text: string } {
  if (p === "P1") return { bg: "#fee2e2", text: "#b91c1c" };
  if (p === "P2") return { bg: "#fef9c3", text: "#854d0e" };
  return                 { bg: "#fefce8", text: "#854d0e" };
}

function scoreColor(s: number): string {
  if (s >= 80) return "#16a34a";
  if (s >= 50) return "#d97706";
  return "#dc2626";
}

// ---------------------------------------------------------------------------
// SVG gauge (half-circle, 0-100)
// ---------------------------------------------------------------------------

function gauge(score: number): string {
  const r = 40;
  const cx = 55, cy = 58;
  const arcLen = Math.PI * r; // ≈ 125.66
  const filled = (score / 100) * arcLen;
  const color = scoreColor(score);
  return `
    <svg viewBox="0 0 110 65" width="130" height="80" aria-label="Composite score ${score}">
      <path d="M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}"
        fill="none" stroke="#e5e7eb" stroke-width="9" stroke-linecap="round"/>
      <path d="M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}"
        fill="none" stroke="${color}" stroke-width="9" stroke-linecap="round"
        stroke-dasharray="${filled.toFixed(1)} ${arcLen.toFixed(1)}"
        transform="rotate(0 ${cx} ${cy})"/>
      <text x="${cx}" y="${cy - 4}" text-anchor="middle"
        font-size="22" font-weight="700" fill="${color}">${score}</text>
      <text x="${cx}" y="${cy + 10}" text-anchor="middle"
        font-size="9" fill="#6b7280">/ 100</text>
    </svg>`;
}

// ---------------------------------------------------------------------------
// HTML fragments
// ---------------------------------------------------------------------------

function badge(label: string, bg: string, text: string): string {
  return `<span style="display:inline-block;padding:2px 10px;border-radius:999px;
    font-size:12px;font-weight:600;background:${bg};color:${text}">${esc(label)}</span>`;
}

function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function scorecardHtml(scorecard: ReportData["scorecard"]): string {
  const rows = scorecard.map(e => {
    const gs = gateStyle(e.gate);
    const gateBadge = badge(e.gate, gs.bg, gs.text);
    let detail = "";
    if (e.score !== undefined) {
      detail = `<span style="font-weight:600">${e.score}</span><span style="color:#9ca3af;font-size:12px">/100</span>`;
      if (e.breakdown) {
        const parts = Object.entries(e.breakdown)
          .map(([k, v]) => `<span style="color:#6b7280;font-size:11px">${esc(k)}&nbsp;<b style="color:#111">${v}</b></span>`)
          .join("&ensp;·&ensp;");
        detail += `<div style="margin-top:4px">${parts}</div>`;
      }
    } else if (e.issues !== undefined) {
      detail = `<span style="font-weight:600">${e.issues}</span><span style="color:#9ca3af;font-size:12px">&nbsp;issue${e.issues !== 1 ? "s" : ""}</span>`;
    } else {
      detail = `<span style="color:#9ca3af;font-size:12px">—</span>`;
    }
    return `<tr>
      <td style="padding:12px 16px;font-weight:500">${esc(e.tool)}</td>
      <td style="padding:12px 16px">${gateBadge}</td>
      <td style="padding:12px 16px">${detail}</td>
    </tr>`;
  }).join("");
  return `
    <table style="width:100%;border-collapse:collapse">
      <thead>
        <tr style="border-bottom:2px solid #e5e7eb">
          <th style="padding:10px 16px;text-align:left;font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:.05em">Tool</th>
          <th style="padding:10px 16px;text-align:left;font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:.05em">Gate</th>
          <th style="padding:10px 16px;text-align:left;font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:.05em">Result</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function findingCard(f: Record<string, unknown>, showConfidence = false): string {
  const p = String(f["priority"] ?? "P3");
  const ps = priorityStyle(p);
  const title = String(f["title"] ?? "");
  const desc = String(f["description"] ?? "");
  const source = String(f["source_tool"] ?? "");
  const confirmedBy = Array.isArray(f["confirmed_by"]) ? (f["confirmed_by"] as string[]) : [];
  const evidence = f["evidence"] as Record<string, unknown> | undefined;

  const evidenceParts = evidence
    ? Object.entries(evidence)
        .filter(([, v]) => v !== "" && v !== null && v !== undefined)
        .map(([k, v]) => `<span style="font-size:11px;color:#6b7280"><b>${esc(k)}:</b>&nbsp;${esc(v)}</span>`)
        .join("&ensp;·&ensp;")
    : "";

  const corroborationBadge = showConfidence && confirmedBy.length > 0
    ? `<span style="margin-left:8px;display:inline-block;padding:2px 8px;border-radius:4px;
        font-size:11px;font-weight:600;background:#dbeafe;color:#1d4ed8">
        ★ confirmed by ${confirmedBy.join(" + ")}</span>`
    : "";

  const sourceBadge = `<span style="padding:2px 8px;border-radius:4px;font-size:11px;
    background:#f3f4f6;color:#374151">${esc(source)}</span>`;

  return `
    <details style="margin-bottom:8px;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden">
      <summary style="display:flex;align-items:center;gap:10px;padding:12px 16px;
        cursor:pointer;list-style:none;background:#fff;user-select:none">
        <span style="min-width:36px">${badge(p, ps.bg, ps.text)}</span>
        <span style="flex:1;font-weight:500;font-size:14px">${esc(title)}</span>
        ${corroborationBadge}
        <span style="margin-left:auto">${sourceBadge}</span>
      </summary>
      <div style="padding:12px 16px;background:#fafafa;border-top:1px solid #e5e7eb">
        <p style="margin:0 0 8px;font-size:14px;color:#374151;line-height:1.5">${esc(desc)}</p>
        ${evidenceParts ? `<div style="margin-top:8px;padding:8px;background:#f3f4f6;border-radius:4px">${evidenceParts}</div>` : ""}
      </div>
    </details>`;
}

function findingSection(
  label: string,
  findings: Array<Record<string, unknown>>,
  bg: string,
  text: string,
  showConfidence = false,
  open = false,
): string {
  if (findings.length === 0) return "";
  const cards = findings.map(f => findingCard(f, showConfidence)).join("");
  return `
    <details ${open ? "open" : ""} style="margin-bottom:16px">
      <summary style="cursor:pointer;list-style:none;padding:10px 14px;
        background:${bg};color:${text};border-radius:8px;font-weight:600;
        font-size:14px;user-select:none">
        ${esc(label)} &nbsp;<span style="font-weight:400;opacity:.8">(${findings.length})</span>
      </summary>
      <div style="margin-top:8px">${cards}</div>
    </details>`;
}

// ---------------------------------------------------------------------------
// Full page
// ---------------------------------------------------------------------------

export function buildReportHtml(data: ReportData): string {
  const rc = readinessColors(data.release_readiness);
  const target = data.url ?? data.path ?? "—";
  const isUrl = !!data.url;

  const p1 = data.all_findings.filter(f => f["priority"] === "P1");
  const p2 = data.all_findings.filter(f => f["priority"] === "P2");
  const p3 = data.all_findings.filter(f => f["priority"] === "P3");

  const corrobSection = data.corroborated_findings.length > 0
    ? `<div style="margin-bottom:24px">
        <h2 style="font-size:16px;font-weight:700;margin:0 0 12px;color:#1d4ed8">
          ★ Cross-confirmed findings
          <span style="font-size:12px;font-weight:400;color:#6b7280;margin-left:8px">
            flagged independently by two tools — highest confidence
          </span>
        </h2>
        ${data.corroborated_findings.map(f => findingCard(f as Record<string, unknown>, true)).join("")}
      </div>`
    : "";

  const errorsHtml = data.errors && data.errors.length > 0
    ? `<div style="margin-bottom:24px;padding:12px 16px;background:#fef3c7;
        border:1px solid #fcd34d;border-radius:8px">
        <p style="margin:0 0 6px;font-weight:600;font-size:13px;color:#92400e">Tool warnings</p>
        ${data.errors.map(e => `<p style="margin:2px 0;font-size:13px;color:#78350f">${esc(e)}</p>`).join("")}
      </div>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>QA Report — ${esc(target)}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #f3f4f6; color: #111827; }
    details > summary::-webkit-details-marker { display: none; }
    details > summary::marker { display: none; }
    a { color: #2563eb; }
  </style>
</head>
<body>
  <!-- Top bar -->
  <div style="background:#1e293b;padding:14px 32px;display:flex;
      align-items:center;justify-content:space-between">
    <div>
      <span style="font-size:13px;font-weight:700;color:#94a3b8;
        text-transform:uppercase;letter-spacing:.08em">QA Gate Report</span>
      <div style="margin-top:2px;font-size:14px;color:#e2e8f0">
        ${isUrl ? `<a href="${esc(data.url)}" style="color:#7dd3fc" target="_blank">${esc(target)}</a>`
                : `<code style="color:#7dd3fc">${esc(target)}</code>`}
      </div>
      ${data.context
        ? `<div style="margin-top:2px;font-size:12px;color:#94a3b8">${esc(data.context)}</div>`
        : ""}
    </div>
    <div style="font-size:12px;color:#64748b">${esc(data.generated_at)}</div>
  </div>

  <div style="max-width:960px;margin:0 auto;padding:32px 24px">

    <!-- Release readiness + composite score -->
    <div style="display:grid;grid-template-columns:1fr auto;gap:16px;
        background:${rc.bg};border:1px solid ${rc.border};border-radius:12px;
        padding:24px;margin-bottom:24px;align-items:center">
      <div>
        <div style="font-size:13px;font-weight:600;color:${rc.text};
          text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">
          Release Readiness
        </div>
        <div style="font-size:36px;font-weight:800;color:${rc.text};margin-bottom:8px">
          ${esc(data.release_readiness)}
        </div>
        <p style="margin:0;font-size:14px;color:${rc.text};opacity:.85;line-height:1.5">
          ${esc(data.summary)}
        </p>
      </div>
      <div style="text-align:center">
        ${gauge(data.composite_score)}
        <div style="font-size:11px;color:#6b7280;margin-top:2px">Composite Score</div>
      </div>
    </div>

    <!-- Scorecard -->
    <div style="background:#fff;border:1px solid #e5e7eb;border-radius:12px;
        padding:0;margin-bottom:24px;overflow:hidden">
      <div style="padding:14px 16px;border-bottom:1px solid #e5e7eb">
        <h2 style="margin:0;font-size:15px;font-weight:700">Scorecard</h2>
      </div>
      ${scorecardHtml(data.scorecard)}
    </div>

    ${errorsHtml}

    <!-- Findings -->
    <div style="background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:20px">
      <h2 style="margin:0 0 16px;font-size:15px;font-weight:700">
        Findings
        <span style="font-size:13px;font-weight:400;color:#6b7280;margin-left:8px">
          ${data.all_findings.length} total — ${p1.length} P1 · ${p2.length} P2 · ${p3.length} P3
        </span>
      </h2>

      ${corrobSection}

      ${findingSection("P1 — Blockers", p1, "#fee2e2", "#b91c1c", false, true)}
      ${findingSection("P2 — Warnings", p2, "#fef9c3", "#854d0e", false, false)}
      ${findingSection("P3 — Advisories", p3, "#fefce8", "#854d0e", false, false)}

      ${data.all_findings.length === 0
        ? `<p style="text-align:center;padding:32px;color:#6b7280">No findings — all clear.</p>`
        : ""}
    </div>

  </div>
</body>
</html>`;
}

/**
 * Writes the HTML report, and optionally a JSON copy of the tool result beside
 * it. `outputDir` unset keeps the historical behaviour: HTML only, in the OS
 * temp directory.
 */
export async function generateHtmlReport(
  data: ReportData,
  options: {
    outputDir?: string;
    /** Builds the JSON copy; receives both paths so the copy can reference them. */
    json?: (paths: { html: string; json: string }) => unknown;
  } = {},
): Promise<{ html: string; json?: string }> {
  const timestamp = Date.now();
  const host = (data.url
    ? new URL(data.url).hostname
    : String(data.path ?? "local").split("/").pop() ?? "local"
  ).replace(/[^a-z0-9]/gi, "-").toLowerCase();

  const dir = options.outputDir ? resolve(options.outputDir) : tmpdir();
  if (options.outputDir) await mkdir(dir, { recursive: true });

  const base = `qa-report-${host}-${timestamp}`;
  const html = join(dir, `${base}.html`);
  await writeFile(html, buildReportHtml(data), "utf8");

  if (options.outputDir && options.json !== undefined) {
    const json = join(dir, `${base}.json`);
    await writeFile(json, JSON.stringify(options.json({ html, json }), null, 2), "utf8");
    return { html, json };
  }
  return { html };
}
