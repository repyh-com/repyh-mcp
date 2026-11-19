# repyh-mcp: your decks, scores and investor matches, inside Claude

Understand what your pitch proves, where the evidence is weak, and what to improve before approaching investors. You choose what to change and whom to contact. Only your own data, bound to your key.

**Release status:** this founder package is not released yet. The examples below run the local package source; do not assume an npm package or founder key creation is available. Existing compatible keys are supported; no founder key-page URL is verified.

- Deck status and scores from 0 to 10.
- Investor matches where your plan includes them.
- Blunt feedback on pitch text.

Before running a local source copy, use Node.js 18 or newer and install its dependencies from the directory containing this package's `package.json`:

```bash
npm install --ignore-scripts
```

Then configure your key in your MCP client's environment and restart the client. Never paste a real key into a conversation.

```bash
REPYH_API_KEY='replace_with_your_existing_key' node index.js
```

To connect a desktop MCP client to this local package, add a local server entry (replace the absolute path and placeholder locally):

```json
{
  "mcpServers": {
    "repyh": {
      "command": "node",
      "args": ["/absolute/path/to/local-mcp/index.js"],
      "env": { "REPYH_API_KEY": "replace_with_your_existing_key" }
    }
  }
}
```

Try:

- *"List my decks and their status"*
- *"What are the scores and key improvements on my latest deck?"*
- *"Give me blunt feedback on this pitch: [paste]"*

## Confirm your connection without spending credits

After adding the server, restart your MCP client and ask: “Use `repyh_billing` to check my allowance and tool costs.” A successful response confirms that the client, key and account can read billing; it does not run analysis or start a purchase. If the server says billing discovery is unavailable, the deployed server may be an earlier release. Do not infer a zero balance or buy access to fix a connection problem.

## Your first useful result

For an existing deck, ask: “List my decks, then explain the readiness and the three most useful improvements for the deck I choose.” A processing deck needs a later status check; a failed upload needs review before uploading again. No continuous polling or promised completion time.

For pitch text, ask: “Give me constructive feedback on this pitch and identify the weakest supported claim: [paste].” This uses monthly quota. Reviewing stored scores does not rerun analysis. Investor matches are an optional next step where your plan includes them; they do not promise interest, funding or an introduction.

## Check costs before acting

Ask “What is my balance, quota and the current price available to my account?” Your assistant uses `repyh_billing`, a free read. Prices, currency, pack eligibility and per-tool costs come from your account at request time. An unavailable balance is unknown, not zero. A plan without a self-serve pack is not offered another audience’s pack. Any purchase happens only when you choose to review and confirm it in your browser; the tool never opens checkout or charges you.

## Pricing and allowance

Ask “What will this cost, and what is my current balance?” before a metered action. `repyh_billing` reads your account's current founder credit balance, monthly quota, eligible pack price and currency, and costs for the tools available to this audience. It spends neither credits nor quota and does not start checkout.

Prices come from the server's current catalogue, never a fixed price in this package. An unavailable balance is not zero; an unavailable quota is not unlimited. If no self-serve pack is offered, review your account allowance. A configured founder pack quote describes credits for extra investor matches beyond the 30 included with Pro. Credits are not deck checks, are not yet available to buy or spend until the 30-match limit is built, and do not pay for `repyh_roast`, which uses monthly quota. A quote does not imply checkout is available. Follow the server’s account guidance; a dashboard link manages account access and does not promise a purchase flow. Reading stored investor matches does not consume credits or quota; plan and key permissions still apply.

## Tools

| Tool | What it does | What you would ask |
|---|---|---|
| `repyh_billing` | Current balance, quota, tool costs and eligible pack price; no purchase. | "What will this cost?" |
| `repyh_list_decks` | Your decks and their status. Start here for a deck id. | "List my decks" |
| `repyh_deck_status` | Is this deck still being read, scored, or failed? | "Has my latest deck finished scoring?" |
| `repyh_deck_scores` | Scores out of 10, red flags and what to improve. | "What are the weakest scores on my latest deck?" |
| `repyh_deck_matches` | Investors matched to this deck, where your plan includes them. | "Which investors matched my latest deck?" |
| `repyh_roast` | Blunt investor-style feedback on pitch text you paste. | "Roast this pitch: [paste]" |

## Your data only

The API key identifies you; there is no way to name another user. A `deck_id` that is not in your own
deck list is rejected before any request, arguments such as `user_id` / `owner_id` / `investor_id` are
rejected, and any response that carries another owner is discarded. Admin keys are refused.

## Use

From the local package directory, configure an existing compatible key in your client environment (never paste a real key into chat):

```bash
node index.js   # stdio; reads REPYH_API_KEY
node server.js  # HTTP; caller sends their own key in a header
```

- **Key variable:** `REPYH_API_KEY`. `NUVC_API_KEY` is still read as a **deprecated** fallback (a notice is
  printed on stderr); switch to `REPYH_API_KEY`.
- **Key format:** your founder key (`repyh_...`); older `nuvc_...` keys still work. Anything else is refused
  before any request.
- **HTTP transport:** send your own key on every request (`Authorization: Bearer` or `X-API-Key`; a key in
  the URL is not accepted). The server never uses a shared key from its environment. Optional settings:
  `MCP_ALLOWED_ORIGINS` (comma-separated exact origins; a request with any other `Origin` header gets `403`,
  none allowed by default) and `MCP_RATE_LIMIT_PER_MINUTE` (per API key, default `60`) and `MCP_RATE_LIMIT_PER_MINUTE_IP` (per client
  address, default `600`), each answering `429` with `Retry-After`. One access-log line per request goes to stderr, without the query string, key or body.
- **Scope of a founder key:** pitch analysis, the list of models, and your own decks' status, scores and
  matches. Asking for anything else answers "This API key cannot do that here."

Tests: `npm test`.

Before publishing a reviewed commit, commit all changes and run `bash scripts/verify-before-push.sh`. It rejects a dirty worktree, runs the full suite including release checks, and records verification for that exact commit. It does not push or publish.

## If a request does not complete

- Key rejected or expired: check the key configured in your client; do not paste it into chat.
- Plan or quota exhausted: ask for `repyh_billing`, a free read, to see your allowance, reset date and tool costs. Founder credits do not extend pitch feedback quota. Review your plan in your REPYH account before another paid request.
- Too many requests: wait before trying again; repeated calls will not help.
- Timeout or service failure: the outcome of a paid pitch analysis may be uncertain. Do not automatically repeat it or purchase access to fix a transient failure.
