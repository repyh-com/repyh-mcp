// Key handling and founder-facing errors (#6736): REPYH_API_KEY first, NUVC_API_KEY deprecated fallback,
// repyh_ and nuvc_ keys accepted, a 403 FORBIDDEN rendered for a founder, and no pointer back to NUVC.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createHttpServer, extractApiKey } from "../server.js";
import { createHandlers, envApiKey, isValidApiKey, KEY_HELP } from "../lib/tools.js";
import { ALICE_DECK, KEY_A, aliceApi, stubApi } from "./helpers.js";

const FOUNDER_KEY = "repyh_" + "a".repeat(64);
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const NO_NUVC_POINTER = /nuvc\.ai\/api-platform|NUVC_API_KEY/;

test("isValidApiKey accepts repyh_ and nuvc_ keys only, and not a bare prefix", () => {
  assert.equal(isValidApiKey(FOUNDER_KEY), true);
  assert.equal(isValidApiKey(KEY_A), true);
  for (const bad of [undefined, null, "", "repyh_", "nuvc_", "sk_live_abc", "Bearer repyh_abc", 42]) {
    assert.equal(isValidApiKey(bad), false, String(bad));
  }
});

test("envApiKey: REPYH_API_KEY wins; NUVC_API_KEY is the fallback; neither -> undefined", () => {
  assert.equal(envApiKey({ REPYH_API_KEY: FOUNDER_KEY, NUVC_API_KEY: KEY_A }), FOUNDER_KEY);
  assert.equal(envApiKey({ NUVC_API_KEY: KEY_A }), KEY_A);
  assert.equal(envApiKey({ REPYH_API_KEY: "", NUVC_API_KEY: KEY_A }), KEY_A);
  assert.equal(envApiKey({}), undefined);
});

test("a repyh_ key and a legacy nuvc_ key both reach the API as Bearer, with a repyh-mcp User-Agent", async () => {
  const api = aliceApi();
  try {
    await createHandlers(FOUNDER_KEY).repyh_roast({ text: "x" });
    await createHandlers(() => envApiKey({ NUVC_API_KEY: KEY_A })).repyh_roast({ text: "x" });
    assert.deepEqual(api.calls.map((c) => c.key), [FOUNDER_KEY, KEY_A]);
    for (const c of api.calls) assert.equal(c.userAgent, `repyh-mcp/${version}`);
  } finally { api.restore(); }
});

test("a key with an embedded newline is refused before any fetch and is never echoed", async () => {
  const bad = "repyh_abc123\nX-Injected: 1";
  assert.equal(isValidApiKey(bad), false);
  assert.equal(isValidApiKey("nuvc_abc\r\nx"), false);
  assert.equal(isValidApiKey(` ${FOUNDER_KEY} `), true); // surrounding whitespace is trimmed
  const api = aliceApi();
  try {
    await assert.rejects(
      () => createHandlers(bad).repyh_list_decks({}),
      (e) => !e.message.includes("abc123") && !e.message.includes("X-Injected") && e.message.includes(KEY_HELP)
    );
    assert.equal(api.calls.length, 0);
  } finally { api.restore(); }
});

test("any other key is refused before a request, with founder wording that does not point to NUVC", async () => {
  const api = aliceApi();
  try {
    for (const bad of ["sk_live_abc", "", undefined, "repyh_"]) {
      await assert.rejects(
        () => createHandlers(bad).repyh_list_decks({}),
        (e) => e.message.includes("REPYH_API_KEY") && e.message.includes(KEY_HELP) && !NO_NUVC_POINTER.test(e.message),
        String(bad)
      );
    }
    assert.equal(api.calls.length, 0);
  } finally { api.restore(); }
});

test("401 / 402 / 403 FORBIDDEN / plain 403 map to founder messages (raw API text is not echoed)", async () => {
  const cases = [
    [{ status: 401, body: { error: { message: "Invalid NUVC API key" } } }, /not accepted.*REPYH_API_KEY.*REPYH account/s],
    [{ status: 402, body: { detail: "pay" } }, /access included in your plan.*repyh_billing.*REPYH account/s],
    [{ status: 403, body: { detail: { code: "FORBIDDEN", message: "Key audience cannot call this route", required_scope: ["ai:analyze"] } } },
      /^This API key cannot do that here\.$/],
    [{ status: 403, body: { error: { code: "FORBIDDEN", message: "nope" } } }, /cannot do that here/],
    [{ status: 403, body: { detail: "forbidden" } }, /Not found, or not one of your own decks/],
  ];
  for (const [response, expected] of cases) {
    const api = stubApi(() => response);
    try {
      await assert.rejects(
        () => createHandlers(KEY_A).repyh_roast({ text: "x" }),
        (e) => expected.test(e.message) && !NO_NUVC_POINTER.test(e.message) && !/Invalid NUVC|Key audience|required_scope/.test(e.message)
      );
    } finally { api.restore(); }
  }
});

test("FORBIDDEN from a deck read is the founder message, not 'not one of your own decks'", async () => {
  const api = aliceApi({
    [`/v2/pitch-decks/${ALICE_DECK}/scores`]: { status: 403, body: { detail: { code: "FORBIDDEN", message: "x", required_scope: [] } } },
  });
  try {
    await assert.rejects(() => createHandlers(KEY_A).repyh_deck_scores({ deck_id: ALICE_DECK }), /cannot do that here/);
  } finally { api.restore(); }
});

