// Own-data guard: a founder key only ever sees its own decks. Mocked HTTP throughout.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHandlers } from "../lib/tools.js";
import { KEY_A, ALICE, BOB, ALICE_DECK, BOB_DECK, aliceApi, deckRow } from "./helpers.js";

const FOREIGN_REJECTED = /not one of your own decks/;

test("own deck -> OK (scores render on the 0-10 scale)", async () => {
  const api = aliceApi();
  try {
    const out = await createHandlers(KEY_A).repyh_deck_scores({ deck_id: ALICE_DECK });
    assert.match(out, /Overall: 7\.4\/10/);
    assert.match(out, /Team: 8\/10/);
    assert.match(out, /No moat/);
    assert.ok(api.calls.every((c) => c.key === KEY_A));
  } finally { api.restore(); }
});

test("foreign deck id -> rejected client-side, the deck endpoint is never called", async () => {
  const api = aliceApi();
  try {
    const h = createHandlers(KEY_A);
    for (const tool of ["repyh_deck_scores", "repyh_deck_status", "repyh_deck_matches"]) {
      await assert.rejects(() => h[tool]({ deck_id: BOB_DECK }), FOREIGN_REJECTED);
    }
    assert.ok(!api.calls.some((c) => c.path.includes(BOB_DECK)), "no request may mention the foreign deck");
  } finally { api.restore(); }
});

test("non-UUID / path-traversal deck ids are rejected before any call", async () => {
  const api = aliceApi();
  try {
    const h = createHandlers(KEY_A);
    for (const bad of ["../../v3/api-keys", "123", "", undefined, `${ALICE_DECK}/../x`]) {
      await assert.rejects(() => h.repyh_deck_scores({ deck_id: bad }), /UUID/);
    }
    assert.equal(api.calls.length, 0);
  } finally { api.restore(); }
});

test("arguments naming another user/owner/investor are rejected", async () => {
  const api = aliceApi();
  try {
    const h = createHandlers(KEY_A);
    for (const args of [{ user_id: BOB }, { userId: BOB }, { owner_id: BOB }, { investor_id: BOB }, { deck_id: ALICE_DECK, user_id: BOB }]) {
      await assert.rejects(() => h.repyh_deck_scores(args), /only returns data for the account that owns your API key/);
    }
    await assert.rejects(() => h.repyh_roast({ text: "x", userId: BOB }), /not accepted/);
    assert.equal(api.calls.length, 0);
  } finally { api.restore(); }
});

test("response owned by a different user -> rejected, nothing rendered", async () => {
  const api = aliceApi({
    [`/v2/pitch-decks/${ALICE_DECK}/scores`]: { success: true, data: { deckId: ALICE_DECK, scored: true, overallScore: 9, userId: BOB } },
    [`/v2/pitch-decks/${ALICE_DECK}/matches`]: { success: true, data: { ownerId: BOB, investor_matches: [{ investorName: "X", matchScore: 0.5 }] } },
  });
  try {
    const h = createHandlers(KEY_A);
    await assert.rejects(() => h.repyh_deck_scores({ deck_id: ALICE_DECK }), /does not belong to your account/);
    await assert.rejects(() => h.repyh_deck_matches({ deck_id: ALICE_DECK }), /does not belong to your account/);
  } finally { api.restore(); }
});

test("an owner field on an object that carries the requested deck id is still refused, at any depth", async () => {
  const api = aliceApi({
    [`/v2/pitch-decks/${ALICE_DECK}/scores`]: { success: true, data: { scored: true, overallScore: 9, deck: { id: ALICE_DECK, createdBy: BOB } } },
  });
  try {
    await assert.rejects(() => createHandlers(KEY_A).repyh_deck_scores({ deck_id: ALICE_DECK }), /does not belong to your account/);
  } finally { api.restore(); }
});

// --- the strict scan (review): every owner field everywhere, except inside the investor-match rows ---------------

