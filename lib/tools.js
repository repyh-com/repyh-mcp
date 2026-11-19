import { readBilling } from "./billing.js";
/**
 * REPYH founder tools - shared by the stdio and HTTP transports.
 *
 * Key: REPYH_API_KEY (stdio) or the caller's own key per request (HTTP). Founder keys are
 * `repyh_...`; `nuvc_...` keys minted before audiences existed are accepted too.
 *
 * Founder audience only, own data only: every deck tool goes through the own-data guard
 * (lib/own-data.js). No investor tools - mandate, screening, fund economics live in nuvc-mcp.
 */

import { createRequire } from "node:module";
import { assertNoForeignIdentityArgs, createOwnDataGuard, OwnDataError, DECK_CAP, cleanText, withAnnotations, withUntrustedNotice } from "./own-data.js";

const { version } = createRequire(import.meta.url)("../package.json");

const API_ROOT = "https://api.nuvc.ai/api"; // one API host for both audiences; no REPYH-branded host is live yet
const TIMEOUT_MS = 30_000;

// Founder-facing copy. No verified REPYH key-page URL exists yet, so no link (founder keys cannot be minted
// yet either): keep the wording in this one constant.
export const KEY_HELP = "Create a founder API key in your REPYH account.";
const UPLOAD_URL = "https://app.repyh.com/upload";

// ---------------------------------------------------------------------------
// Response helpers (camelCase first, snake_case fallback - the platform camelCases most routes)
// ---------------------------------------------------------------------------

export function camel(key) {
  return typeof key === "string" ? key.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase()) : key;
}

export function field(obj, key) {
  if (obj === null || obj === undefined || typeof obj !== "object") return undefined;
  return obj[camel(key)] ?? obj[key];
}

/** Unwrap the `{success, data}` envelope. */
export function unwrap(res) {
  return res?.data ?? res;
}

const label = (key) =>
  String(key).replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

const score = (v) => (typeof v === "number" ? `${Math.round(v * 10) / 10}/10` : "n/a");

/**
 * An investor match score as a percentage. The route sends a 0 to 1 composite (persisted rows can reach about 1.4
 * with bonuses, shown as 100%); a value above 1.5 and up to 100 is already a percentage and is not multiplied again;
 * anything above 100 prints nothing.
 */
export function matchPercent(v) {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 100) return null;
  return `${Math.round(Math.min(100, v <= 1.5 ? v * 100 : v))}%`;
}

/** House confidence bands on a 0 to 1 value. */
function confidenceBand(c) {
  return c >= 0.8 ? "High" : c >= 0.5 ? "Medium" : c >= 0.2 ? "Low" : "Uncertain";
}

/**
 * The deck list's `confidenceScore` is the score's own `confidence_score_0_10` (a 0 to 10 value; absent when it was
 * not recorded). Shown as the house band on the 0 to 1 value, or nothing: a missing or out-of-range value never
 * prints a band.
 */
export function confidenceLine(raw) {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0 || raw > 10) return null;
  const c = Math.round(raw * 10) / 100; // the printed value, two decimals; the band is chosen from it
  return `Confidence: ${confidenceBand(c)} (${c.toFixed(2)})`;
}

/** A deck that will not complete, by its status word. */
const isFailed = (status) => /fail|error/i.test(String(status ?? ""));

// ---------------------------------------------------------------------------
// API helper
// ---------------------------------------------------------------------------

// nuvc_ is accepted until founder (repyh_) keys can be minted. Whole-key check, not prefix-only: a key with a
// newline or other control character must never reach fetch, whose error text would carry the whole
// `Bearer ...` header value into the transcript.
const KEY_RE = /^(repyh_|nuvc_)[A-Za-z0-9_]+$/;

export function isValidApiKey(key) {
  return typeof key === "string" && KEY_RE.test(key.trim());
}

/**
 * The key for the stdio transport: REPYH_API_KEY, else NUVC_API_KEY (deprecated fallback).
 * The HTTP transport never calls this - it takes the caller's key per request.
 */
export function envApiKey(env = process.env) {
  return env.REPYH_API_KEY || env.NUVC_API_KEY || undefined;
}

function resolveApiKey(source) {
  const raw = typeof source === "function" ? source() : source;
  if (!isValidApiKey(raw)) {
    throw new Error(`REPYH_API_KEY is not set or is invalid (a founder key starts with repyh_). ${KEY_HELP}`);
  }
  return raw.trim();
}

