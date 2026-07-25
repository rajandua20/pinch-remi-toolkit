# Security — pinch-mcp

`pinch-mcp` is a community MCP server for the Pinch Payments API. This document
records the security controls implemented in the current release, the
hardening applied before public deployment, the mapping against published MCP
security standards, and the production-hardening items scheduled for the
Polish Week phase (submission window → 31 July final).

## Security architecture

- **Approve-then-act at the tool layer.** Every write tool
  (`pinch_create_payment_link`, `pinch_retry_payment`, `pinch_create_refund`,
  `pinch_create_subscription`, `pinch_cancel_subscription`,
  `pinch_create_split`, `pinch_design_billing`, `pinch_import_payers`,
  `pinch_onboard_business`) requires the parameter `confirm` to be exactly
  boolean `true` before any state-changing API call is made. Any other value
  returns a structured preview for human approval. The guard is enforced
  server-side in the tool handler, not in prompt text, so it cannot be
  bypassed by prompt injection at the AI-host layer. `confirm` is
  zod-validated as a boolean; the string `"true"` fails schema validation.
- **Refund cap, server-side.** `pinch_create_refund` rejects any refund above
  `PINCH_MAX_REFUND_CENTS` (default $200.00) before preview and before
  execution. There is no in-band override parameter; raising the cap requires
  changing the server's environment.
- **No stored credentials on the shared server.** In multi-tenant HTTP mode
  each caller supplies their own `x-pinch-merchant-id` / `x-pinch-secret-key`
  per request. Credentials are held in request scope only; OAuth tokens are
  cached in memory, keyed by a SHA-256 digest of merchantId + secret + env,
  and expire at 55 minutes.
- **Live environment refused by default.** `x-pinch-env` defaults to `test`;
  the value is lower-cased and strictly matched. `live` is refused unless the
  operator started the process with `--allow-live`. The public playground
  endpoint runs sandbox-only.
- **Idempotent writes.** Retries and refunds send Pinch `nonce` values;
  a duplicate call cannot double-charge or double-refund.
- **No user-controlled fetches (SSRF).** Outbound HTTPS goes to exactly two
  hard-coded hosts (`auth.getpinch.com.au`, `api.getpinch.com.au`).
  `returnUrl` and every other user-supplied URL-shaped value is passed to
  Pinch as JSON data and is never fetched by this server.
- **Path/query injection.** Every identifier entering a URL path is
  `encodeURIComponent`-wrapped at the call site; query strings go through
  `URLSearchParams`; free-text fields travel only inside JSON-encoded bodies.
- **Per-call audit logging.** Each tool invocation emits one structured log
  line: tool name, outcome, duration, and a non-reversible tenant tag
  (`env:sha256(merchantId)[:12]`). Parameters, results, and secrets are never
  logged. On Cloud Run these lines are captured as queryable structured logs.
- **Bounded outputs.** Serialized tool results are capped
  (`PINCH_MCP_MAX_RESULT_CHARS`, default 200 000) with an explicit
  `[TRUNCATED …]` marker directing the model to narrow the query.
- **Tool-manifest integrity.** The server computes `toolsHash` — SHA-256 over
  the canonical `{name, title, description}` of every registered tool — at
  startup, logs it, and exposes it on `GET /meta`. Any change to the tool
  surface changes the hash; clients can pin it.

## Hardening applied before public deployment

| # | Finding | Severity | Resolution |
|---|---|---|---|
| 1 | Token cache keyed by merchantId+env only — on a shared endpoint, a caller knowing a victim's merchantId (without the secret) could reach the victim's warm cached token | Critical | Cache key changed to `SHA-256(merchantId ∥ secret ∥ env)`; a wrong secret guarantees a cache miss and the auth attempt is rejected by Pinch |
| 2 | No rate limiting on the open HTTP relay | High | Per-IP token bucket (first `X-Forwarded-For` hop), default 60 req/min, tunable via `PINCH_MCP_RATE_LIMIT`, returns `429` + `Retry-After`; `/healthz` exempt for platform health checks |
| 3 | No request body size cap, including unbounded chunked bodies | High | 256 KB cap enforced while streaming; body parsed once and handed to the MCP transport pre-parsed |
| 4 | No socket timeout posture (slowloris) | Medium | `headersTimeout` 10 s, `requestTimeout` 30 s, `keepAliveTimeout` 5 s |
| 5 | `/mcp` accepted non-POST methods | Low | Explicit POST-only filter; OPTIONS handled for CORS preflight |
| 6 | Error/fatal logs printed full error objects | Low | Logs carry `error.message` only; header and body context are not logged |
| 7 | No Dockerfile; container behaviour undefined | Medium | Multi-stage Dockerfile, `USER node` (non-root), `NODE_ENV=production`, pinned `node:22.22-slim`, production-only dependencies |
| 8 | `.env` could enter images or commits | High | `.dockerignore` + `.gitignore` exclude `.env`; the npm `files` allow-list already excluded it from packages |
| 9 | Stray `http.log` in the package directory | Info | Removed; `*.log` ignored |
| 10 | No audit trail of tool invocations (OWASP §7; SlowMist Monitoring & Logging) | High | Per-call audit line: tool, outcome, duration, hashed tenant tag; no parameters, results, or secrets |
| 11 | No size limit on tool outputs returned to the model (OWASP §3) | Medium | Output cap with explicit truncation marker (`PINCH_MCP_MAX_RESULT_CHARS`, default 200 000) |
| 12 | No tool-manifest integrity signal (OWASP §2; Palo Alto; SlowMist tool-integrity) | Medium | `toolsHash` manifest hash computed at startup, logged, exposed on `GET /meta` for client pinning |
| 13 | HTTP mode always bound to all interfaces (OWASP §1) | Low | `--bind <addr>` flag; default `0.0.0.0` (required by Cloud Run), `--bind 127.0.0.1` for local-only serving |