const OTHER_DECK = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

test("the two reviewer scenarios are refused: another founder's rows inside the scores, and inside the matches", async () => {
  const api = aliceApi({
    [`/v2/pitch-decks/${ALICE_DECK}/scores`]: { success: true, data: { scored: true, overallScore: 7, redFlags: [{ deckId: OTHER_DECK, userId: BOB, title: "Other founder's red flag" }], investmentReadiness: { deck: { userId: BOB } } } },
    [`/v2/pitch-decks/${ALICE_DECK}/matches`]: { success: true, data: { investorMatches: [{ deckId: OTHER_DECK, userId: BOB, investorName: "Foreign Match", matchScore: 0.9 }] } },
  });
  try {
    const h = createHandlers(KEY_A);
    await assert.rejects(() => h.repyh_deck_scores({ deck_id: ALICE_DECK }), /different deck|does not belong/);
    await assert.rejects(() => h.repyh_deck_matches({ deck_id: ALICE_DECK }), /different deck/);
  } finally { api.restore(); }
});

test("an owner field deep in the response is refused whatever the depth, and a cycle does not hang the scan", async () => {
  let deep = { userId: BOB };
  for (let i = 0; i < 40; i++) deep = { wrapper: deep };
  const api = aliceApi({ [`/v2/pitch-decks/${ALICE_DECK}/scores`]: { success: true, data: { scored: true, overallScore: 7, extra: deep } } });
  try {
    await assert.rejects(() => createHandlers(KEY_A).repyh_deck_scores({ deck_id: ALICE_DECK }), /does not belong to your account/);
  } finally { api.restore(); }
  // the guard itself, with a cyclic object and a 10-deep owner
  const { createOwnDataGuard } = await import("../lib/own-data.js");
  const guard = createOwnDataGuard({ apiCall: async () => ({ data: { pitchDecks: [deckRow(ALICE_DECK, ALICE)] } }), unwrap: (r) => r.data });
  await guard.authoriseDeck(ALICE_DECK);
  const cyc = { a: {} };
  cyc.a.back = cyc;
  assert.equal(guard.assertOwnResponse(ALICE_DECK, cyc), cyc);
  let ten = { ownerId: BOB };
  for (let i = 0; i < 10; i++) ten = { n: [ten] };
  assert.throws(() => guard.assertOwnResponse(ALICE_DECK, ten), /does not belong/);
});

test("a match row with another party's id and no deck id renders; a match row naming another deck, or an object deck, does not", async () => {
  const rows = (investorMatches) => ({ success: true, data: { investorMatches } });
  const ok = aliceApi({ [`/v2/pitch-decks/${ALICE_DECK}/matches`]: rows([{ investorName: "Fund One", matchScore: 0.82, userId: BOB, createdBy: BOB, nested: { ownerId: BOB } }]) });
  try {
    assert.match(await createHandlers(KEY_A).repyh_deck_matches({ deck_id: ALICE_DECK }), /Fund One - 82% fit/);
  } finally { ok.restore(); }
  for (const row of [{ investorName: "X", pitchDeckId: OTHER_DECK }, { investorName: "X", deck_id: OTHER_DECK }, { investorName: "X", nested: { deckId: OTHER_DECK } }]) {
    const api = aliceApi({ [`/v2/pitch-decks/${ALICE_DECK}/matches`]: rows([row]) });
    try {
      await assert.rejects(() => createHandlers(KEY_A).repyh_deck_matches({ deck_id: ALICE_DECK }), /different deck/);
    } finally { api.restore(); }
  }
});

