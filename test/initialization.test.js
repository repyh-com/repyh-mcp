import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHttpServer } from "../server.js";
import { SERVER_INSTRUCTIONS } from "../lib/guidance.js";

const client = () => new Client({ name: "onboarding-test", version: "1" }, { capabilities: {} });

test("HTTP initialization returns audience guidance without calling tools", { timeout: 10000 }, async () => {
  const server = createHttpServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const c = client();
  try {
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`), {
      requestInit: { headers: { Authorization: "Bearer repyh_test_key_init" } },
    }));
    assert.equal(c.getInstructions(), SERVER_INSTRUCTIONS);
    assert.match(c.getInstructions(), /REPYH/);
  } finally {
    await c.close();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("stdio initialization exposes the identical guide even before a key is configured", { timeout: 10000 }, async () => {
  const c = client();
  try {
    await c.connect(new StdioClientTransport({
      command: process.execPath,
      args: [new URL("../index.js", import.meta.url).pathname],
      env: { PATH: process.env.PATH, NUVC_TOOLSET: "all" },
    }));
    assert.equal(c.getInstructions(), SERVER_INSTRUCTIONS);
    assert.match(c.getInstructions(), /Do not|do not/);
  } finally { await c.close(); }
});
