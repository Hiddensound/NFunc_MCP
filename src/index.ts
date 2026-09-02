#!/usr/bin/env node
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerLighthouseTool } from "./tools/lighthouse.js";
import { registerAccessibilityTool } from "./tools/accessibility.js";
import { registerStaticAnalysisTool } from "./tools/staticAnalysis.js";
import { registerQaGateTool } from "./tools/qaGate.js";
import { registerPerformanceAuditPlanTool } from "./tools/performanceAuditPlan.js";
import { registerPerformanceAuditTool } from "./tools/performanceAudit.js";

/**
 * Identity comes from package.json rather than being written out here, so the
 * two cannot drift — they already had, declaring qa-mcp/0.1.0 against
 * nfunc-mcp/0.2.0 after the npm rename, and `npm version` would reintroduce
 * the gap on every release if these were hardcoded.
 *
 * "../package.json" resolves to the repo root from both src/index.ts and
 * dist/index.js, and npm always ships package.json, so the same path works in
 * dev, in a local build, and in an installed package. Falls back rather than
 * failing to boot if it is ever unreadable.
 */
function readIdentity(): { name: string; version: string } {
  try {
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
    ) as { name?: string; version?: string };
    return { name: pkg.name ?? "nfunc-mcp", version: pkg.version ?? "0.0.0" };
  } catch {
    return { name: "nfunc-mcp", version: "0.0.0" };
  }
}

const server = new McpServer(readIdentity());

server.registerTool(
  "ping",
  {
    description: "Health-check tool. Returns ok status and current ISO timestamp.",
    inputSchema: {},
  },
  async () => {
    const payload = {
      status: "ok",
      timestamp: new Date().toISOString(),
    };
    return {
      content: [{ type: "text", text: JSON.stringify(payload) }],
    };
  },
);

registerLighthouseTool(server);
registerAccessibilityTool(server);
registerStaticAnalysisTool(server);
registerQaGateTool(server);
registerPerformanceAuditPlanTool(server);
registerPerformanceAuditTool(server);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("qa-mcp fatal error:", err);
  process.exit(1);
});