test("ids are compared trimmed and case-insensitively, and an `id` cannot mask a deck field", async () => {
  const api = aliceApi({
    [`/v2/pitch-decks/${ALICE_DECK}/scores`]: { success: true, data: { scored: true, overallScore: 7, deckId: `  ${ALICE_DECK.toUpperCase()} `, userId: ` ${ALICE.toUpperCase()}\n` } },
    [`/v2/pitch-decks/${ALICE_DECK}/status`]: { success: true, data: { analysisStatus: "scored", id: ALICE_DECK, deckId: OTHER_DECK } },
  });
  try {
    const h = createHandlers(KEY_A);
    assert.match(await h.repyh_deck_scores({ deck_id: ALICE_DECK }), /Overall: 7\/10/);
    await assert.rejects(() => h.repyh_deck_status({ deck_id: ALICE_DECK }), /different deck/);
  } finally { api.restore(); }
});

test("a nested row that describes another party (an investor match) is not refused for its own ids", async () => {
  const api = aliceApi({
    [`/v2/pitch-decks/${ALICE_DECK}/matches`]: {
      success: true,
      data: { investor_matches: [{ investorName: "Fund One", matchScore: 0.82, userId: BOB, ownerId: BOB, createdBy: BOB }], total_matches: 1 },
    },
  });
  try {
    const out = await createHandlers(KEY_A).repyh_deck_matches({ deck_id: ALICE_DECK });
    assert.match(out, /Fund One - 82% fit/);
  } finally { api.restore(); }
});

// --- the deck list is read up to a cap; past it, say so rather than assert the deck is not yours -------------

const manyDecks = (n, offset) => Array.from({ length: n }, (_, i) => deckRow(`00000000-0000-4000-8000-${String(offset + i).padStart(12, "0")}`, ALICE));

function bigListApi(total) {
  return aliceApi({
    "/v2/pitch-decks": (call) => {
      const offset = Number(new URL(`http://x${call.path}`).searchParams.get("offset"));
      const limit = Number(new URL(`http://x${call.path}`).searchParams.get("limit"));
      const rows = manyDecks(Math.max(0, Math.min(limit, total - offset)), offset);
      // like the real route: `total` is the row count of THIS page, not of the founder's decks
      return { success: true, data: { pitchDecks: rows, total: rows.length, limit, offset, isAdmin: false } };
    },
  });
}

