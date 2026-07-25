# Security — pinch-mcp

`pinch-mcp` is an **unofficial community MCP server** for the Pinch Payments
API. It is a financial tool, so the security posture is documented here in
full — what is designed in, what was hardened before public submission, and
what is honestly still on the list.

## Secure by design

- **Approve-then-act at the tool layer.** Every write tool
  (`pinch_create_payment_link`, `pinch_retry_payment`, `pinch_create_refund`,
  `pinch_create_subscription`, `pinch_cancel_subscription`,
  `pinch_create_split`, `pinch_design_billing`) requires the parameter
  `confirm` to be **exactly boolean `true`** before any state-changing API call
  is made. Anything else returns a structured preview for human approval. The
  guard is enforced server-side in the tool handler — a prompt-injected or
  confused AI host cannot skip it, because the check is not in the prompt; it
  is in the code. `confirm` is zod-validated as a boolean, so `"true"`
  (string) fails schema validation outright.
- **Refund cap, server-side.** `pinch_create_refund` rejects any refund above
  `PINCH_MAX_REFUND_CENTS` (default $200.00) before preview *and* before
  execution. There is no in-band override parameter — raising the cap requires
  changing the server's environment.
- **No credentials on the shared server.** The multi-tenant HTTP mode holds no
  merchant credentials: each caller supplies their own
  `x-pinch-merchant-id` / `x-pinch-secret-key` per request. Merchants
  authorise the tool with their **own** Pinch keys; nothing is shared,
  proxied, or stored (tokens are cached in memory only, keyed by a SHA-256
  digest of merchantId+secret+env, expiring at 55 minutes).
- **Live refused by default.** `x-pinch-env` defaults to `test`; the value is
  lower-cased and strictly matched, so `LIVE`, `Live `, etc. cannot slip
  through — anything that isn't exactly `test`/`live` after lower-casing is
  rejected, and `live` is refused unless the operator started the process with
  `--allow-live`. The public playground is deliberately sandbox-only.
- **Idempotent writes.** Retries and refunds send Pinch `nonce` values, so an
  accidental double-call cannot double-charge or double-refund.
- **No user-controlled fetches (SSRF).** The process performs outbound HTTPS
  to exactly two hard-coded hosts (`auth.getpinch.com.au`,
  `api.getpinch.com.au`). `returnUrl` and every other user-supplied URL-ish
  value is passed to Pinch as JSON data, never fetched by this server.
- **Path/query injection.** Every identifier that enters a URL path
  (`paymentId`, `payerId`, `subscriptionId`, `transferId`, …) is
  `encodeURIComponent`-wrapped at the call site; query strings go through
  `URLSearchParams`. Free-text fields (descriptions, metadata, names) only
  ever travel inside `JSON.stringify`-encoded bodies.

## Fixed in this pass (pre-submission hardening)