test("no founder-facing source or doc points a founder at the NUVC key page, billing or pricing", () => {
  for (const f of ["../lib/tools.js", "../index.js", "../server.js", "../README.md", "../CHANGELOG.md", "../package.json"]) {
    const src = readFileSync(new URL(f, import.meta.url), "utf8");
    assert.ok(!/nuvc\.ai\/(api-platform|pricing)/.test(src), `${f} links a founder to NUVC`);
  }
});

test("stdio: with only NUVC_API_KEY set, a deprecation notice goes to stderr; with only REPYH_API_KEY there is none", async () => {
  async function stderrOf(env) {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [new URL("../index.js", import.meta.url).pathname],
      env: { PATH: process.env.PATH, ...env },
      stderr: "pipe",
    });
    let err = "";
    transport.stderr?.on("data", (d) => (err += d));
    const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
    await client.connect(transport);
    try {
      await client.listTools();
      return err;
    } finally { await client.close(); }
  }
  assert.match(await stderrOf({ NUVC_API_KEY: KEY_A }), /NUVC_API_KEY is deprecated.*REPYH_API_KEY/);
  assert.doesNotMatch(await stderrOf({ REPYH_API_KEY: FOUNDER_KEY }), /deprecated/i);
});

test("stdio: a call with no usable key fails with the REPYH key help and no network call", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [new URL("../index.js", import.meta.url).pathname],
    env: { PATH: process.env.PATH, REPYH_API_KEY: "not-a-key" },
    stderr: "ignore",
  });
  const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
  await client.connect(transport);
  try {
    const res = await client.callTool({ name: "repyh_list_decks", arguments: {} });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /REPYH_API_KEY.*REPYH account/s);
    assert.ok(!NO_NUVC_POINTER.test(res.content[0].text));
  } finally { await client.close(); }
});

// ---- HTTP transport ----
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
const listTools = (headers, query = "") =>
  fetch(`${base}/mcp${query}`, { method: "POST", headers: { ...H, ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });

test("http: repyh_ and nuvc_ keys are accepted in Bearer and X-API-Key", async () => {
  for (const headers of [{ Authorization: `Bearer ${FOUNDER_KEY}` }, { "X-API-Key": FOUNDER_KEY }, { Authorization: `Bearer ${KEY_A}` }]) {
    const res = await listTools(headers);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /repyh_roast/);
  }
});

test("http: a key in the URL (?config=) is never accepted; headers only", async () => {
  const cfg = (o) => `?config=${encodeURIComponent(Buffer.from(JSON.stringify(o)).toString("base64"))}`;
  assert.equal(extractApiKey({ url: `/mcp${cfg({ REPYH_API_KEY: FOUNDER_KEY })}`, headers: {} }), undefined);
  for (const o of [{ REPYH_API_KEY: FOUNDER_KEY }, { NUVC_API_KEY: KEY_A }]) {
    const res = await listTools({}, cfg(o));
    assert.equal(res.status, 401);
    assert.match((await res.json()).error.message, /Authorization: Bearer/);
  }
});

test("http: a missing or malformed key is 401 with REPYH wording, even with REPYH_API_KEY in the server env", async () => {
  process.env.REPYH_API_KEY = FOUNDER_KEY;
  try {
    for (const headers of [{}, { Authorization: "Bearer sk_live_abc" }]) {
      const res = await listTools(headers);
      assert.equal(res.status, 401);
      const msg = (await res.json()).error.message;
      assert.match(msg, /REPYH API key.*REPYH account/s);
      assert.ok(!NO_NUVC_POINTER.test(msg));
    }
  } finally { delete process.env.REPYH_API_KEY; }
});

test("a 422 detail list shows only field names; an object detail never prints [object Object] (#6763)", async () => {
  const cases = [
    [{ status: 422, body: { detail: [{ loc: ["body", "text"], msg: "String should have at least 10 characters", type: "x" }] } }, /^Check your input: text\.$/],
    [{ status: 400, body: { detail: { code: "ODD", extra: 1 } } }, /^Check your input and try again\.$/],
  ];
  for (const [response, expected] of cases) {
    const api = stubApi(() => response);
    try {
      await assert.rejects(() => createHandlers(KEY_A).repyh_roast({ text: "x" }), (e) => expected.test(e.message) && !e.message.includes("[object Object]"));
    } finally { api.restore(); }
  }
});

test("a quota-exceeded 429 shows a fixed founder quota message, never the backend's; an expired key says so (#6763)", async () => {
  let api = stubApi(() => ({ status: 429, body: { detail: { code: "QUOTA_EXCEEDED", message: "Keep scoring with pay-as-you-go score credits ($99 AUD = 50 scores); top up at /api-platform/billing" } } }));
  try {
    await assert.rejects(() => createHandlers(KEY_A).repyh_roast({ text: "x" }), (e) => e.message === "Your monthly quota is used up. Use repyh_billing to check your reset date and allowance (free read). Founder credits do not extend pitch feedback quota; review your plan in your REPYH account.");
  } finally { api.restore(); }
  api = stubApi(() => ({ status: 429, body: { detail: { code: "QUOTA_EXCEEDED", message: "Upgrade at nuvc.ai" } } }));
  try {
    await assert.rejects(() => createHandlers(KEY_A).repyh_roast({ text: "x" }), (e) => /monthly quota.*REPYH account/.test(e.message) && !NO_NUVC_POINTER.test(e.message));
  } finally { api.restore(); }
  api = stubApi(() => ({ status: 401, body: { detail: "API key has expired" } }));
  try {
    await assert.rejects(() => createHandlers(KEY_A).repyh_roast({ text: "x" }), (e) => /expired.*30 days.*REPYH account/s.test(e.message) && !NO_NUVC_POINTER.test(e.message));
  } finally { api.restore(); }
});