test("a list cut at 2,000 decks says so, and an unknown deck is 'could not confirm', not 'not yours'", async () => {
  const api = bigListApi(2500);
  try {
    const h = createHandlers(KEY_A);
    const out = await h.repyh_list_decks({});
    assert.match(out, /## Your decks \(2000\)/);
    assert.match(out, /Showing your 2,000 most recent decks\.$/);
    await assert.rejects(
      () => h.repyh_deck_status({ deck_id: BOB_DECK }),
      (e) => /Could not confirm that deck is one of yours: only your 2,000 most recent decks can be checked\./.test(e.message) && !/not one of your own/.test(e.message),
    );
    assert.equal(api.calls.filter((c) => c.path.startsWith("/v2/pitch-decks?")).length >= 10, true);
  } finally { api.restore(); }
});

test("2,001 decks is cut by one", async () => {
  const api = bigListApi(2001);
  try {
    const h = createHandlers(KEY_A);
    assert.match(await h.repyh_list_decks({}), /Showing your 2,000 most recent decks\.$/);
    await assert.rejects(() => h.repyh_deck_status({ deck_id: BOB_DECK }), /Could not confirm/);
    assert.ok(api.calls.some((c) => c.path === "/v2/pitch-decks?limit=1&offset=2000"), "one probe past the cap");
  } finally { api.restore(); }
});

test("a list of exactly 2,000 (a probe past the cap finds nothing) is not called cut, and the refusal stays the plain one", async () => {
  const api = bigListApi(2000);
  try {
    const h = createHandlers(KEY_A);
    assert.doesNotMatch(await h.repyh_list_decks({}), /Showing your/);
    await assert.rejects(() => h.repyh_deck_status({ deck_id: BOB_DECK }), /That deck is not one of your own decks\./);
  } finally { api.restore(); }
});

test("response naming a different deck than requested -> rejected", async () => {
  const api = aliceApi({
    [`/v2/pitch-decks/${ALICE_DECK}/scores`]: { success: true, data: { deckId: BOB_DECK, scored: true, overallScore: 9 } },
  });
  try {
    await assert.rejects(() => createHandlers(KEY_A).repyh_deck_scores({ deck_id: ALICE_DECK }), /different deck/);
  } finally { api.restore(); }
});

test("deck list that spans accounts, or is an admin list, is refused", async () => {
  let api = aliceApi({
    "/v2/pitch-decks": { success: true, data: { pitchDecks: [deckRow(ALICE_DECK, ALICE), deckRow(BOB_DECK, BOB)] } },
  });
  try {
    await assert.rejects(() => createHandlers(KEY_A).repyh_list_decks({}), /more than one account/);
  } finally { api.restore(); }
  api = aliceApi({
    "/v2/pitch-decks": { success: true, data: { pitchDecks: [deckRow(ALICE_DECK, ALICE)], isAdmin: true } },
  });
  try {
    await assert.rejects(() => createHandlers(KEY_A).repyh_deck_scores({ deck_id: ALICE_DECK }), /Admin keys/);
  } finally { api.restore(); }
});

test("a deck uploaded after the first read is found by one list refresh", async () => {
  const NEW = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  let listed = 0;
  const api = aliceApi({
    "/v2/pitch-decks": () => ({ success: true, data: { pitchDecks: listed++ ? [deckRow(ALICE_DECK, ALICE), deckRow(NEW, ALICE)] : [deckRow(ALICE_DECK, ALICE)] } }),
    [`/v2/pitch-decks/${NEW}/status`]: { success: true, data: { analysisStatus: "queued", progress: 5 } },
  });
  try {
    const h = createHandlers(KEY_A);
    await h.repyh_list_decks({});
    assert.match(await h.repyh_deck_status({ deck_id: NEW }), /queued \(5%\)/);
  } finally { api.restore(); }
});

test("guard state is per handler set: another caller's decks are never shared", async () => {
  const api = aliceApi();
  try {
    const a = createHandlers(KEY_A);
    await a.repyh_deck_scores({ deck_id: ALICE_DECK });
    // a second session with a fresh guard re-reads ITS OWN list (here the fake still answers as alice,
    // but the point is that no module-level cache carries over)
    const before = api.calls.length;
    await createHandlers(KEY_A).repyh_deck_scores({ deck_id: ALICE_DECK });
    assert.ok(api.calls.slice(before).some((c) => c.path.startsWith("/v2/pitch-decks?")));
  } finally { api.restore(); }
});

// --- review round 2 (#6763): the exemption is the one match array; more owner and deck names ------------------------

const scoresWith = (extra) => ({ [`/v2/pitch-decks/${ALICE_DECK}/scores`]: { success: true, data: { scored: true, overallScore: 7, ...extra } } });
const matchesWith = (data) => ({ [`/v2/pitch-decks/${ALICE_DECK}/matches`]: { success: true, data } });
const NOT_YOURS = /does not belong to your account|different deck/;

async function scoresOutcome(extra) {
  const api = aliceApi(scoresWith(extra));
  try {
    return await createHandlers(KEY_A).repyh_deck_scores({ deck_id: ALICE_DECK }).then((out) => ({ out }), (error) => ({ error }));
  } finally { api.restore(); }
}

test("N2: a match-array key nested anywhere but the top of the matches response takes no exemption", async () => {
  const bodies = [
    { investmentReadiness: { investor_matches: [{ userId: BOB, title: "Other founder's data" }] } },
    { redFlags: [{ title: "Other founder flag", investorMatches: [{ ownerId: BOB }] }] },
  ];
  for (const body of bodies) {
    const r = await scoresOutcome(body);
    assert.match(r.error?.message ?? r.out, /does not belong to your account/);
    // the same wrapper on a status response, and on a matches response next to the real top-level array
    const status = aliceApi({ [`/v2/pitch-decks/${ALICE_DECK}/status`]: { success: true, data: { analysisStatus: "scored", ...body } } });
    try {
      await assert.rejects(() => createHandlers(KEY_A).repyh_deck_status({ deck_id: ALICE_DECK }), /does not belong to your account/);
    } finally { status.restore(); }
    const real = [{ investorName: "Fund One", matchScore: 0.8, userId: BOB }];
    const matches = aliceApi(matchesWith({ investorMatches: real, ...body }));
    try {
      await assert.rejects(() => createHandlers(KEY_A).repyh_deck_matches({ deck_id: ALICE_DECK }), /does not belong to your account/);
    } finally { matches.restore(); }
  }
  // the real top-level array alone still renders; a second copy of the key under the other casing does not
  const real = [{ investorName: "Fund One", matchScore: 0.8, userId: BOB }];
  const ok = aliceApi(matchesWith({ investorMatches: real }));
  try {
    assert.match(await createHandlers(KEY_A).repyh_deck_matches({ deck_id: ALICE_DECK }), /Fund One - 80% fit/);
  } finally { ok.restore(); }
  const twin = aliceApi(matchesWith({ investorMatches: real, investor_matches: [{ investorName: "Hidden", userId: BOB }] }));
  try {
    await assert.rejects(() => createHandlers(KEY_A).repyh_deck_matches({ deck_id: ALICE_DECK }), /does not belong to your account/);
  } finally { twin.restore(); }
});

const OWNER_NAMES = ["userId", "user_id", "ownerId", "owner_user_id", "ownerUserId", "createdBy", "created_by", "createdById", "created_by_id", "founderId", "founder_id", "accountId", "account_id", "customerId", "memberId", "USERID"];

test("every owner field name is refused when it names another party and passes for the caller, nested and at depth", async () => {
  for (const name of OWNER_NAMES) {
    const wrap = (value) => [
      { redFlags: [{ title: "Flag text", [name]: value }] },
      { extra: { a: [{ b: { c: [{ [name]: value }] } }] } },
    ];
    for (const body of wrap(BOB)) assert.match((await scoresOutcome(body)).error?.message ?? "passed", /does not belong to your account/, `${name} -> BOB`);
    for (const body of wrap(ALICE)) assert.match((await scoresOutcome(body)).out ?? "", /Overall: 7\/10/, `${name} -> ALICE`);
  }
});

test("owner objects (user, owner, founder, account, createdBy) with an id or userId are checked; `id` alone is not an owner field", async () => {
  for (const name of ["user", "owner", "founder", "account", "createdBy", "created_by"]) {
    for (const idKey of ["id", "userId"]) {
      const flag = (who) => ({ redFlags: [{ title: "Flag text", [name]: { [idKey]: who, name: "N" } }] });
      assert.match((await scoresOutcome(flag(BOB))).error?.message ?? "passed", /does not belong to your account/, `${name}.${idKey} -> BOB`);
      assert.match((await scoresOutcome(flag(ALICE))).out ?? "", /Overall: 7\/10/, `${name}.${idKey} -> ALICE`);
      const deep = { a: [{ b: { [name]: { [idKey]: BOB } } }] };
      assert.match((await scoresOutcome(deep)).error?.message ?? "passed", /does not belong to your account/, `${name}.${idKey} deep`);
    }
  }
  // a plain `id` is a row's own id, not an owner; an owner object with no id says nothing about an owner
  assert.match((await scoresOutcome({ redFlags: [{ title: "T", id: BOB }] })).out ?? "", /Overall/);
  assert.match((await scoresOutcome({ redFlags: [{ title: "T", user: { name: "No id" } }] })).out ?? "", /Overall/);
});

test("deck objects (deck, pitchDeck, pitch_deck) with an id are checked against the requested deck, and deck id fields in every spelling", async () => {
  for (const name of ["deck", "pitchDeck", "pitch_deck"]) {
    assert.match((await scoresOutcome({ redFlags: [{ title: "T", [name]: { id: OTHER_DECK } }] })).error?.message ?? "passed", /different deck/, name);
    assert.match((await scoresOutcome({ a: { b: [{ [name]: { id: OTHER_DECK } }] } })).error?.message ?? "passed", /different deck/, `${name} deep`);
    assert.match((await scoresOutcome({ redFlags: [{ title: "T", [name]: { id: ALICE_DECK.toUpperCase() } }] })).out ?? "", /Overall/, `${name} -> requested deck`);
  }
  for (const name of ["deck_id", "deckId", "pitch_deck_id", "pitchDeckId"]) {
    assert.match((await scoresOutcome({ redFlags: [{ title: "T", [name]: OTHER_DECK }] })).error?.message ?? "passed", /different deck/, name);
    assert.match((await scoresOutcome({ redFlags: [{ title: "T", [name]: ALICE_DECK }] })).out ?? "", /Overall/, `${name} -> requested deck`);
  }
});

test("the legitimate matches response renders: other parties' ids and createdBy, no deck reference or the requested deck", async () => {
  const api = aliceApi(matchesWith({
    investor_matches: [
      { investorName: "Fund One", matchScore: 0.82, investorId: BOB, userId: BOB, createdBy: BOB, account: { id: BOB }, owner: { userId: BOB } },
      { firmName: "Fund Two", score: 0.6, deckId: ALICE_DECK, deck: { id: ALICE_DECK }, pitch_deck_id: ALICE_DECK },
      { name: "Fund Three", matchScore: 0.5, createdBy: { id: BOB, name: "Someone" } },
    ],
    total_matches: 3,
  }));
  try {
    const out = await createHandlers(KEY_A).repyh_deck_matches({ deck_id: ALICE_DECK });
    assert.match(out, /Fund One - 82% fit/);
    assert.match(out, /Fund Two - 60% fit/);
    assert.match(out, /Fund Three - 50% fit/);
  } finally { api.restore(); }
});

test("a match row names ONLY its investor or firm name and score; no other field of the row reaches the output", async () => {
  const api = aliceApi(matchesWith({
    investorMatches: [{ name: "Bob the other founder", matchScore: 0.5, userId: BOB, reasoning: "SECRET-REASON", notes: "SECRET-NOTE", description: "SECRET-DESC", investorSnapshot: { x: "SECRET-SNAP" } }],
  }));
  try {
    const out = await createHandlers(KEY_A).repyh_deck_matches({ deck_id: ALICE_DECK });
    // accepted by design: an investor's name cannot be told from a founder's, so the exempt row's name prints
    assert.match(out, /- Bob the other founder - 50% fit/);
    assert.doesNotMatch(out, /SECRET|22222222/);
    assert.equal(out.split("\n").filter((l) => l.startsWith("- ")).length, 1);
  } finally { api.restore(); }
});

test("a match row naming another deck is refused in every form, including a deck object", async () => {
  const forms = [{ deckId: OTHER_DECK }, { deck_id: OTHER_DECK }, { pitchDeckId: OTHER_DECK }, { pitch_deck_id: OTHER_DECK }, { deck: { id: OTHER_DECK } }, { pitchDeck: { id: OTHER_DECK } }, { pitch_deck: { id: OTHER_DECK } }, { nested: { deck: { id: OTHER_DECK } } }];
  for (const form of forms) {
    const api = aliceApi(matchesWith({ investorMatches: [{ investorName: "X", matchScore: 0.5, userId: BOB, ...form }] }));
    try {
      await assert.rejects(() => createHandlers(KEY_A).repyh_deck_matches({ deck_id: ALICE_DECK }), /different deck/, JSON.stringify(form));
    } finally { api.restore(); }
  }
});

test("the list handler renders a multi-deck list for one owner (its own single-owner check) and refuses two owners", async () => {
  const D2 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  let api = aliceApi({ "/v2/pitch-decks": { success: true, data: { pitchDecks: [deckRow(ALICE_DECK, ALICE, { previousDeckId: D2 }), deckRow(D2, ALICE, { title: "Older" })], isAdmin: false } } });
  try {
    const out = await createHandlers(KEY_A).repyh_list_decks({});
    assert.match(out, /## Your decks \(2\)/);
    assert.match(out, new RegExp(`Older - scored - deck_id: ${D2}`));
  } finally { api.restore(); }
  api = aliceApi({ "/v2/pitch-decks": { success: true, data: { pitchDecks: [deckRow(ALICE_DECK, ALICE), deckRow(D2, BOB)] } } });
  try {
    await assert.rejects(() => createHandlers(KEY_A).repyh_list_decks({}), /more than one account/);
  } finally { api.restore(); }
});

test("the scan fails closed: only OwnDataError leaves it, for a throwing getter, a cycle or a very deep body", async () => {
  const { createOwnDataGuard, OwnDataError } = await import("../lib/own-data.js");
  const guard = createOwnDataGuard({ apiCall: async () => ({ data: { pitchDecks: [deckRow(ALICE_DECK, ALICE)] } }), unwrap: (r) => r.data });
  await guard.authoriseDeck(ALICE_DECK);
  const boom = {};
  Object.defineProperty(boom, "x", { enumerable: true, get() { throw new TypeError("boom"); } });
  assert.throws(() => guard.assertOwnResponse(ALICE_DECK, { a: boom }), (e) => e instanceof OwnDataError);
  const rows = [{ userId: BOB }];
  rows.push(rows); // a cycle through the exempt array
  assert.doesNotThrow(() => guard.assertOwnResponse(ALICE_DECK, { investorMatches: rows }, { matchRows: rows }));
  let deep = { userId: BOB };
  for (let i = 0; i < 50_000; i++) deep = { n: deep };
  assert.throws(() => guard.assertOwnResponse(ALICE_DECK, deep), (e) => e instanceof OwnDataError);
  // an exempt array that is not the one passed in is not exempt, even with the same key and contents
  assert.throws(() => guard.assertOwnResponse(ALICE_DECK, { investorMatches: [{ userId: BOB }] }, { matchRows: [{ userId: BOB }] }), (e) => e instanceof OwnDataError);
  assert.throws(() => guard.assertOwnResponse(ALICE_DECK, { investorMatches: [{ userId: BOB }] }), (e) => e instanceof OwnDataError);
});

// --- review round 3 (#6763): lists of owners and decks, only real ids compared, no non-string names ------------------

test("N4: an array under an owner or deck object name is a list of such objects, each element checked", async () => {
  for (const name of ["user", "users", "owner", "owners", "founder", "founders", "account", "accounts", "createdBy"]) {
    for (const idKey of ["id", "userId"]) {
      const flag = (...ids) => ({ redFlags: [{ title: "Flag text", [name]: ids.map((id) => ({ [idKey]: id })) }] });
      assert.match((await scoresOutcome(flag(BOB))).error?.message ?? "passed", /does not belong to your account/, `${name}[${idKey}] BOB`);
      assert.match((await scoresOutcome(flag(ALICE, BOB))).error?.message ?? "passed", /does not belong to your account/, `${name}[${idKey}] mixed`);
      assert.match((await scoresOutcome(flag(ALICE, ALICE))).out ?? "", /Overall: 7\/10/, `${name}[${idKey}] ALICE`);
    }
    // a string under an owner-object name cannot be compared to an id and is left alone
    assert.match((await scoresOutcome({ redFlags: [{ title: "T", [name]: "Some Name" }] })).out ?? "", /Overall/, `${name} string`);
  }
  for (const name of ["deck", "decks", "pitchDeck", "pitchDecks", "pitch_deck"]) {
    assert.match((await scoresOutcome({ redFlags: [{ title: "T", [name]: [{ id: OTHER_DECK }] }] })).error?.message ?? "passed", /different deck/, `${name} other`);
    assert.match((await scoresOutcome({ redFlags: [{ title: "T", [name]: [{ id: ALICE_DECK }, { id: OTHER_DECK }] }] })).error?.message ?? "passed", /different deck/, `${name} mixed`);
    assert.match((await scoresOutcome({ redFlags: [{ title: "T", [name]: [{ id: ALICE_DECK }, { id: ALICE_DECK }] }] })).out ?? "", /Overall/, `${name} requested`);
  }
  // inside the exempt match rows, owner lists stay exempt and deck lists are still checked
  const rowsOk = aliceApi(matchesWith({ investorMatches: [{ investorName: "Fund One", matchScore: 0.5, users: [{ id: BOB }], founders: [{ userId: BOB }] }] }));
  try {
    assert.match(await createHandlers(KEY_A).repyh_deck_matches({ deck_id: ALICE_DECK }), /Fund One - 50% fit/);
  } finally { rowsOk.restore(); }
  const rowsBad = aliceApi(matchesWith({ investorMatches: [{ investorName: "Fund One", matchScore: 0.5, decks: [{ id: OTHER_DECK }] }] }));
  try {
    await assert.rejects(() => createHandlers(KEY_A).repyh_deck_matches({ deck_id: ALICE_DECK }), /different deck/);
  } finally { rowsBad.restore(); }
});

test("N5: an owner field that is not UUID-shaped is ignored; a UUID-shaped foreign value still refuses; an object value still refuses", async () => {
  const cases = [{ createdBy: "system" }, { accountId: "acct_123" }, { customerId: "cus_9" }, { memberId: 42 }, { userId: "not-a-uuid" }, { ownerId: true }];
  for (const c of cases) {
    assert.match((await scoresOutcome({ redFlags: [{ title: "T", ...c }] })).out ?? "", /Overall: 7\/10/, JSON.stringify(c));
  }
  for (const name of ["createdBy", "accountId", "customerId", "memberId", "userId"]) {
    assert.match((await scoresOutcome({ redFlags: [{ title: "T", [name]: ` ${BOB.toUpperCase()}\n` }] })).error?.message ?? "passed", /does not belong to your account/, name);
  }
  assert.match((await scoresOutcome({ redFlags: [{ title: "T", accountId: { id: BOB } }] })).error?.message ?? "passed", /does not belong to your account/);
  assert.match((await scoresOutcome({ redFlags: [{ title: "T", memberId: [BOB] }] })).error?.message ?? "passed", /does not belong to your account/);
  // deck references keep the strict rule: a non-UUID value that differs from the requested deck is refused
  assert.match((await scoresOutcome({ redFlags: [{ title: "T", deckId: "deck_123" }] })).error?.message ?? "passed", /different deck/);
});

test("N6: a match row's name that is not a non-empty string prints 'Investor'", async () => {
  const api = aliceApi(matchesWith({ investorMatches: [
    { investorName: { first: "A" }, matchScore: 0.4 },
    { investorName: 7, firmName: ["x"], matchScore: 0.4 },
    { investorName: "   ", name: { n: 1 }, matchScore: 0.4 },
    { investorName: "Fund Real", matchScore: 0.4 },
  ] }));
  try {
    const out = await createHandlers(KEY_A).repyh_deck_matches({ deck_id: ALICE_DECK });
    assert.doesNotMatch(out, /\[object|\bA\b - /);
    assert.equal(out.split("\n").filter((l) => l === "- Investor - 40% fit").length, 3);
    assert.match(out, /- Fund Real - 40% fit/);
  } finally { api.restore(); }
});
