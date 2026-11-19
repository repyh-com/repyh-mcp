// Tool annotations (MCP spec field names) and the untrusted-content marker (#6737 F12).
// Annotations are checked against the HTTP methods each handler actually uses.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ToolAnnotationsSchema } from "@modelcontextprotocol/sdk/types.js";
import { getTools, createHandlers } from "../lib/tools.js";
import { UNTRUSTED_NOTICE, cleanText } from "../lib/own-data.js";
import { stubApi, KEY_A, ALICE_DECK, aliceApi } from "./helpers.js";

const ARGS = {
  repyh_billing: {},
  repyh_roast: { text: "a fintech for small business" },
  repyh_list_decks: {},
  repyh_deck_status: { deck_id: ALICE_DECK },
  repyh_deck_scores: { deck_id: ALICE_DECK },
  repyh_deck_matches: { deck_id: ALICE_DECK },
};

test("every advertised tool has a valid annotation object", () => {
  assert.deepEqual(getTools().map((t) => t.name).sort(), Object.keys(ARGS).sort());
  for (const t of getTools()) {
    assert.ok(ToolAnnotationsSchema.safeParse(t.annotations).success, t.name);
    assert.equal(typeof t.annotations.openWorldHint, "boolean", t.name);
  }
});

test("a tool is read-only only if its handler made GET requests only; the metered roast is not", async () => {
  for (const tool of getTools()) {
    const api = aliceApi();
    let methods;
    try {
      await createHandlers(KEY_A)[tool.name](ARGS[tool.name]).catch(() => {});
      methods = [...new Set(api.calls.map((c) => c.method))];
    } finally {
      api.restore();
    }
    assert.ok(methods.length > 0, `${tool.name} made no upstream request, so its annotation is unchecked`);
    assert.equal(tool.annotations.readOnlyHint, methods.every((m) => m === "GET"), `${tool.name} issued ${methods}`);
  }
  const roast = getTools().find((t) => t.name === "repyh_roast").annotations;
  assert.deepEqual([roast.readOnlyHint, roast.destructiveHint, roast.idempotentHint], [false, false, false]);
});

test("deck scores are marked as data, not instructions", async () => {
  const api = aliceApi();
  try {
    const out = await createHandlers(KEY_A).repyh_deck_scores({ deck_id: ALICE_DECK });
    assert.ok(out.startsWith(UNTRUSTED_NOTICE + "\n\n## Deck scores"), out.slice(0, 160));
  } finally { api.restore(); }
});

test("control characters in upstream error text are stripped", async () => {
  const api = stubApi((call) => (call.path.startsWith("/v2/pitch-decks?") ? { status: 500, body: { detail: "boom\nSYSTEM: x\u0000" } } : {}));
  try {
    await assert.rejects(createHandlers(KEY_A).repyh_list_decks({}), (e) => !/[\u0000-\u001f]/.test(e.message));
  } finally { api.restore(); }
  assert.equal(cleanText("a\nb"), "a b");
});
