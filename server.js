#!/usr/bin/env node

/**
 * REPYH MCP HTTP Server (founders)
 *
 * Exposes the REPYH founder MCP server over HTTP (Streamable HTTP transport, stateless).
 * Compatible with Smithery, Claude Desktop (remote), and any MCP HTTP client.
 *
 * POST /mcp  — MCP Streamable HTTP endpoint (requires the CALLER's own founder API key)
 * GET  /     — Health check
 *
 * Auth (per request, in priority order):
 *   1. Authorization: Bearer repyh_...   (nuvc_... keys minted before audiences are accepted too)
 *   2. X-API-Key: repyh_...
 *   (a key in the URL is not accepted: URLs are logged by proxies and clients)
 *
 * SECURITY: this server NEVER reads a shared key from the environment. Every request is
 * authenticated with, and billed to, the caller's own key; a request without one gets 401.
 * Each request builds its own handler context (and its own own-data guard).
 *
 * Hardening (env): MCP_ALLOWED_ORIGINS (comma-separated; a request with an Origin header not listed
 * gets 403, none by default), MCP_RATE_LIMIT_PER_MINUTE (per key, default 60) and
 * MCP_RATE_LIMIT_PER_MINUTE_IP (per address, IPv6 by /64, default 600), 429 + Retry-After, one access-log line per request on stderr (no query string, no key, no body).
 *
 * env: PORT (default 3000)
 */

import http from "node:http";
import { SERVER_INSTRUCTIONS } from "./lib/guidance.js";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { cleanText } from "./lib/own-data.js";
import { originRefused, clientAddress, createLimiters, addressBucket, keyBucket, accessLogLine } from "./lib/http-guards.js";
import { getTools, createHandlers, isValidApiKey, KEY_HELP } from "./lib/tools.js";

const { version } = createRequire(import.meta.url)("./package.json");

export const MAX_BODY_BYTES = 1024 * 1024; // 1 MB

// ---------------------------------------------------------------------------
// Build MCP server — one instance (and one tool context) per request
// ---------------------------------------------------------------------------

export function createMcpServer(apiKey) {
  const HANDLERS = createHandlers(apiKey);
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

  return server;
}

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

function sendJson(res, status, payload, extraHeaders = {}) {
  if (res.headersSent) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

function rpcError(code, message) {
  return { jsonrpc: "2.0", error: { code, message }, id: null };
}

/** Extract the caller's own API key from the request (headers only; never the URL). */
export function extractApiKey(req) {
  const auth = req.headers["authorization"];
  if (typeof auth === "string") {
    const m = /^Bearer\s+(\S+)$/i.exec(auth.trim());
    if (m) return m[1];
  }
  const xKey = req.headers["x-api-key"];
  if (typeof xKey === "string" && xKey.trim()) return xKey.trim();
  return undefined;
}

class BodyTooLargeError extends Error {}

async function readBody(req, limit = MAX_BODY_BYTES) {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > limit) throw new BodyTooLargeError();
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new BodyTooLargeError();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

async function handleMcp(req, res, { env, limiters }) {
  // Origin (DNS rebinding) and rate limit BEFORE auth and before the body is read.
  if (originRefused(req, env)) {
    sendJson(res, 403, rpcError(-32000, "Forbidden: origin not allowed"));
    return;
  }
  const tooMany = (verdict) =>
    sendJson(res, 429, rpcError(-32000, "Rate limit exceeded. Retry shortly."), { "Retry-After": String(verdict.retryAfterSeconds) });
  const ipVerdict = limiters.ip.take(addressBucket(clientAddress(req, env)));
  if (!ipVerdict.ok) return tooMany(ipVerdict);

  // Authenticate BEFORE reading the body — an anonymous caller costs us nothing.
  const apiKey = extractApiKey(req);
  if (!isValidApiKey(apiKey)) {
    sendJson(
      res,
      401,
      rpcError(-32001, `Unauthorized: send your REPYH API key as 'Authorization: Bearer repyh_...'. ${KEY_HELP}`),
      { "WWW-Authenticate": 'Bearer realm="repyh-mcp"' }
    );
    return;
  }

  // Per-key cap (shape-valid keys only), still before the body is read.
  const keyVerdict = limiters.key.take(keyBucket(apiKey));
  if (!keyVerdict.ok) return tooMany(keyVerdict);

  if (req.method !== "POST") {
    sendJson(res, 405, rpcError(-32000, "Method not allowed"), { Allow: "POST" });
    return;
  }

  let raw;
  try {
    raw = await readBody(req);
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      // Respond first, then drop the connection (after a short grace period so the client can
      // read the 413 before the socket closes) so it stops uploading.
      res.once("finish", () => setTimeout(() => req.destroy(), 250).unref());
      sendJson(res, 413, rpcError(-32000, `Request body too large (max ${MAX_BODY_BYTES} bytes)`));
      return;
    }
    throw err;
  }

  let parsed;
  if (raw) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      sendJson(res, 400, rpcError(-32700, "Parse error: request body is not valid JSON"));
      return;
    }
  }

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
  });
  res.on("close", () => transport.close());

  const server = createMcpServer(apiKey);
  await server.connect(transport);
  await transport.handleRequest(req, res, parsed);
}

export function createHttpServer({ env = process.env, log = (line) => console.error(line) } = {}) {
  const limiters = createLimiters(env);
  return http.createServer(async (req, res) => {
    const started = Date.now();
    const client = clientAddress(req, env);
    const pathname = (req.url || "/").split("?")[0];
    // The health check is not logged (Fly polls it every 30s). 499 = the client left before the response finished.
    if (!(req.method === "GET" && pathname === "/")) {
      res.on("close", () => log(accessLogLine({ name: "repyh-mcp", req, status: res.writableFinished ? res.statusCode : 499, ms: Date.now() - started, client })));
    }
    try {

      // Health check
      if (req.method === "GET" && pathname === "/") {
        sendJson(res, 200, { ok: true, name: "repyh-mcp", version });
        return;
      }

      if (pathname === "/mcp") {
        await handleMcp(req, res, { env, limiters });
        return;
      }

      sendJson(res, 404, { error: "Not found" });
    } catch (err) {
      // Never leak internals (stack traces, paths) to the caller.
      console.error(`repyh-mcp request failed: ${err?.name || "Error"}: ${err?.message}`);
      sendJson(res, 500, rpcError(-32603, "Internal server error"));
    }
  });
}

process.on("unhandledRejection", (reason) => {
  console.error(`repyh-mcp unhandledRejection: ${reason instanceof Error ? reason.message : String(reason)}`);
});

// Start only when run directly (`node server.js`), not when imported by tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const PORT = parseInt(process.env.PORT || "3000", 10);
  createHttpServer().listen(PORT, () => {
    console.error(`REPYH MCP server listening on port ${PORT}`);
    console.error(`MCP endpoint: http://localhost:${PORT}/mcp (requires 'Authorization: Bearer repyh_...')`);
  });
}
