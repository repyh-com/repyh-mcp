// HTTP transport hardening (#6737, repyh-mcp): key in headers only, Origin allow-list, per-client rate limit,
// access log without secrets, bounded limiter.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHttpServer, extractApiKey } from "../server.js";
import { createRateLimiter, accessLogLine, addressBucket, limitFromEnv } from "../lib/http-guards.js";
import { stubApi, KEY_A } from "./helpers.js";

const MCP_HEADERS = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
const LIST = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
const cfg = (o) => Buffer.from(JSON.stringify(o)).toString("base64");

async function withServer(env, fn) {
  const logs = [];
  const server = createHttpServer({ env, log: (l) => logs.push(l) });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  try {
    await fn({
      logs,
      port,
      post: (path, headers = {}, body = LIST) =>
        new Promise((resolve, reject) => {
          const req = http.request({ host: "127.0.0.1", port, path, method: "POST", headers: { ...MCP_HEADERS, ...headers } }, (res) => {
            let text = "";
            res.on("data", (c) => (text += c));
            res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text }));
          });
          req.on("error", reject);
          req.end(body);
        }),
    });
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
}

test("F10: a key in ?config= is never accepted, with or without a header setting", async () => {
  const api = stubApi(() => ({ success: true, data: {} }));
  try {
    await withServer({ NUVC_MCP_ALLOW_CONFIG_QUERY_KEY: "1" }, async ({ post }) => {
      const res = await post(`/mcp?config=${encodeURIComponent(cfg({ REPYH_API_KEY: KEY_A }))}`);
      assert.equal(res.status, 401);
      assert.match(JSON.parse(res.text).error.message, /Authorization: Bearer/);
      assert.equal((await post("/mcp", { Authorization: `Bearer ${KEY_A}` })).status, 200);
    });
    assert.equal(api.calls.length, 0);
    assert.equal(extractApiKey({ headers: {}, url: `/mcp?config=${cfg({ REPYH_API_KEY: KEY_A })}` }), undefined);
  } finally {
    api.restore();
  }
});

test("F14: a foreign Origin is refused with 403 before auth or body; no Origin and a listed Origin pass", async () => {
  const api = stubApi(() => ({ success: true, data: {} }));
  try {
    await withServer({ MCP_ALLOWED_ORIGINS: "https://app.example.com, https://other.example.com" }, async ({ post }) => {
      const auth = { Authorization: `Bearer ${KEY_A}` };
      assert.equal((await post("/mcp", { ...auth, Origin: "https://evil.example" })).status, 403);
      assert.equal((await post("/mcp", { ...auth, Origin: "null" })).status, 403);
      assert.equal((await post("/mcp", { ...auth, Origin: "https://app.example.com.evil.example" })).status, 403, "exact match only");
      assert.equal((await post("/mcp", { Origin: "https://evil.example" }, "{not json")).status, 403, "refused before auth and body");
      assert.equal((await post("/mcp", { ...auth, Origin: "https://other.example.com" })).status, 200);
      assert.equal((await post("/mcp", auth)).status, 200);
    });
    await withServer({}, async ({ post }) => {
      assert.equal((await post("/mcp", { Authorization: `Bearer ${KEY_A}`, Origin: "https://app.example.com" })).status, 403, "no allow-list by default");
    });
  } finally {
    api.restore();
  }
});

test("F13: per-address cap (every /mcp request): 429 with Retry-After; shared by different keys, separate per address", async () => {
  await withServer({ MCP_RATE_LIMIT_PER_MINUTE_IP: "3", FLY_APP_NAME: "x" }, async ({ post }) => {
    const from = (ip, key) => ({ Authorization: `Bearer ${key}`, "Fly-Client-IP": ip });
    for (const k of ["nuvc_keyone", "nuvc_keytwo", "nuvc_keythree"]) assert.equal((await post("/mcp", from("203.0.113.1", k))).status, 200);
    const limited = await post("/mcp", from("203.0.113.1", "nuvc_keyfour"));
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers["retry-after"]) >= 1);
    assert.equal((await post("/mcp", from("203.0.113.2", "nuvc_keyone"))).status, 200, "another address has its own bucket");
    // an unauthenticated flood is throttled by address too
    for (let i = 0; i < 3; i++) await post("/mcp", { "Fly-Client-IP": "203.0.113.9" });
    assert.equal((await post("/mcp", { "Fly-Client-IP": "203.0.113.9" })).status, 429);
  });
});

test("F13: per-key cap is independent of the per-address cap (two users behind one address do not starve each other)", async () => {
  await withServer({ MCP_RATE_LIMIT_PER_MINUTE: "2", MCP_RATE_LIMIT_PER_MINUTE_IP: "100" }, async ({ post }) => {
    const as = (key) => ({ Authorization: `Bearer ${key}` });
    assert.equal((await post("/mcp", as("nuvc_keyone"))).status, 200);
    assert.equal((await post("/mcp", as("nuvc_keyone"))).status, 200);
    const limited = await post("/mcp", as("nuvc_keyone"));
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers["retry-after"]) >= 1);
    assert.equal((await post("/mcp", as("nuvc_keytwo"))).status, 200, "same address, other key");
    assert.equal((await post("/mcp", { Authorization: "Bearer not-a-valid-shape" })).status, 401, "bad keys are not charged to a key bucket");
  });
});

