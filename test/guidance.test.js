import { test } from "node:test";
import assert from "node:assert/strict";
import { createHandlers } from "../lib/tools.js";
import { aliceApi, KEY_A, ALICE_DECK } from "./helpers.js";

for (const [status, expected] of [
  ["processing", /repyh_deck_status.*later.*do not poll/],
  ["scored", /repyh_deck_scores/],
  ["ready", /repyh_deck_scores/],
  ["failed", /Review the file.*upload it again/],
]) {
  for (const statusKey of ["status", "analysisStatus", "analysis_status"]) {
    test(`${status} deck (${statusKey}) gives one useful next action without a follow-on call`, async () => {
      const api = aliceApi({ [`/v2/pitch-decks/${ALICE_DECK}/status`]: { data: { [statusKey]: status } } });
      try {
        const out = await createHandlers(KEY_A).repyh_deck_status({ deck_id: ALICE_DECK });
        assert.match(out, expected);
        assert.equal(api.calls.length, 2); // ownership list + requested status only
        if (status !== "failed") assert.match(out, new RegExp(ALICE_DECK));
      } finally { api.restore(); }
    });
  }
}

test("no decks offers upload or requested text feedback without analysing anything", async () => {
  const api = aliceApi({ "/v2/pitch-decks": { data: { pitchDecks: [] } } });
  try {
    const out = await createHandlers(KEY_A).repyh_list_decks({});
    assert.match(out, /upload.*repyh_list_decks/i);
    assert.match(out, /repyh_roast.*monthly quota/);
    assert.equal(api.calls.length, 1);
  } finally { api.restore(); }
});

test("empty matches explain how to review evidence without promising matches or retrying", async () => {
  const api = aliceApi({ [`/v2/pitch-decks/${ALICE_DECK}/matches`]: { data: { investorMatches: [] } } });
  try {
    const out = await createHandlers(KEY_A).repyh_deck_matches({ deck_id: ALICE_DECK });
    assert.match(out, /repyh_deck_status/);
    assert.match(out, /repyh_deck_scores/);
    assert.match(out, /matches are not guaranteed/);
    assert.match(out, new RegExp(ALICE_DECK));
    assert.equal(api.calls.length, 2);
  } finally { api.restore(); }
});

test("scores and matches offer a human next action without extra reads or analysis", async () => {
  const api = aliceApi();
  try {
    const h = createHandlers(KEY_A);
    assert.match(await h.repyh_deck_scores({ deck_id: ALICE_DECK }), /Next:.*repyh_deck_matches/);
    assert.match(await h.repyh_deck_matches({ deck_id: ALICE_DECK }), /Next: research.*does not imply/);
    assert.equal(api.calls.length, 3);
    assert.ok(api.calls.every((c) => c.method === "GET"));
  } finally { api.restore(); }
});