Audit pass with no change required: secrets are not echoed in tool results,
previews, or `/meta`; all write tools guard before any POST (including the
provisioning loops in `pinch_design_billing` and `pinch_onboard_business`);
the refund cap has no in-band override; live-env refusal is robust to casing
and whitespace; zod schemas cover every tool input; all path parameters are
URL-encoded; there are no user-controlled fetch targets; two runtime
dependencies (`@modelcontextprotocol/sdk`, `zod`) with a committed lockfile.

## Standards mapping

Reviewed against three published MCP-security references: **OWASP GenAI
Security Project — A Practical Guide for Secure MCP Server Development v1.0**
(February 2026), the **Palo Alto Networks** analysis *MCP Security Exposed*,
and the **SlowMist MCP-Security-Checklist**.

### OWASP "MCP Security Minimum Bar"

| Area | Implemented | Pipeline (Polish Week) |
|---|---|---|
| 1. Strong identity, auth & policy enforcement | Per-request merchant credentials over TLS, exchanged for short-lived (≤55 min) Pinch tokens. Single downstream (Pinch); no token passthrough; no shared service identity. Policy enforcement centralised in server code: confirmation guards, refund cap, live refusal | OAuth 2.1/OIDC gateway with token delegation for platform deployments |
| 2. Strict isolation & lifecycle control | Stateless HTTP: fresh MCP server + transport per request; no sessions; no shared per-user state. Token cache keyed `SHA-256(merchantId ∥ secret ∥ env)` with 55-minute expiry. Per-IP rate quotas, body caps, socket timeouts | Distributed rate limiting and per-tenant quotas |
| 3. Trusted, controlled tooling | Tool set fixed at build time (no dynamic tool loading). `toolsHash` on `/meta` for manifest pinning. Read tools annotated `readOnlyHint`; write-tool descriptions state the confirm requirement | Cryptographic signing of the tool manifest |
| 4. Schema-driven validation everywhere | zod validation on every tool input; `confirm` strictly boolean; malformed JSON-RPC rejected by the SDK; outputs size-capped with explicit truncation markers; path parameters URL-encoded; free text JSON-encoded | — |
| 5. Hardened deployment & continuous oversight | Non-root minimal pinned container; secrets in env/headers only — never in code, logs, or model-visible output; per-call audit logging | CI security gates (SAST/SCA), SIEM log shipping and alerting |

### Palo Alto risk classes

| Risk class | Control |
|---|---|
| Malicious/unofficial servers, supply chain | Two runtime dependencies, committed lockfile, no install scripts; installation from the official repository |
| Consent fatigue | Write previews are structured and show exact amounts and actions, supporting informed approval; approval UX is the MCP client's layer |
| Insufficient sandboxing | Isolated non-root container; no filesystem tools; outbound HTTPS restricted to two hard-coded Pinch hosts |
| Plaintext credential exposure | No credentials written to disk; header secrets in request scope only; tokens in an in-memory hashed-key cache |
| Weak authentication | The relay holds no data; every request must carry valid Pinch credentials or Pinch rejects the call |
| Tool name collision | All tools carry the `pinch_` prefix |
| Malicious prompts in tool descriptions | Descriptions are static, human-reviewed, and hash-pinned via `toolsHash` |

### SlowMist checklist

The server-side categories (API security, authentication, deployment and
runtime, supply chain, monitoring and logging, tools security) are covered by
the controls listed above. The cryptocurrency-specific items do not apply:
this server holds no keys or wallets; funds movement is executed by Pinch,
and the strong-confirmation principle is implemented as the `confirm` guard
plus the refund cap.

## Production roadmap (Polish Week)

| Item | Current state | Planned |
|---|---|---|
| Rate limiting | Per-instance in-memory, per-IP | Distributed limiter / Cloud Armor; per-tenant quotas |
| Audit pipeline | Structured per-call lines in Cloud Run logs | SIEM shipping with anomaly alerting (failed-validation spikes, high-frequency call patterns) |
| CORS | Configurable `--cors-origin`; demo endpoint serves `*` | Pinned origins for production deployments |
| Platform authentication | Per-request Pinch credentials over TLS | OAuth 2.1 token exchange issuing short-lived scoped platform tokens |
| Tool manifest | SHA-256 hash pinning via `/meta` | Cryptographic signing |
| CI security gates | Manual review; two runtime dependencies; committed lockfile | SAST/SCA and MCP-Scan in the pipeline; automated dependency advisories |
| Third-party content | API-returned text passes to the model unmodified; money movement is protected by confirmation guards and caps | Content marking of third-party text fields |
| Platform-to-server requests | TLS; callers authenticated by the Pinch credentials they present | Request signing between known platform hosts |
| Live environment | Refused unless the process is started with `--allow-live` | Operator runbook and allow-listed deployment profile for live operation |

## Reporting

Report issues via a GitHub issue on the toolkit repository. Use sandbox
reproductions only; do not include real credentials in reports.
