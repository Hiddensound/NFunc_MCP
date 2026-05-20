#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerLighthouseTool } from "./tools/lighthouse.js";
import { registerAccessibilityTool } from "./tools/accessibility.js";
import { registerStaticAnalysisTool } from "./tools/staticAnalysis.js";
import { registerQaGateTool } from "./tools/qaGate.js";

const server = new McpServer({
  name: "qa-mcp",
  version: "0.1.0",
});

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

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("qa-mcp fatal error:", err);
  process.exit(1);
});
