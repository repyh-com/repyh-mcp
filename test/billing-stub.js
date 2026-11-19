// Preload for the real stdio child: unexpected requests fail instead of using the network.
let calls = 0;
globalThis.fetch = async (url, init = {}) => {
  if (String(url) !== "https://api.nuvc.ai/api/v3/ai/billing" || init.method !== "GET" || ++calls !== 1) {
    throw new Error("Unexpected request in billing transport test");
  }
  return new Response(JSON.stringify({ success: true, data: {
    balance: 17, balanceAvailable: true, audience: "founder", pack: null,
    purchaseAvailable: false, billingUrl: null, quota: null,
    toolCosts: [], creditActionsBypassQuota: false,
  } }), { headers: { "content-type": "application/json" } });
};
