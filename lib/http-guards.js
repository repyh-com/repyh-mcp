// HTTP transport guards shared in shape by nuvc-mcp and repyh-mcp: Origin allow-list, per-client
// token bucket, client-address resolution and the access-log line. No dependencies.

import { createHash } from "node:crypto";

const DEFAULT_KEY_LIMIT_PER_MINUTE = 60;
const DEFAULT_IP_LIMIT_PER_MINUTE = 600;
const MAX_LIMIT_PER_MINUTE = 100_000; // an absurd value must not disable the limit
const MAX_TRACKED_CLIENTS = 10_000;

/** A positive integer (`Number()`, so `1e3` is 1000), clamped to a ceiling; anything else -> the default. */
export function limitFromEnv(raw, fallback) {
  if (raw === undefined || String(raw).trim() === "") return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? Math.min(n, MAX_LIMIT_PER_MINUTE) : fallback;
}

/**
 * Origin validation (MCP Streamable HTTP: servers must check Origin to stop DNS-rebinding).
 * Non-browser MCP clients send no Origin, so a request without one is unchanged. A request WITH an
 * Origin is refused unless it exactly matches an entry of MCP_ALLOWED_ORIGINS (comma-separated).
 */
export function originRefused(req, env = process.env) {
  const origin = req.headers["origin"]; // Node joins a duplicated header with ", ", which never matches an entry
  if (origin === undefined) return false;
  const allowed = String(env.MCP_ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return !allowed.includes(String(origin));
}

/**
 * The caller's address. On Fly the proxy sets Fly-Client-IP (and overwrites a caller-supplied one);
 * it is only trusted when running on Fly (FLY_APP_NAME is set there), otherwise a caller could pick
 * its own bucket. Falls back to the socket address. Output is restricted to address characters so
 * it is safe to write to a log line.
 */
export function clientAddress(req, env = process.env) {
  const fly = req.headers["fly-client-ip"];
  const raw = env.FLY_APP_NAME && typeof fly === "string" && fly.trim() ? fly.trim() : req.socket?.remoteAddress || "unknown";
  return raw.replace(/[^0-9a-zA-Z:.]/g, "").slice(0, 45) || "unknown";
}

/** IPv6 addresses are bucketed by /64 (one customer's whole prefix is one client); IPv4 and v4-mapped as-is. */
export function addressBucket(address) {
  const a = String(address).replace(/^::ffff:/i, "");
  if (!a.includes(":")) return a;
  const [head, tail] = a.split("::");
  const h = head ? head.split(":") : [];
  const t = tail === undefined ? [] : tail ? tail.split(":") : [];
  const groups = tail === undefined ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
  return groups.slice(0, 4).map((g) => g.toLowerCase().replace(/^0+(?=.)/, "")).join(":") + "::/64";
}

/** The per-key bucket id: a SHA-256 of the key, so the key itself is never held in the limiter or a log. */
export function keyBucket(apiKey) {
  return createHash("sha256").update(String(apiKey)).digest("hex");
}

/**
 * In-process token bucket per client. Capacity = limit per window, refilled continuously. The map is
 * bounded: when full, the least-recently-seen client is evicted (its next request starts a fresh
 * bucket, which is the safe direction for a memory bound).
 * @returns {{ take(key: string): { ok: true } | { ok: false, retryAfterSeconds: number } }}
 */
export function createRateLimiter({ limit, windowMs = 60_000, maxClients = MAX_TRACKED_CLIENTS, now = Date.now }) {
  const buckets = new Map(); // key -> { tokens, last }; insertion order = least recently seen first
  const perMs = limit / windowMs;
  return {
    take(key) {
      const t = now();
      let b = buckets.get(key);
      if (b) {
        buckets.delete(key);
        b.tokens = Math.min(limit, b.tokens + (t - b.last) * perMs);
        b.last = t;
      } else {
        b = { tokens: limit, last: t };
        while (buckets.size >= maxClients) buckets.delete(buckets.keys().next().value);
      }
      buckets.set(key, b);
      if (b.tokens >= 1) {
        b.tokens -= 1;
        return { ok: true };
      }
      return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((1 - b.tokens) / perMs / 1000)) };
    },
    size: () => buckets.size,
  };
}

/**
 * Two tiers: a generous per-address cap on every /mcp request (shared egress addresses such as a hosted
 * connector or a corporate NAT carry many users), and a tighter per-key cap once the key shape is valid.
 */
export function createLimiters(env = process.env) {
  return {
    ip: createRateLimiter({ limit: limitFromEnv(env.MCP_RATE_LIMIT_PER_MINUTE_IP, DEFAULT_IP_LIMIT_PER_MINUTE) }),
    key: createRateLimiter({ limit: limitFromEnv(env.MCP_RATE_LIMIT_PER_MINUTE, DEFAULT_KEY_LIMIT_PER_MINUTE) }),
  };
}

/** One access-log line: timestamp, method, path (no query string), status, duration, client. Never a key or body. */
export function accessLogLine({ name, req, status, ms, client }) {
  const path = String(req.url || "/").split("?")[0].replace(/[^\x21-\x7e]/g, "?").slice(0, 200);
  const method = String(req.method || "-").replace(/[^A-Z]/gi, "").slice(0, 10) || "-";
  return `${new Date().toISOString()} ${name} access ${method} ${path} ${status} ${ms}ms ${client}`;
}
