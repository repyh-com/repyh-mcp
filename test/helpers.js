// Fake NUVC API (global fetch stub) that records every upstream call.
export const KEY_A = "nuvc_test_key_alice";
export const ALICE = "11111111-1111-4111-8111-111111111111";
export const BOB = "22222222-2222-4222-8222-222222222222";
export const ALICE_DECK = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const BOB_DECK = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

/** The exact tool list repyh-mcp advertises (sorted). Changing it is a contract change. */
export const FOUNDER_TOOL_NAMES = [
  "repyh_billing",
  "repyh_deck_matches",
  "repyh_deck_scores",
  "repyh_deck_status",
  "repyh_list_decks",
  "repyh_roast",
];

/** Install a fetch stub for https://api.nuvc.ai/*; other URLs go to real fetch. */
export function stubApi(respond) {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (!u.startsWith("https://api.nuvc.ai/")) return realFetch(url, init);
    const call = {
      method: init.method,
      path: u.replace("https://api.nuvc.ai/api", ""),
      key: (init.headers?.Authorization || "").replace(/^Bearer /, ""),
      userAgent: init.headers?.["User-Agent"],
      body: init.body ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const out = (await respond(call)) ?? {};
    return new Response(JSON.stringify(out.body ?? out), {
      status: out.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { calls, restore: () => (globalThis.fetch = realFetch) };
}

export const deckRow = (id, userId, extra = {}) => ({
  id, userId, title: "Acme", companyName: "Acme", analysisStatus: "scored", ...extra,
});

/** A well-behaved API for ALICE: her deck list, scores, status, matches. */
export function aliceApi(overrides = {}) {
  return stubApi((call) => {
    const o = overrides[call.path.split("?")[0]];
    if (o) return typeof o === "function" ? o(call) : o;
    if (call.path.startsWith("/v2/pitch-decks?")) {
      return { success: true, data: { pitchDecks: [deckRow(ALICE_DECK, ALICE)], total: 1, isAdmin: false } };
    }
    if (call.path === `/v2/pitch-decks/${ALICE_DECK}/scores`) {
      return { success: true, data: { deckId: ALICE_DECK, scored: true, overallScore: 7.4, categoryScores: { team: 8, problemMarket: 7 }, redFlags: ["No moat"], keyImprovements: [] } };
    }
    if (call.path === `/v2/pitch-decks/${ALICE_DECK}/status`) {
      return { success: true, data: { analysisStatus: "scored", progress: 100 } };
    }
    if (call.path === `/v2/pitch-decks/${ALICE_DECK}/matches`) {
      return { success: true, data: { investor_matches: [{ investorName: "Fund One", matchScore: 0.81 }], total_matches: 1 } };
    }
    if (call.path === "/v3/ai/analyze") return { success: true, data: { analysis: "Hard truth." } };
    return { status: 404, body: { detail: "nope" } };
  });
}
