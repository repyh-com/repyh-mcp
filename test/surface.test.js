// Tool surface contract: exact founder tool list over both transports; no investor tools.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createHttpServer } from "../server.js";
import { TOOLS, getTools, createHandlers } from "../lib/tools.js";
import { FOUNDER_TOOL_NAMES, KEY_A, aliceApi } from "./helpers.js";

const FORBIDDEN = /mandate|screen_fund|match_investors|venture_math|fund_economics|nuvc_/;

test("tool list is exactly the founder surface; handlers cover exactly it", () => {
  assert.deepEqual(TOOLS.map((t) => t.name).sort(), FOUNDER_TOOL_NAMES);
  assert.deepEqual(getTools().map((t) => t.name).sort(), FOUNDER_TOOL_NAMES);
  assert.deepEqual(Object.keys(createHandlers(KEY_A)).sort(), FOUNDER_TOOL_NAMES);
});

test("no investor tools and no tool takes a user/owner argument", () => {
  for (const t of TOOLS) {
    assert.ok(!FORBIDDEN.test(t.name), `${t.name} looks like an investor/nuvc tool`);
    for (const p of Object.keys(t.inputSchema.properties)) {
      assert.ok(!/user|owner|investor|account/i.test(p), `${t.name} exposes identity arg '${p}'`);
    }
  }
});

test("descriptions are plain founder wording, each ends with one example prompt, and none presents NUVC as the product", () => {
  for (const t of getTools()) {
    assert.match(t.description, / Example: "[^"]+"$/, t.name);
    assert.ok(t.description.length <= 200, `${t.name} is ${t.description.length} characters`);
    assert.doesNotMatch(t.description, /nuvc/i, t.name);
  }
  const d = Object.fromEntries(getTools().map((t) => [t.name, t.description]));
  assert.match(d.repyh_deck_matches, /where your plan includes them/);
  assert.match(d.repyh_deck_scores, /^Scores out of 10, red flags and what to improve\./);
});

test("roast posts text only to the AI analyze endpoint", async () => {
  const api = aliceApi();
  try {
    const out = await createHandlers(KEY_A).repyh_roast({ text: "Uber for dogs" });
    assert.match(out, /Hard truth\./);
    assert.deepEqual(api.calls.map((c) => c.path), ["/v3/ai/analyze"]);
  } finally { api.restore(); }
});

test("stdio tools/list is exactly the founder surface", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [new URL("../index.js", import.meta.url).pathname],
    env: { PATH: process.env.PATH, REPYH_API_KEY: "nuvc_test_key_stdio" },
  });
  const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
  await client.connect(transport);
  try {
    assert.deepEqual((await client.listTools()).tools.map((t) => t.name).sort(), FOUNDER_TOOL_NAMES);
  } finally {
    await client.close();
  }
});

let server, base;
before(async () => {
  server = createHttpServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
});

const H = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
const rpc = (headers, method, params) =>
  fetch(`${base}/mcp`, { method: "POST", headers: { ...H, ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });

test("http: 401 without the caller's own key, even when a shared env key exists", async () => {
  process.env.NUVC_API_KEY = "nuvc_shared_server_env_key";
  try {
    const res = await rpc({}, "tools/list", {});
    assert.equal(res.status, 401);
  } finally {
    delete process.env.NUVC_API_KEY;
  }
});

test("http: tools/list is the founder surface; a foreign deck is rejected end to end", async () => {
  const list = await rpc({ Authorization: `Bearer ${KEY_A}` }, "tools/list", {});
  const body = await list.text();
  for (const n of FOUNDER_TOOL_NAMES) assert.ok(body.includes(n), n);
  assert.ok(!/nuvc_(score|screen|set_mandate)/.test(body));

  const api = aliceApi();
  try {
    const res = await rpc({ Authorization: `Bearer ${KEY_A}` }, "tools/call", {
      name: "repyh_deck_scores",
      arguments: { deck_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
    });
    const text = await res.text();
    assert.match(text, /isError":true/);
    assert.match(text, /not one of your own decks/);
  } finally {
    api.restore();
  }
});