/** Text of an upstream value that may be a string or an object, never "[object Object]". */
function textOf(v) {
  if (v !== null && typeof v === "object") {
    try { return cleanText(JSON.stringify(v)); } catch { return ""; }
  }
  return cleanText(v);
}

const pickStr = (...vs) => vs.find((v) => typeof v === "string" && v.trim());

/**
 * One reading of an API error body, whichever shape it arrives in:
 *   plain       {detail: "..." | {code|error, message} | [{loc, msg}]}            (/api/v3/ai/*, not rewritten)
 *   wrapped     {success: false, error: {detail: ...} | {code, message} | "text", message: "Request failed"}
 *               (routes behind the response middleware rewrite a body with no `success` or `error` key this way,
 *               camelCasing the keys; the top-level message is a generic one and is ignored)
 * Returns { code, message, list, fields }: `code` (a machine code such as FORBIDDEN or QUOTA_EXCEEDED, else undefined),
 * `message` (clean text, else ""), `list` (a validation list as "field: message" strings, else []), `fields` (the
 * names in the validation entries' `loc` arrays, minus body/query/path and numeric indexes, else []; unvalidated,
 * see fieldNames). Tolerant of
 * camelCase and snake_case keys. The text is the API's: it is for reading, never for showing a founder as is.
 */
export function errorInfo(body) {
  const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  const none = { code: undefined, message: "", list: [], fields: [] };
  if (!isObj(body)) return none;
  // Descend through nested `error` objects (the middleware wraps, a route may wrap again) until one holds `detail`.
  let node = body;
  let hops = 0;
  while (node.detail == null && isObj(node.error) && hops < 3) {
    node = node.error;
    hops += 1;
  }
  const e = node.error;
  let d = node.detail;
  if (d === undefined || d === null) d = hops > 0 ? node : typeof e === "string" ? e : undefined;
  const obj = isObj(d) ? d : null;
  const fields = Array.isArray(d)
    ? d.flatMap((x) => (Array.isArray(x?.loc) ? x.loc : [])).filter((y) => typeof y === "string" && !LOC_SKIP.has(y) && !/^\d+$/.test(y))
    : [];
  const list = Array.isArray(d)
    ? d.map((x) => {
        const loc = Array.isArray(x?.loc) ? x.loc.filter((y) => y !== "body") : [];
        const name = loc.length ? cleanText(loc[loc.length - 1]) : "";
        const msg = typeof x?.msg === "string" ? cleanText(x.msg) : textOf(x);
        return name ? `${name}: ${msg}` : msg;
      })
    : [];
  const topMessage = typeof e === "string" && !/^request failed$/i.test(String(node.message).trim()) ? pickStr(node.message) : undefined;
  const code = pickStr(obj?.code, obj?.error, node.code, topMessage ? e : undefined);
  let message = "";
  if (topMessage) message = cleanText(topMessage);
  else if (typeof d === "string") message = cleanText(d);
  else if (obj) message = cleanText(pickStr(obj.message) ?? "");
  return { code, message, list, fields };
}

/**
 * The field names a validation error is about ("text"), never its prose. They come only from the entries' `loc`
 * arrays (`info.fields`), never from a display string. A name must look like a field (a letter, then letters, digits
 * or underscores, 24 characters at most), must not name NUVC, and, when the caller knows the tool's input properties
 * (`allowed`), must be one of them: hostile text cannot get through that. At most 5.
 */
const FIELD_NAME_RE = /^[a-z][a-z0-9_]{0,23}$/i;
const LOC_SKIP = new Set(["body", "query", "path"]);
function fieldNames(info, allowed) {
  const ok = (n) => FIELD_NAME_RE.test(n) && !/nuvc/i.test(n) && (!allowed || allowed.includes(n));
  return [...new Set(info.fields.filter(ok))].slice(0, 5);
}

/** A deck's own failure reason (the classifier's copy) is shown only when it does not name NUVC. Error responses never are. */
const founderSafe = (text) => (/nuvc/i.test(String(text ?? "")) ? "" : cleanText(text));

/**
 * Read a JSON body, giving up when the call's own timeout aborts. Awaited inside the timed section: a server that
 * sends headers and then stalls must not outlive the limit.
 */