| # | Finding | Severity | Status |
|---|---|---|---|
| 1 | **Token cache keyed by merchantId+env only** — on the shared endpoint, a caller knowing a victim's merchantId (not the secret) could hit the victim's warm cached token | **Critical** | **Fixed** — cache key is now `SHA-256(merchantId ∥ secret ∥ env)`; wrong secret ⇒ guaranteed cache miss ⇒ Pinch rejects the auth attempt |
| 2 | No rate limiting on the open HTTP relay | High | **Fixed** — per-IP token bucket (first `X-Forwarded-For` hop, Cloud Run-aware), default 60 req/min, tunable via `PINCH_MCP_RATE_LIMIT`, returns `429` + `Retry-After`; `/healthz` exempt so platform health checks can't be starved |
| 3 | No request body size cap (incl. unbounded chunked bodies) | High | **Fixed** — 256 KB hard cap enforced while streaming (socket destroyed past the cap), body parsed once and handed to the MCP transport pre-parsed |
| 4 | No socket timeout posture (slowloris) | Medium | **Fixed** — `headersTimeout` 10 s, `requestTimeout` 30 s, `keepAliveTimeout` 5 s |
| 5 | `/mcp` accepted non-POST methods (delegated to transport 405s) | Low | **Fixed** — explicit POST-only filter (OPTIONS handled for CORS preflight) |
| 6 | Error/fatal logs printed full error objects | Low | **Fixed** — logs carry `error.message` only; header/body context never logged; header secrets were already never logged anywhere |
| 7 | No Dockerfile / container ran undefined | Medium | **Fixed** — multi-stage Dockerfile, `USER node` (non-root), `NODE_ENV=production`, pinned `node:22.22-slim` (digest-pinning instructions included), prod-only deps |
| 8 | `.env` could leak into images/commits | High | **Fixed** — `.dockerignore` + `.gitignore` exclude `.env` (npm `files` allow-list already excluded it from packages) |
| 9 | Stray `http.log` in the package directory | Info | **Fixed** — removed; `*.log` ignored |
| 10 | **No audit trail of tool invocations** (OWASP §7, SlowMist "Monitoring & Logging", Palo Alto "log security-relevant events") | High | **Fixed** — every tool call emits one audit line to stderr: tool name, outcome (ok/error/exception), duration, and a non-reversible tenant tag (`env:sha256(merchantId)[:12]`). Parameters and results are never logged (payer PII); secrets are never in scope. On Cloud Run these become queryable structured logs |
| 11 | No size limit on tool outputs returned to the model (OWASP §3 "enforce size limits on all outputs") | Medium | **Fixed** — serialized results are capped (default 200 000 chars, `PINCH_MCP_MAX_RESULT_CHARS`) with an explicit `[TRUNCATED …]` marker instructing the model to narrow the query rather than trust a partial payload |
| 12 | No tool-manifest integrity signal — clients could not detect a changed tool set or mutated descriptions ("rug pull", OWASP §2 / Palo Alto / SlowMist tool-integrity) | Medium | **Fixed** — the server computes `toolsHash` = SHA-256 over every tool's canonical `{name, title, description}` at startup, logs it, and exposes it on `GET /meta`. Any change to any tool's surface changes the hash; clients and operators can pin it |
| 13 | HTTP mode always bound to all interfaces (OWASP §1: local servers should bind loopback) | Low | **Fixed** — new `--bind <addr>` flag; default stays `0.0.0.0` (required by Cloud Run), local users on shared networks run `--bind 127.0.0.1` |

Audited and confirmed clean (no change needed): secrets never echoed in tool
results, previews, or `/meta`; all 7 write tools guard before any POST
(including `pinch_design_billing`'s provisioning loop and split-creation
loops); refund cap unbypassable in-band; live-env refusal robust to
casing/whitespace; zod schemas on every tool input; all path parameters
URL-encoded; no user-controlled fetch targets; two runtime dependencies only
(`@modelcontextprotocol/sdk`, `zod`) with a committed lockfile.

## Standards alignment

Reviewed against three published MCP-security references: the **OWASP GenAI
Security Project — A Practical Guide for Secure MCP Server Development v1.0**
(Feb 2026), the **Palo Alto Networks** community analysis *MCP Security
Exposed*, and the **SlowMist MCP-Security-Checklist**. Mapping to the OWASP
"MCP Security Minimum Bar":

| Minimum-bar area | Status here |
|---|---|
| 1. Strong identity, auth & policy enforcement | **Partial.** No OAuth 2.1 gateway — by design each caller presents *their own* Pinch merchant credentials per request over TLS, which are exchanged for a short-lived (≤55 min) Pinch token. There is no shared identity to confuse and no token passthrough: the only downstream is Pinch itself, called with a token minted for exactly the credentials the caller supplied. Policy enforcement (confirm-guards, refund cap, live-refusal) is centralised in server code. OAuth delegation is a Polish Week item |
| 2. Strict isolation & lifecycle control | **Met for this architecture.** Stateless HTTP: a fresh MCP server + transport per request, no sessions, no shared per-user state; the only cross-request state is the token cache, keyed by `SHA-256(merchantId ∥ secret ∥ env)` so cross-tenant hits are impossible; entries expire at 55 min. Per-IP rate quotas; body caps; socket timeouts |
| 3. Trusted, controlled tooling | **Partial.** Tool set is static at build time (no dynamic tool loading — rug-pull surface minimised) and `toolsHash` on `/meta` lets clients pin the manifest. Descriptions are honest about behaviour (read tools annotated `readOnlyHint`; write tools state the confirm requirement). Not cryptographically *signed* — hash-pinning only |
| 4. Schema-driven validation everywhere | **Met.** Every tool input is zod-validated (strict types; `confirm` must be boolean `true`); malformed JSON-RPC is rejected by the SDK; outputs are size-capped with explicit truncation markers; path params URL-encoded; free text only ever travels JSON-encoded |
| 5. Hardened deployment & continuous oversight | **Partial.** Container is non-root, minimal, pinned; secrets live in env/headers (never in code, never logged, never shown to the model); per-call audit logging now on. No CI security gates (SAST/SCA), no SIEM alerting yet — acknowledged below |

