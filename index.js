#!/usr/bin/env node

/**
 * REPYH MCP Server (founders) — stdio transport (Claude Desktop local, npx)
 * Create a founder API key in your REPYH account.
 *
 * stdio is a single-user, local process, so it reads the caller's own key from
 * REPYH_API_KEY (NUVC_API_KEY is a deprecated fallback). The HTTP transport (server.js)
 * never does - it requires a key per request.
 */

import { SERVER_INSTRUCTIONS } from "./lib/guidance.js";
import { createRequire } from "node:module";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { getTools, createHandlers, envApiKey } from "./lib/tools.js";
import { cleanText } from "./lib/own-data.js";

const { version } = createRequire(import.meta.url)("./package.json");

if (!process.env.REPYH_API_KEY && process.env.NUVC_API_KEY) {
  console.error("repyh-mcp: NUVC_API_KEY is deprecated here; set REPYH_API_KEY instead.");
}

const HANDLERS = createHandlers(() => envApiKey());

const server = new Server(
  { name: "repyh", version },
  { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: getTools() }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const handler = HANDLERS[name];
  if (!handler) {
    return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }
  try {
    const result = await handler(args || {});
    return { content: [{ type: "text", text: result }] };
  } catch (err) {
    return { content: [{ type: "text", text: `Error: ${cleanText(err.message)}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
