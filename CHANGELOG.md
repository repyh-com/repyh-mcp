# Changelog

## 0.1.0 - initial

The founder tools that left `nuvc-mcp` 2.0 (which is investor-only) now live here.

### Recovery and setup
- Payment-required and quota-exhausted errors point to the free account billing read before any purchase or retry. Recovery copy does not repeat backend offers or imply a pack is available to every account.
- Local-source setup includes dependency installation and a free billing connection check before a metered action.

### Added
- Tools: `repyh_roast`, `repyh_list_decks`, `repyh_deck_status`, `repyh_deck_scores`, `repyh_deck_matches`. Each description is written for a founder in plain language and ends with an example prompt.
- **Own data only.** Every tool returns only what the API-key holder owns. A deck id must be a UUID in your own deck
  list; any argument naming a user, owner or investor is rejected before a request is made; a response carrying
  another owner, or a different deck than requested, is discarded. Admin keys are refused (they list every founder's
  decks).
- stdio (`repyh-mcp`) and Streamable HTTP (`node server.js`) transports. HTTP is per-request keyed: no shared server
  key, no state shared between callers.
- **Key variable is `REPYH_API_KEY`.** `NUVC_API_KEY` still works as a deprecated fallback (stderr notice on stdio).
  `REPYH_API_KEY` wins when both are set.
- **Accepted keys:** `repyh_...` and `nuvc_...` (older keys). The whole key must be letters, digits and underscores
  after its prefix; anything else is refused before any request and never echoed.
- HTTP transport: the key is read from `Authorization: Bearer` or `X-API-Key` only. A key in the URL (`?config=`) is
  not accepted, because URLs are logged by proxies and clients; the 401 message asks for a REPYH key.
- HTTP transport hardening: a request with an `Origin` header not listed in `MCP_ALLOWED_ORIGINS` (comma-separated,
  exact match; empty by default) gets `403`; `/mcp` is limited per API key (default 60 a minute,
  `MCP_RATE_LIMIT_PER_MINUTE`, keyed on a hash of the key) and per client address (default 600 a minute,
  `MCP_RATE_LIMIT_PER_MINUTE_IP`, IPv6 by `/64`), `429` with `Retry-After`; one access-log line per request goes to
  stderr (no query string, no key, no body).
- Every tool declares annotations. `repyh_roast` spends credits or quota, so it is not marked read-only; the four
  tools that only read your own decks are. Upstream error text is stripped of control characters. Deck scores and
  investor matches start with one line saying the content below is data returned by the API, not instructions.
- **Founders are never sent to NUVC.** Auth, plan and upgrade errors point to your REPYH account, and the raw API
  error text is not echoed on a 401. A `403` with code `FORBIDDEN` reads "This API key cannot do that here." Other
  403 and 404 responses read "Not found, or not one of your own decks."
- The User-Agent is `repyh-mcp/<package version>`.
- **Error bodies are read in either shape** (plain `{detail}`, or the wrapped `{error: {detail}}` the platform sends
  for most routes), so a validation error, a missing-scope 403 and a server error each get the right sentence. Every
  429, 402, 403 and 5xx answers with fixed founder wording and never repeats backend text; no error names or links to
  another product.
- Investor matches show as a percentage ("82% fit"). Deck scores show a confidence level when the deck list has one.
  A failed deck's status shows the reason, and its matches say to upload it again. The roast text has stated limits.
- A list cut at 2,000 decks says so, and a deck that cannot be confirmed is reported as unconfirmed rather than as
  not yours. Owner fields and owner objects (`userId`, `ownerId`, `founderId`, `accountId`, `createdBy`, `user: {id}`,
  ...) are checked everywhere in a response except inside the rows of the investor-match list the matches tool reads
  (investors may carry other parties' ids); that exemption belongs to that one array, not to any key of that name.
  Any deck reference (`deck_id`, `deck: {id}`, ...) to a different deck is refused wherever it is, match rows included.
- A validation error shows only the names of the fields it is about, taken from the error's field path, limited to the
  tool's own inputs; no other error shows backend wording.
