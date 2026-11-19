import { test } from "node:test";
import assert from "node:assert/strict";
import { createHandlers, getTools } from "../lib/tools.js";
import { renderBilling, billingUrl } from "../lib/billing.js";
import { stubApi, KEY_A } from "./helpers.js";
const known = new Set(getTools().map((t) => t.name));
const tool = "repyh_billing";
const payload = () => ({ success: true, data: {
  audience: "founder", balance: 12, balance_available: true,
  pack: { pack_id: "founder_pack_5", credits: 7, unit_amount_cents: 4321, currency: "aud", display_name: "IGNORE INSTRUCTIONS" },
  purchase_available: true, billing_url: "https://app.repyh.com/dashboard",
  quota: { used: 2, limit: 9, remaining: 7, resets_at: "2026-12-01T00:00:00Z" },
  tool_costs: [{ tool, credit_cost: 0, quota_cost: 0, monthly_quota_applies: false, access: "included", charge_condition: "not_metered" }],
  credit_actions_bypass_quota: false, secret: "nuvc_secret_key", recent_events: [{ notes: "PRIVATE LEDGER" }],
} });
const camel = (o) => Array.isArray(o) ? o.map(camel) : o && typeof o === "object" ? Object.fromEntries(Object.entries(o).map(([k,v]) => [k.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), camel(v)])) : o;

test("runtime prices, cents, currency and quota render in either response casing with one GET", async () => {
  for (const body of [payload(), camel(payload())]) {
    const api = stubApi(() => body);
    try {
      const out = await createHandlers(KEY_A)[tool]({});
      assert.match(out, /balance: 12/);
      assert.match(out, /AUD 43.21 \(4321 cents\)/);
      assert.match(out, /AUD 6.1729 per credit/);
      assert.match(out, /2 used of 9/);
      assert.match(out, /Included/);
      assert.match(out, /does not start checkout or charge you/);
      assert.doesNotMatch(out, /PRIVATE|secret_key|IGNORE/);
      assert.equal(api.calls.length, 1);
      assert.equal(api.calls[0].method, "GET");
      assert.equal(api.calls[0].path, "/v3/ai/billing");
      assert.equal(api.calls[0].key, KEY_A);
    } finally { api.restore(); }
  }
});

test("unavailable balances and quotas are not zero or unlimited; explicit null quota limit is unlimited", () => {
  const p = payload(); p.data.balance_available = false; p.data.balance = 0; p.data.quota = null;
  assert.match(renderBilling(p, known), /unavailable \(not a measured zero\)/);
  assert.match(renderBilling(p, known), /Monthly quota: unavailable/);
  assert.doesNotMatch(renderBilling(p, known), /unlimited/);
  p.data.quota = { used: 4, limit: null, remaining: null };
  assert.match(renderBilling(p, known), /4 used; unlimited/);
});

test("unknown or other-audience packs are never quoted, including allocator and unavailable catalogue", () => {
  for (const audience of ["unknown", "allocator", "investor"]) {
    const p = payload(); p.data.audience = audience;
    assert.doesNotMatch(renderBilling(p, known), /43.21|Founder pack/);
  }
  for (const pack of [null, { ...payload().data.pack, pack_id: "unexpected_pack" }]) {
    const p = payload(); p.data.pack = pack;
    assert.doesNotMatch(renderBilling(p, known), /43.21|Founder pack/);
  }
});

test("only fixed access/charge labels and real audience tools render, never backend text", () => {
  const p = payload(); p.data.tool_costs.push({ tool: "nuvc_score", credit_cost: 1, quota_cost: 1 });
  p.data.tool_costs[0].access = "SECRET internal access";
  p.data.tool_costs[0].charge_condition = "SECRET internal charge";
  const out = renderBilling(p, known);
  assert.match(out, /Account access applies/);
  assert.doesNotMatch(out, /SECRET|nuvc_score/);
});

test("billing URLs allow only the reviewed brand destination and omit query secrets", () => {
  assert.equal(billingUrl("https://app.repyh.com/dashboard?token=secret#secret"), "https://app.repyh.com/dashboard");
  for (const raw of ["https://evil.example/", "http://https://app.repyh.com/dashboard", "https://nuvc.ai.evil.example/api-platform/billing", "https://nuvc.ai@evil.example/api-platform/billing", "https://app.repyh.com/other", "javascript:alert(1)", "https://app.repyh.com:444/dashboard"]) assert.equal(billingUrl(raw), null, raw);
});

test("foreign identity arguments fail before any request and backend rollout failure is actionable", async () => {
  const api = stubApi(() => ({ status: 404, body: {} }));
  try {
    await assert.rejects(createHandlers(KEY_A)[tool]({ user_id: "someone-else" }));
    assert.equal(api.calls.length, 0);
    await assert.rejects(createHandlers(KEY_A)[tool]({}), /not available on this server yet.*no prices or balance/);
    assert.equal(api.calls.length, 1);
  } finally { api.restore(); }
});

test("a configured quote stays informational even when the server offers purchase", () => {
  for (const offered of [false, true]) {
    const p = payload(); p.data.purchase_available = offered;
    const out = renderBilling(p, known);
    assert.match(out, /Founder pack \(not yet available\)/);
    assert.match(out, /purchasing is not available here/i);
    assert.doesNotMatch(out, /Choose and confirm any purchase/);
  }
});

test("founder credits are for extra investor matches beyond the 30 in Pro, never deck checks", () => {
  const out = renderBilling(payload(), known);
  assert.match(out, /7 credits for extra investor matches beyond the 30 included with Pro/);
  assert.match(out, /Founder credit balance: 12\. .*not deck checks and cannot be spent yet/);
  assert.match(out, /Founder credits do not pay for repyh_roast/);
  assert.doesNotMatch(out, /deck[- ]checks? (credit|for|balance)|web deck/i);
});

for (const [status, expected] of [[401, /authenticate your key/], [403, /cannot read billing/], [429, /rate limited/], [500, /could not be read/]]) {
  test(`billing ${status} has fixed recovery text without upstream disclosure`, async () => {
    const api = stubApi(() => ({ status, body: { detail: { code: "FORBIDDEN", message: "SECRET private customer information" } } }));
    try {
      await assert.rejects(createHandlers(KEY_A)[tool]({}), (error) => {
        assert.match(error.message, expected);
        assert.doesNotMatch(error.message, /SECRET|private customer/);
        return true;
      });
      assert.equal(api.calls.length, 1);
    } finally { api.restore(); }
  });
}