test("F13: Fly-Client-IP is ignored off Fly, so a caller cannot choose its own address bucket", async () => {
  await withServer({ MCP_RATE_LIMIT_PER_MINUTE_IP: "2" }, async ({ post }) => {
    const auth = { Authorization: `Bearer ${KEY_A}` };
    assert.equal((await post("/mcp", { ...auth, "Fly-Client-IP": "1.1.1.1" })).status, 200);
    assert.equal((await post("/mcp", { ...auth, "Fly-Client-IP": "2.2.2.2" })).status, 200);
    assert.equal((await post("/mcp", { ...auth, "Fly-Client-IP": "3.3.3.3" })).status, 429);
  });
});

test("F13: an IPv6 /64 is one client; IPv4 and v4-mapped addresses are not merged", async () => {
  assert.equal(addressBucket("2001:db8:1:2::1"), addressBucket("2001:0db8:0001:0002:ffff:0:0:9"));
  assert.notEqual(addressBucket("2001:db8:1:2::1"), addressBucket("2001:db8:1:3::1"));
  assert.equal(addressBucket("::ffff:203.0.113.5"), "203.0.113.5");
  assert.equal(addressBucket("203.0.113.5"), "203.0.113.5");
  await withServer({ MCP_RATE_LIMIT_PER_MINUTE_IP: "2", FLY_APP_NAME: "x" }, async ({ post }) => {
    const v6 = (ip) => ({ Authorization: `Bearer ${KEY_A}`, "Fly-Client-IP": ip });
    assert.equal((await post("/mcp", v6("2001:db8:1:2::1"))).status, 200);
    assert.equal((await post("/mcp", v6("2001:db8:1:2:aaaa::7"))).status, 200);
    assert.equal((await post("/mcp", v6("2001:db8:1:2:bbbb::8"))).status, 429);
  });
});

test("F13: env limits are positive integers via Number(), clamped; anything else falls back to the default", () => {
  assert.equal(limitFromEnv("1e3", 60), 1000);
  assert.equal(limitFromEnv("25", 60), 25);
  for (const bad of ["0", "-5", "abc", "1.5", "NaN", "Infinity", "", "  ", undefined]) assert.equal(limitFromEnv(bad, 60), 60, String(bad));
  assert.equal(limitFromEnv("1e12", 60), 100000, "an absurd value is clamped, not unlimited");
});

test("F13: the limiter refills over time; eviction only happens at the cap and never resets a live bucket below it", () => {
  let t = 0;
  const lim = createRateLimiter({ limit: 2, windowMs: 60_000, maxClients: 5, now: () => t });
  assert.equal(lim.take("a").ok, true);
  assert.equal(lim.take("a").ok, true);
  assert.equal(lim.take("a").ok, false);
  for (const k of ["b", "c", "d"]) lim.take(k); // 4 clients, below the cap of 5
  assert.equal(lim.take("a").ok, false, "a is still exhausted: nothing was evicted");
  t += 30_000; // half a window refills one token
  assert.equal(lim.take("a").ok, true);
  const small = createRateLimiter({ limit: 1, maxClients: 3, now: () => t });
  for (const k of ["b", "c", "d", "e", "f"]) small.take(k);
  assert.ok(small.size() <= 3);
});

test("F14: duplicate and empty Origin headers are refused", async () => {
  await withServer({ MCP_ALLOWED_ORIGINS: "https://app.example.com" }, async ({ post }) => {
    const auth = { Authorization: `Bearer ${KEY_A}` };
    assert.equal((await post("/mcp", { ...auth, Origin: ["https://app.example.com", "https://app.example.com"] })).status, 403);
    assert.equal((await post("/mcp", { ...auth, Origin: "" })).status, 403);
    assert.equal((await post("/mcp", { ...auth, Origin: "https://app.example.com" })).status, 200);
  });
});

test("GET / is neither throttled nor logged", async () => {
  await withServer({ MCP_RATE_LIMIT_PER_MINUTE_IP: "1" }, async ({ logs, port }) => {
    for (let i = 0; i < 5; i++) assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 200);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(logs.filter((l) => l.includes(" access ")).length, 0);
  });
});

test("F13: a request aborted before any response is logged as 499", async () => {
  await withServer({}, async ({ logs, port }) => {
    await new Promise((resolve) => {
      const req = http.request({ host: "127.0.0.1", port, path: "/mcp", method: "POST", headers: { ...MCP_HEADERS, Authorization: `Bearer ${KEY_A}`, "Content-Length": 500 } });
      req.on("error", () => {});
      req.write("{");
      setTimeout(() => { req.destroy(); resolve(); }, 50);
    });
    await new Promise((r) => setTimeout(r, 100));
    const lines = logs.filter((l) => l.includes(" access "));
    assert.equal(lines.length, 1);
    assert.match(lines[0], / POST \/mcp 499 \d+ms /);
  });
});

test("F13: one access-log line per request: method, path without query, status, duration, client; no key, no body", async () => {
  const secret = "repyh_secret_key_in_url_and_header";
  await withServer({}, async ({ post, logs }) => {
    await post(`/mcp?config=${encodeURIComponent(cfg({ NUVC_API_KEY: secret }))}&token=${secret}`, { Authorization: `Bearer ${secret}` }, JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list", params: { marker: "BODY_MARKER" } }));
    await new Promise((r) => setTimeout(r, 50));
    const lines = logs.filter((l) => l.includes(" access "));
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^\d{4}-\d\d-\d\dT[\d:.]+Z repyh-mcp access POST \/mcp 200 \d+ms 127\.0\.0\.1$/);
    for (const l of logs) assert.ok(!l.includes(secret) && !l.includes("config") && !l.includes("BODY_MARKER"), l);
  });
  const line = accessLogLine({ name: "repyh-mcp", req: { method: "POST", url: "/mcp?x=1\nforged" }, status: 401, ms: 3, client: "::1" });
  assert.ok(!line.includes("\n") && !line.includes("x=1"));
});
