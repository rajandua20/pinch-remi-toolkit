# Security — pinch-mcp

`pinch-mcp` is a community MCP server for the Pinch Payments API. This document
records the security controls implemented in the current release, the payment-data
boundary and the PCI DSS scope position, the Australian privacy obligations that
apply, the hardening applied before public deployment, the mapping against
published MCP security standards, and the production-hardening items scheduled
for the Polish Week phase (submission window → 31 July final).

Throughout, controls are marked either as present in this release or as
*pipeline*. Nothing described as pipeline is implemented today.

## Security architecture

- **Approve-then-act at the tool layer.** Every write tool
  (`pinch_create_payment_link`, `pinch_create_payment_qr`, `pinch_retry_payment`,
  `pinch_create_refund`, `pinch_create_subscription`, `pinch_cancel_subscription`,
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

## Payment-data boundary and PCI DSS scope

This architecture is **designed to minimise PCI DSS scope**. It is not a claim
of PCI DSS compliance: no part of this implementation has been formally
assessed, and the public deployment runs against the Pinch test environment.

**What the standard requires.** PCI DSS prohibits storing sensitive
authentication data — CVV/CVC, PIN and PIN blocks, full magnetic-stripe or
equivalent chip data — after authorisation, **even when encrypted**. That
prohibition is absolute and cannot be waived by cardholder consent. Primary
account numbers and bank-account numbers are cardholder / account data whose
storage, processing and transmission bring a system component into scope.

**How this server stays outside that scope.** Payment credentials are captured
by Pinch CaptureJS or a Pinch-hosted page in the payer's own browser and
travel from that browser to Pinch directly. They do not pass through an
application server, the Studio, the chat transcript, model context, an MCP
request, or telemetry. Payer payment
sources are only ever established by returning a Pinch-hosted link
(`pendingSetup`); the tool layer never asks a payer, or an operator, to type a
card number.

Two properties of the tool surface are directly verifiable in this repository:

```
# no payment-credential field exists in any tool schema
grep -rniE 'cvv|cvc|cardNumber|card_number|\bbsb\b|accountNumber|account_number|expMonth|expiry' src/ --include='*.ts' --exclude=smoke.ts
# no generic API-passthrough tool exists
grep -rniE 'call_api|callApi|rawRequest|proxy' src/ --include='*.ts' --exclude=smoke.ts
```

The passthrough grep returns no matches anywhere in `src/`. The credential-field
grep returns no matches in any tool schema (`tools.ts`) or in the Pinch client
(`pinch-client.ts`) — the files that define inputs and build API requests. Its
only hits are three plain-English strings in `dishonour-map.ts` (the words
"expiry" and "BSB" inside human-readable failure explanations such as *"the
customer's card has passed its expiry date"*), which are output text, not fields
any caller can populate. (`smoke.ts` is excluded: as the sandbox end-to-end test
it legitimately constructs a synthetic test bank account.) All 23 tools are
named, single-purpose and `pinch_`-prefixed; there is deliberately no
`pinch.call_api(method, endpoint, body)`, because a generic passthrough would
let prompt injection turn the agent into an unrestricted API client.

| Data class | Agent / model context | This MCP server | Storage |
|---|---|---|---|
| Sensitive authentication data (CVV/CVC, PIN, PIN block, track data) | Never | Never | Never after authorisation |
| Raw payment credentials (full PAN, BSB, bank account number) | Never | Avoided entirely — no schema accepts one | Pinch tokenisation boundary only |
| Security credentials (Pinch secret key, OAuth token, API key) | Never | Request-scoped in memory; tokens in a hashed-key cache | Secrets manager / KMS, never on this server |
| Tokenised payment references | Permitted | Permitted | Encrypted |
| Display-safe payment data (brand, source type, last four) | Permitted where necessary | Permitted | Limited retention |
| Personal information (name, email, address, phone, IP) | Pseudonymised where the task allows | Only where operationally necessary | Purpose-limited |
| Transaction information | Permitted with a pseudonymous customer identifier | Permitted | Financial retention policy |
| Unstructured content (prompts, uploaded documents, OCR, generated code) | Classification scan before use — **pipeline** | Classification scan in both directions — **pipeline** | No raw prompt retention |

The prohibition rows are enforced structurally: there is no field to populate,
so there is no policy to misapply. The rows marked *pipeline* are design
commitments for the Polish Week phase, not controls present in this release.

## Australian privacy obligations

The server processes payer records supplied by the merchant that owns the
credentials. Under the Privacy Act 1988 (Cth) and OAIC guidance, personal
information extends beyond names: transaction history, IP addresses, device
identifiers, location, and combinations of otherwise unremarkable data may
identify an individual.

| Obligation | What applies | This release | Pipeline (Polish Week) |
|---|---|---|---|
| APP 1 — open and transparent management | A clearly expressed, up-to-date policy describing how personal information is handled | Handling rules published in this document | Product privacy policy and collection notice per deployed workspace |
| APP 3 — collection of solicited personal information | Collect only what is reasonably necessary for the function or activity | Tools request name, email, amount and reference; no card or bank fields exist | Field-level necessity review per tool before live operation |
| APP 11 — security and destruction | Reasonable steps to protect information, and to destroy or de-identify it once no longer needed | TLS in transit; no credentials or payer data at rest on this server; hashed tenant tags in logs; parameters and results never logged; bounded outputs | Retention schedules with automated destruction and de-identification jobs |
| Breadth of personal information | Combinations of transaction, network and device data may identify someone | Audit lines carry `env:sha256(merchantId)[:12]` rather than a merchant identifier | Re-identification risk assessment across the combined telemetry set |
| Consent and purpose limitation | Specific consent for a stated purpose, rather than a broad "AI use" consent | Sandbox operation with synthetic customers; no real personal information processed | Per-purpose consent capture, and model-provider and cross-border disclosure review |
| Access and correction | Individuals may request access to, and correction of, their personal information | Payer records remain readable and correctable through Pinch; this server stores none | Documented access and correction workflow with response timeframes |
| Notifiable Data Breaches | Assess suspected eligible breaches; notify the OAIC and affected individuals | Per-call audit lines provide the evidence trail for assessment | Written NDB response plan with SIEM alerting on failed-validation spikes and high-frequency patterns |
| Automated-decision transparency — **commences 10 December 2026** | Privacy policies must disclose automated decisions using personal information where the decision significantly affects an individual's rights or interests | No such decision is made: tools draft, preview and explain, and a human approves every write | Disclosure statement, plus a standing prohibition on creditworthiness, hardship and KYC-override decisions by the agent |

## Constrained control plane, not a generic proxy

The design rule is that the server is a bounded financial control plane. Each
tool is narrow, schema-validated and single-purpose, and the following
constraints apply per call.

| Constraint | This release | Pipeline (Polish Week) |
|---|---|---|
| Strict schema on every argument | zod on all 23 tools; `confirm` strictly boolean | — |
| Merchant binding | Every call is bound to the merchant whose credentials the request carries; there is no cross-merchant parameter | Per-tenant scopes issued by a token service |
| Maximum amount | Refund cap `PINCH_MAX_REFUND_CENTS` (default $200.00), server-side, no in-band override | Per-tool and per-tenant amount ceilings for all write tools |
| Frequency | Per-IP token bucket, default 60 req/min | Per-tenant quotas and distributed limiting |
| Currency | AUD only, as integer cents, per the Pinch API | Explicit currency allow-list per tenant |
| Idempotency | Pinch `nonce` on retries and refunds | Caller-supplied idempotency key on every write |
| Permitted states | Retry and cancel operate on states the Pinch API accepts; invalid transitions are rejected upstream | Explicit state allow-list asserted before the call |
| Approval requirement | `confirm: true` required by the tool handler on all ten write tools | Signed approval object (below) |
| Redacted structured response | Results are structured and size-capped; secrets are never echoed | Response classification scan |
| Stable error codes | Errors return `error.message` only, with no header or body context | Enumerated machine-readable error codes |
| Audit event | One structured line per call: tool, outcome, duration, hashed tenant tag | SIEM shipping with anomaly alerting |
| Outbound reach | Exactly two hard-coded hosts (`auth.getpinch.com.au`, `api.getpinch.com.au`); no user-controlled fetch | Egress policy enforced at the network layer |

## Drafting is separated from execution

**Implemented.** Every write tool runs in two phases. Without
`confirm: true` the tool composes the call, validates it and returns a
structured preview; nothing is created. With `confirm: true` it performs one
Pinch write carrying a `nonce`. The guard is in the tool handler rather than in
prompt text, so no host, chat transcript or tool description can bypass it, and
the string `"true"` fails schema validation.

**Pipeline.** A signed, short-lived approval object bound to: payer token,
merchant, amount and currency, payment purpose, payment source token,
approving user, expiry time, and a hash of the draft. The execution path is to
reject any request that does not carry a valid approval object, and a change to
the amount, the receiving merchant or the draft hash is to invalidate it.
Step-up authentication for high-risk operations, and OAuth 2.1 with PKCE,
audience-bound short-lived access tokens, tenant-specific scopes, exact
redirect-URI validation and no token passthrough to Pinch, belong to the same
phase. The current release keeps MCP and Pinch credentials separate and
performs no token passthrough: callers present Pinch credentials, which the
server exchanges for a short-lived Pinch token it holds only in memory.

## Agent authority boundaries

The agent may interpret commercial requirements, recommend a Pinch pattern,
generate a billing blueprint, explain fees and schedules, create drafts and
previews, simulate failures, and identify reconciliation differences.

The agent may not autonomously charge a customer, increase an amount, change
the receiving merchant, refund a settled payment, create or modify payout
details, retry indefinitely, make creditworthiness or financial-hardship
decisions, or override compliance or KYC status. Financial execution stays
deterministic, bounded and reviewable.

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
URL-encoded; there are no user-controlled fetch targets; three runtime
dependencies (`@modelcontextprotocol/sdk`, `zod`, `qrcode`) with a committed lockfile.

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
| Malicious/unofficial servers, supply chain | Three runtime dependencies (`qrcode` added for QR links), committed lockfile, no install scripts; installation from the official repository |
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
| CI security gates | Manual review; three runtime dependencies; committed lockfile | SAST/SCA and MCP-Scan in the pipeline; automated dependency advisories |
| Third-party content | API-returned text passes to the model unmodified; money movement is protected by confirmation guards and caps | Content marking of third-party text fields |
| Platform-to-server requests | TLS; callers authenticated by the Pinch credentials they present | Request signing between known platform hosts |
| Live environment | Refused unless the process is started with `--allow-live` | Operator runbook and allow-listed deployment profile for live operation |
| Approval binding | `confirm: true` required in the tool handler on all ten write tools | Signed short-lived approval object bound to payer token, merchant, amount and currency, purpose, source token, approving user, expiry and draft hash; invalidated by any change to amount, recipient or draft hash |
| Write-tool amount ceilings | Refund cap only (`PINCH_MAX_REFUND_CENTS`) | Per-tool and per-tenant amount and frequency ceilings across all write tools |
| Idempotency | Pinch `nonce` on retries and refunds | Caller-supplied idempotency key accepted and enforced on every write |
| Content classification | None — the boundary is the absence of card and bank fields in every schema, plus unlogged parameters and capped outputs | Inbound, outbound and response classification with remove / tokenise / mask treatments, session-scoped aliases held in a separate vault, and fail-closed behaviour on classification failure |
| Step-up authentication | Not applicable — a single confirmation step at the tool layer | Step-up authentication for high-risk operations, with audience-bound tokens and tenant scopes |
| Retention and de-identification | No payer data at rest on this server | Retention schedules with automated destruction and de-identification jobs (APP 11) |
| Breach response | Per-call audit lines provide an assessment trail | Written Notifiable Data Breaches response plan with defined assessment and notification timeframes |
| Automated-decision disclosure | No automated decision is made; a human approves every write | Disclosure statement ahead of the 10 December 2026 commencement, and a standing prohibition on creditworthiness, hardship and KYC-override decisions by the agent |

## Reporting

Report issues via a GitHub issue on the toolkit repository. Use sandbox
reproductions only; do not include real credentials in reports.
