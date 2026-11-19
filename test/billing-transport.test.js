import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHttpServer } from "../server.js";
import { stubApi } from "./helpers.js";

const KEY = "repyh_test_key_billing";
const TOOL = "repyh_billing";

test("billing over HTTP uses the caller's key for one read and returns measured balance", { timeout: 10000 }, async () => {
  const api = stubApi(() => ({ data: { balance: 17, balanceAvailable: true, audience: "founder", pack: null, toolCosts: [] } }));
  const server = createHttpServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const client = new Client({ name: "billing-test", version: "1" }, { capabilities: {} });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${KEY}` } },
    }));
    const result = await client.callTool({ name: TOOL, arguments: {} });
    assert.notEqual(result.isError, true);
    assert.match(result.content[0].text, /balance: 17/);
    assert.equal(api.calls.length, 1);
    assert.equal(api.calls[0].method, "GET");
    assert.equal(api.calls[0].path, "/v3/ai/billing");
    assert.equal(api.calls[0].key, KEY);
  } finally {
    await client.close();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    api.restore();
  }
});

test("billing over stdio reads the backend without scoring or opening checkout", { timeout: 10000 }, async () => {
  const client = new Client({ name: "billing-test", version: "1" }, { capabilities: {} });
  try {
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: ["--import", new URL("./billing-stub.js", import.meta.url).pathname, new URL("../index.js", import.meta.url).pathname],
      env: { PATH: process.env.PATH, REPYH_API_KEY: KEY, NUVC_TOOLSET: "all" },
    }));
    const result = await client.callTool({ name: TOOL, arguments: {} });
    assert.notEqual(result.isError, true);
    assert.match(result.content[0].text, /balance: 17/);
    assert.match(result.content[0].text, /No self-serve credit pack/);
  } finally { await client.close(); }
});