function readJson(res, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(() => res.json()).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/**
 * `opts.timeoutMs` shortens the wait (tests). `opts.inputFields` is the calling tool's own input property names: a
 * 400 or 422 may name only those (omitted: any field-shaped name from the error's `loc`).
 */
export function createApiCall(keySource) {
  return async function apiCall(method, path, body, opts = {}) {
    const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${API_ROOT}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${resolveApiKey(keySource)}`,
          "Content-Type": "application/json",
          "User-Agent": `repyh-mcp/${version}`,
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      if (!res.ok) {
        const err = await readJson(res, controller.signal).catch((e) => (e?.name === "AbortError" ? Promise.reject(e) : {}));
        const info = errorInfo(err);
        const fail = (message) => Object.assign(new Error(message), { status: res.status });
        // Every sentence below is fixed founder copy. Backend prose is never shown, not even a filtered part of it;
        // a validation error (400, 422) shows only the names of the fields it is about.
        if (res.status === 401) {
          if (info.code === "KEY_EXPIRED" || /expired/i.test(info.message)) throw fail(`Your API key has expired. Keys expire (30 days by default); create a new one. ${KEY_HELP}`);
          throw fail(`Your API key was not accepted. Check REPYH_API_KEY. ${KEY_HELP}`);
        }
        if (res.status === 402) throw fail("This action needs access included in your plan. Use repyh_billing to check your allowance and tool costs (free read), then review your plan in your REPYH account. Founder credits do not unlock pitch feedback.");
        if (res.status === 403 && info.code === "FORBIDDEN") throw fail("This API key cannot do that here.");
        if (res.status === 403 || res.status === 404) throw Object.assign(new Error("Not found, or not one of your own decks."), { status: res.status });
        if (res.status === 429) {
          // A spent monthly quota carries its own code; waiting does not help there.
          if (info.code === "QUOTA_EXCEEDED") throw fail("Your monthly quota is used up. Use repyh_billing to check your reset date and allowance (free read). Founder credits do not extend pitch feedback quota; review your plan in your REPYH account.");
          throw fail("Too many requests. Wait a moment and try again.");
        }
        if (res.status >= 500) throw fail(`REPYH could not complete that just now (error ${res.status}). Try again shortly.`);
        if (res.status === 400 || res.status === 422) {
          const names = fieldNames(info, opts.inputFields);
          throw fail(names.length ? `Check your input: ${names.join(", ")}.` : "Check your input and try again.");
        }
        throw fail(`That request was not accepted (error ${res.status}).`);
      }
      return await readJson(res, controller.signal);
    } catch (err) {
      if (err.name === "AbortError") throw new Error(`Request timed out after ${timeoutMs / 1000}s`);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  };
}

// ---------------------------------------------------------------------------
// Tool definitions - the exact founder surface. Changing it is a contract change.
// ---------------------------------------------------------------------------

const DECK_ID = {
  type: "string",
  description: "UUID of one of YOUR decks (from repyh_list_decks). Other people's decks are rejected.",
};

// repyh_roast is a POST to a metered route (spends monthly quota), so it is not read-only. The other four
// are GETs on the caller's own decks and are unmetered (matches depend on your plan, but a GET records no usage).
const OWN_READ = { readOnlyHint: true, openWorldHint: false };
const TOOL_ANNOTATIONS = {
  repyh_billing: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  repyh_roast: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }, // POST /v3/ai/analyze, metered
  repyh_list_decks: OWN_READ, // GET /v2/pitch-decks
  repyh_deck_status: OWN_READ, // GET .../status
  repyh_deck_scores: OWN_READ, // GET .../scores
  repyh_deck_matches: { readOnlyHint: true, openWorldHint: true }, // GET .../matches; investor names from other parties
};

const TOOL_DEFS = [
  { name: "repyh_billing", description: 'Read your current credit balance, monthly quota, tool costs and available pack price. No purchase or charge. Example: "What will this cost?"', inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  {
    name: "repyh_roast",
    description: 'Blunt investor-style feedback on pitch text you paste. Example: "Roast this pitch: [paste]"',
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", minLength: 10, maxLength: 500000, description: "Startup idea or pitch to roast (10 to 500,000 characters)" } },
      required: ["text"],
    },
  },
  {
    name: "repyh_list_decks",
    description: 'Your decks and their status. Start here for a deck id. Example: "List my decks"',
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "repyh_deck_status",
    description: 'Is this deck still being read, scored, or failed? Example: "Has my latest deck finished scoring?"',
    inputSchema: { type: "object", properties: { deck_id: DECK_ID }, required: ["deck_id"] },
  },
  {
    name: "repyh_deck_scores",
    description: 'Scores out of 10, red flags and what to improve. Example: "What are the weakest scores on my latest deck?"',
    inputSchema: { type: "object", properties: { deck_id: DECK_ID }, required: ["deck_id"] },
  },
  {
    name: "repyh_deck_matches",
    description: 'Investors matched to this deck, where your plan includes them. Example: "Which investors matched my latest deck?"',
    inputSchema: { type: "object", properties: { deck_id: DECK_ID }, required: ["deck_id"] },
  },
];

export const TOOLS = withAnnotations(TOOL_DEFS, TOOL_ANNOTATIONS);

export function getTools() {
  return TOOLS;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleRoast({ apiCall }, { text }) {
  if (typeof text !== "string" || !text.trim()) throw new OwnDataError("text is required.");
  const res = await apiCall("POST", "/v3/ai/analyze", { text, analysis_type: "pitch_deck" });
  const data = unwrap(res);
  return `## Startup Roast\n\n${data.analysis || JSON.stringify(data, null, 2)}\n\nNext: choose one claim to strengthen with evidence before your next pitch. For an existing deck, use repyh_list_decks to find its scores.`;
}

async function handleListDecks({ guard }) {
  const rows = await guard.ownDecks({ refresh: true });
  if (!rows.length) return `You have no decks yet. Upload one at ${UPLOAD_URL}, then use repyh_list_decks to find it. If you only have pitch text, you can request repyh_roast instead (uses monthly quota).`;
  const cut = guard.truncated() ? `\n\nShowing your ${DECK_CAP.toLocaleString("en-US")} most recent decks.` : "";
  const lines = rows.map((d) => {
    const title = d.title || field(d, "company_name") || "Untitled";
    const status = field(d, "analysis_status") || d.status || "unknown";
    return `- ${title} - ${status} - deck_id: ${d.id}`;
  });
  return `## Your decks (${rows.length})\n\n${lines.join("\n")}\n\nNext: choose a deck_id above; use repyh_deck_status if it is processing, or repyh_deck_scores if it is scored.${cut}`;
}

async function handleStatus({ apiCall, guard }, { deck_id }) {
  const id = await guard.authoriseDeck(deck_id);
  const data = guard.assertOwnResponse(id, unwrap(await apiCall("GET", `/v2/pitch-decks/${id}/status`)));
  const status = field(data, "analysis_status") || data.status || "unknown";
  const progress = data.progress != null ? ` (${data.progress}%)` : "";
  // A failed deck says why when the route does (the reason is the deck classifier's own copy).
  const reason = isFailed(status) ? founderSafe(field(data, "error_message") ?? data.error) : "";
  const next = isFailed(status)
    ? `Review the file and upload it again at ${UPLOAD_URL}; processing will not finish for this failed upload.`
    : /^(scored|ready|completed|complete|analyzed|analysed)$/i.test(status)
      ? `Use repyh_deck_scores with deck_id: ${id} to review readiness and improvements.`
      : `Check repyh_deck_status with deck_id: ${id} later, when you want an update; do not poll continuously.`;
  return `## Deck status\n\n${status}${progress}${reason ? `. Reason: ${reason}` : ""}\n\nNext: ${next}`;
}

async function handleScores({ apiCall, guard }, { deck_id }) {
  const id = await guard.authoriseDeck(deck_id);
  const data = guard.assertOwnResponse(id, unwrap(await apiCall("GET", `/v2/pitch-decks/${id}/scores`)));
  if (field(data, "scored") === false) return `This deck has not been scored yet. Check repyh_deck_status with deck_id: ${id} later; do not poll continuously.`;
  const out = [`## Deck scores\n\nOverall: ${score(field(data, "overall_score"))}`];
  // The scores route has no confidence of its own; the deck list row (already read to check ownership) has one.
  const confidence = confidenceLine(field(guard.deckRow(id), "confidence_score"));
  if (confidence) out[0] += `\n${confidence}`;
  const cats = Object.entries(field(data, "category_scores") || {});
  if (cats.length) out.push("### By category\n" + cats.map(([k, v]) => `- ${label(k)}: ${score(v)}`).join("\n"));
  const readiness = field(data, "investment_readiness");
  if (readiness != null) out.push(`Investment readiness: ${typeof readiness === "object" ? JSON.stringify(readiness) : readiness}`);
  const list = (title, v) => Array.isArray(v) && v.length && out.push(`### ${title}\n` + v.map((x) => `- ${typeof x === "string" ? x : x?.title || x?.description || JSON.stringify(x)}`).join("\n"));
  list("Red flags", field(data, "red_flags"));
  list("Key improvements", field(data, "key_improvements"));
  out.push(`Next: choose the improvement with the strongest evidence gap. If you want to research potential investors, request repyh_deck_matches with deck_id: ${id}; availability depends on your plan. You decide whom to approach.`);
  // Red flags and improvements are derived from the deck's own text: mark the result as data.
  return withUntrustedNotice(out.join("\n\n"));
}

async function handleMatches({ apiCall, guard }, { deck_id }) {
  const id = await guard.authoriseDeck(deck_id);
  const res = await apiCall("GET", `/v2/pitch-decks/${id}/matches`);
  if (res?.success === false) {
    if (res.upgrade_required || res.upgradeRequired) return "Investor matches are not included in your plan. Upgrade in your REPYH account.";
    const row = (await guard.ownDecks({ refresh: true })) && guard.deckRow(id);
    if (isFailed(field(row, "analysis_status") ?? row?.status)) return `This deck failed to process, so it has no matches. Upload it again at ${UPLOAD_URL}.`;
    return `Matches are not available yet. The analysis may still be running; check repyh_deck_status with deck_id: ${id} later.`;
  }
  // The investor-match array is read from the top level of the response, and is the one array the guard exempts from
  // the owner check (identity, not name). Each row renders only its investor or firm name and its match score below.
  const raw = unwrap(res);
  const rows = field(raw, "investor_matches");
  guard.assertOwnResponse(id, raw, { matchRows: rows });
  const matches = Array.isArray(rows) ? rows : [];
  if (!matches.length) return `No investor matches yet for this deck. Check repyh_deck_status with deck_id: ${id} to confirm processing is complete. If it is complete, review the sector, stage and raise evidence with repyh_deck_scores using the same deck_id; matches are not guaranteed.`;
  const lines = matches.map((m) => {
    // a name is shown only when it is a string; an object or number there would print as "[object Object]"
    const given = field(m, "investor_name") || field(m, "firm_name") || field(m, "name");
    const name = (typeof given === "string" && cleanText(given)) || "Investor";
    const fit = matchPercent(field(m, "match_score") ?? field(m, "score"));
    return fit ? `- ${name} - ${fit} fit` : `- ${name}`;
  });
  return withUntrustedNotice(`## Investor matches (${matches.length})\n\n${lines.join("\n")}\n\nNext: research each investor’s current thesis and check size before deciding whom to approach. A match does not imply interest or an introduction.`);
}

/**
 * Build the handlers for ONE session/request. The credential and the own-data guard live in this
 * closure - never at module level - so concurrent HTTP callers cannot see each other's decks.
 */
export function createHandlers(apiKey) {
  const apiCall = createApiCall(apiKey);
  // The guard's own calls (the deck list) take no tool input, so a validation error from them names no field.
  const guard = createOwnDataGuard({ apiCall: (method, path, body, opts) => apiCall(method, path, body, { ...opts, inputFields: [] }), unwrap });
  const bind = (name, fn) => {
    const inputFields = Object.keys(TOOL_DEFS.find((t) => t.name === name).inputSchema.properties);
    const ctx = { guard, apiCall: (method, path, body, opts) => apiCall(method, path, body, { ...opts, inputFields }) };
    return async (args) => {
      assertNoForeignIdentityArgs(args);
      return fn(ctx, args || {});
    };
  };
  return {
    repyh_billing: async (args = {}) => {
      assertNoForeignIdentityArgs(args);
      return readBilling(apiCall, "/v3/ai/billing", new Set(TOOLS.map((t) => t.name)));
    },
    repyh_roast: bind("repyh_roast", handleRoast),
    repyh_list_decks: bind("repyh_list_decks", handleListDecks),
    repyh_deck_status: bind("repyh_deck_status", handleStatus),
    repyh_deck_scores: bind("repyh_deck_scores", handleScores),
    repyh_deck_matches: bind("repyh_deck_matches", handleMatches),
  };
}