Palo Alto's named risks, briefly: *malicious/unofficial servers & supply chain* —
two runtime deps, committed lockfile, no install scripts (install from the
official repo only); *consent fatigue* — write previews are distinct,
structured, and show exact amounts, so approval is informed rather than
reflexive (final UX is the MCP client's responsibility); *insufficient
sandboxing* — hosted instance is an isolated non-root container with no
filesystem tools and outbound HTTPS to two hard-coded Pinch hosts only;
*plaintext credential exposure* — nothing is written to disk; header secrets
live only in request scope, tokens only in an in-memory hashed-key cache;
*weak authentication* — the relay itself holds no data: every request must
carry valid Pinch credentials or Pinch rejects it; *tool name collision* — all
tools are `pinch_`-prefixed; *malicious prompts in tool descriptions* —
descriptions are static, human-reviewed, and hash-pinned via `toolsHash`.

SlowMist's server-side checklist (API security, auth, deployment & runtime,
supply chain, monitoring & logging, tools security) is covered by the same
controls above; its crypto/wallet-specific items don't apply (no keys or
wallets — Pinch is the custodian of funds movement, and the strong-confirmation
principle is implemented as the `confirm` guard + refund cap).

## Known limitations / Polish Week acknowledgements

Honest list of what this is **not** yet:

- **In-memory rate limiting is per-instance.** Cloud Run can run multiple
  instances; a distributed limiter (or Cloud Armor) is the production answer.
  There are also **no per-tenant quotas** — limits are per-IP only.
- **No audit log on the relay.** Pinch's own dashboard is the system of
  record; the relay itself does not persist who called which tool when.
- **CORS `*` on the playground.** Fine for a sandbox-only demo endpoint;
  a production deployment should pin `--cors-origin` to known origins.
- **Prompt-injection resistance relies on the approval gates.** A hostile
  prompt can make an AI host *call* read tools freely; money movement is
  protected by the `confirm` guard + refund cap, not by any content filter.
- **Test-only posture.** The hosted endpoint refuses live credentials by
  design. Running `--allow-live` anywhere public is explicitly warned against
  in the README and is the operator's responsibility.
- **No request signing between platform hosts (e.g. LyboAI) and this MCP.**
  Transport security is TLS; callers are authenticated only by the Pinch
  credentials they present.
- **Secrets transit as headers.** Acceptable over TLS, but a production
  multi-tenant design would exchange short-lived scoped tokens instead of raw
  API keys per request.
- **Supply chain**: two runtime dependencies, lockfile committed, no install
  scripts of our own; dependency updates are manual (no automated advisories
  wired up yet).
- **No OAuth 2.1/OIDC gateway or token delegation** (OWASP §5). The
  per-request-credentials model is deliberate for a BYO-keys toolkit, but a
  production platform deployment should front this with an identity-aware
  gateway issuing short-lived scoped tokens, so raw API keys never transit
  per request.
- **Tool manifest is hash-pinned, not signed** (OWASP §2). `toolsHash` detects
  mutation but doesn't prove authorship; cryptographic signing of the tool
  manifest is a Polish Week item.
- **No CI security gates or continuous scanning** (OWASP §8): no SAST/SCA in a
  pipeline, no MCP-Scan/mcp-watch runtime monitoring, no SIEM alerting on the
  audit log. The audit lines are structured precisely so they can be shipped
  to one later.
- **Indirect prompt injection via merchant data.** Payer names, descriptions,
  and metadata returned by the Pinch API are untrusted text that flows into
  the model's context. The server cannot sanitise meaning; the mitigation is
  architectural — no tool executes free text, and money movement always
  crosses the `confirm` guard, refund cap, and live-refusal. MCP clients
  should still render previews to a human ("human-in-the-loop" per OWASP §4).
- **Session hygiene is the client's job.** The server is stateless per
  request; OWASP's "one task, one session" context-compartmentalisation
  guidance applies to the calling agent platform.

## Reporting

This is a hackathon submission. Issues: open a GitHub issue on the toolkit
repository, or contact the maintainer. Do not include real credentials in
reports — sandbox reproductions only.
