# HANDOVER — Remi × Pinch × CoachPlus × LyboAI

**Written:** 25 July 2026
**Purpose:** start a fresh conversation from this file. Paste the "Kickoff prompt" at the
bottom into a new Cowork session with the same four folders connected.

**Connected folders assumed:**

```
C:\Users\rajan\Claude\Projects\theCoachPlus
C:\Users\rajan\Claude\Projects\lyboai-platform
C:\Users\rajan\Claude\Projects\pinch-remi-toolkit
C:\Users\rajan\source\demolyboai
```

---

## 1. Architecture as decided (do not re-litigate)

**One LyboAI organisation per coaching business is the tenant boundary.** Each org's
`integration_connections` row (catalog_key `mcp`) carries that business's own Pinch
merchant id and secret key. Remi running in that workspace therefore authenticates as
that merchant with no token plumbing and no LyboAI auth change.

CoachPlus is **not** a payment aggregator. Every business registers with Pinch under its
own keys. On CoachPlus those keys live in `coachSecrets/{tenantId}`; resolution is
`getPinchConfigForCoach` → `platformPinchConfig` → `resolvePinchForCoach` returning
`{config, source: "coach" | "platform"}`, gated by `remiAccessAllowed` and the
`PINCH_DEMO_TENANT_ID` single-tenant allowlist.

Coaches get a **locked-down** LyboAI agent: they may change name, avatar, welcome message
and widget theme only. Instructions, guardrails, knowledge, tools, channels, escalation
rules and flows are locked (`MANAGED_AI_CONFIG` in `seedDemoCoaches.ts`). Web widget
channel only.

**Why the short-lived-tenant-token design was rejected:** it cannot be built on today's
LyboAI. There is no caller-token forwarding — `integrations/mcp.ts:271` reads
`const v = credentials[key] ?? config[key];`, `OrchestratorInput` has no token field, and
widget `identify()` attributes are stripped at `routes/widgetPublic.ts:122-130`. Tool
calls execute server-side (`widgetPublic.ts:175` → `messageRouter.ts:429` →
`orchestrator.ts:178` → `toolExec.ts` → `mcp.ts:111 fetch`), so a browser-side
same-origin fetch with a CoachPlus session cookie is not an available auth path.

---

## 2. Work completed and already committed to the user's disk

Delivered and `device_commit_files` returned `"rejected":[]` for all of these.

Earlier batches: the panel-config change removing build-time `NEXT_PUBLIC_*` for the
widget URL and platform Remi key (now in `systemSettings/default`, read at runtime) —
12 files; plus a 30-file CoachPlus batch; plus 4 LyboAI Agent Knowledge Base files.

**This session (9 code files + 5 new files, all parse-clean):**

| File | State |
|---|---|
| `lyboai-platform/apps/api/src/db/seedRemiPresets.ts` | NEW ~330 lines |
| `lyboai-platform/apps/api/src/integrations/mcpOrg.ts` | NEW ~165 lines |
| `lyboai-platform/apps/api/src/ai/toolExec.ts` | 3 edits |
| `lyboai-platform/apps/api/src/ai/orchestrator.ts` | orgId plumbed at :177-182 |
| `lyboai-platform/apps/api/src/routes/bots.ts` | `aiToolSchema` + `superRefine` |
| `lyboai-platform/apps/api/src/db/seedAgentPresets.ts` | imports `REMI_PRESETS` → 10 presets |
| `lyboai-platform/apps/api/src/db/seedCatalog.ts` | +3 actions → 22 |
| `lyboai-platform/apps/api/src/db/seedDemoCoaches.ts` | NEW 496 lines |
| `lyboai-platform/apps/api/package.json` | +`db:seed:coaches` |
| `lyboai-platform/apps/api/demo-coaches.local.json.example` | NEW |
| `theCoachPlus/scripts/seed-demo-coaches.ts` | REWRITTEN 278 → ~900 lines |
| `theCoachPlus/scripts/demo-coaches.local.json.example` | rewritten with new aliases |
| `theCoachPlus/package.json` | +`seed:demo-coaches` |
| `pinch-remi-toolkit/demo/BILLING-PROMPTS.md` | NEW — the prompt pack |

### What the CoachPlus seeder writes, per business

Firebase Auth user + `users/{uid}` (`roles: ["coach","tenant_owner"]`); `tenants/{slug}`
(theme, plan `pro`, addOns, integrations, `defaultLocation` with geohash, `frontDesk`
block, `lyboWidgetKey`); `coachProfiles/{slug}` (locations with lat/lng/geohash,
**top-level `primaryGeohash`**, runtime-resolved `categoryIds`, WWCC + insurance verified
blocks, `sessionTypes` each carrying a `BillingPattern`, gallery, socials, rich
`searchKeywords`, `profileCompleteness: 100`); `availability/{coachId}` (weekly windows +
two dated exceptions, `Australia/Adelaide`); `courses/{slug}-{courseSlug}` (modules,
lessons, dated sessions); `enrolments` (Priya paid / Marcus pending) + `invoices` (GST as
`priceAud/11`) + `bookings` per course session plus one completed and one upcoming service
booking; `coachEnrolments` request docs including the swim minor with a guardian consent
block; `conversations` + two `messages`; `websites/{slug}` published with six sections;
`appConfigurations/{slug}` published; `coachSecrets/{tenantId}` with that business's Pinch
keys.

CLI flags: `--only <slug|vertical>`, `--emit-lybo <path>`, `--widget-keys <path>`.

### The three businesses

| | RoadReady | Elevate | Glenunga |
|---|---|---|---|
| Email | `rajan.dua20+roadready@` | `rajan.dua20+elevate@` | `rajan.dua20+glenunga@` |
| Slug | `roadready-driving` | `elevate-business-coaching` | `glenunga-swim-school` |
| Theme | `#2563eb` | `#7c3aed` | `#0891b2` |
| Location | Norwood SA 5067, 25 km | Adelaide CBD, 40 km | Glenunga SA 5064, 10 km |
| Services | $75 single · $650 pkg ($100 dep + 5×$110/7d) · $190 test day | $1,200/mo retainer (14d notice) · $850 intensive · $0 discovery | $59/wk ×10 term · $45 annual reg · $65 private |
| Course | Test-Ready Intensive $600 | The Pricing Reset $480 | School Holiday Intensive $240 |

Learners shared across all three: `rajan.dua20+priya@gmail.com` (paid),
`rajan.dua20+marcus@gmail.com` (pending). That split mirrors the real Pinch sandbox split
payment `spl_Bh8QfH0Rai`.

**All `+alias` accounts are email/password sign-in only — Google sign-in does not work for
Gmail plus-addresses.**

### Three-step seeding round trip

```bash
# 1. CoachPlus
npm run seed:demo-coaches -- --emit-lybo scripts/lybo-coaches.local.json
# 2. LyboAI (cd lyboai-platform/apps/api) — emits demo-widget-keys.json
npm run db:seed:coaches
# 3. CoachPlus again, to record the widget keys
npm run seed:demo-coaches -- --widget-keys ../lyboai-platform/apps/api/demo-widget-keys.json
```

---

## 3. Findings to report / act on

**A — Remi presets were never applied to lyboai-platform.** Fixed: `seedRemiPresets.ts` +
import + spread → 10 presets, so SETUP.md §5's "now 10 tiles" is now true.

**B — tool count is 22 (13 read + 9 guarded write); the catalog had 19.** Fixed by adding
`pinch_cancel_subscription`, `pinch_payer_statement`, `pinch_settlement_summary`.

**C — `type:'mcp'` ai_config tools never resolved the org's MCP connection.** A deployed
Remi either ran unauthenticated or required the coach's Pinch secret in plaintext inside
`bots.ai_config.tools[].headers`. Fixed via `mcpOrg.ts` + orgId plumbing + the `bots.ts`
schema change. Guard: credential headers attach only on host match, connection headers
win, credential-named tool headers dropped in `buildMcpToolTarget` and rejected by
`superRefine`, and `serverUrl = tool.url || connection.serverUrl` removes the "tools all
point at localhost:8787" failure mode.

**D — seeded coaches were invisible to marketplace radius search.** The old seeder wrote
`locations: []` and never wrote `primaryGeohash`, while `src/lib/data.ts:68` orders radius
queries by `primaryGeohash`. Fixed with `geohashForLocation` plus a top-level
`primaryGeohash`, with the reason in a code comment.

**E — `categoryIds: []` meant profiles were absent from category browse pages.** Fixed:
resolved at runtime by slug lookup (`categories` are matched by `slug`; `categoryIds`
holds generated doc ids), with a logged fallback category creation if no candidate slug
exists.

**F — UNRESOLVED, flagged in code.** No `availability` collection reference exists
anywhere in the staged CoachPlus subset and `src/app/coach/availability/page.tsx` is not
staged. `const COL_AVAILABILITY = "availability"` sits at the top of the seeder with a
docstring saying **this one line is the whole fix** if that page reads a different
collection (for example a tenant-scoped subcollection). **Verify against the real repo.**

**G — the Cloud Run origin allowlist idea does not work as protection.** An
Origin/Referer allowlist cannot gate the MCP endpoint: LyboAI calls it server-to-server
and sends no `Origin`, and any non-browser client can forge one. `pinch-mcp/src/index.ts:228-239`
sets `Access-Control-Allow-Origin` from `opts.corsOrigin` (default `"*"`), and :130
already concedes the hosted endpoint is an open relay with caller creds. What actually
gates access: a **required shared-secret header** (the connector can already send
`authorization`, built from `credentials.authHeader ?? config.authHeader`, so no platform
change is needed) **and/or Cloud Run IAM `--no-allow-unauthenticated``**. Recommendation:
ship both. Still add the `thecoachplus.com` / `lyboai.app` allowlist env var as
defence-in-depth, plus a backlog polish item for MCP tool sign-in, per-company domain
whitelist, contact email and phone.

**Two open LyboAI defects.** `apps/dashboard/src/pages/IntegrationsPage.tsx:42-46` posts
every connector field — including `secret: true` ones — as `config`, so `pinchSecretKey`
lands in plaintext jsonb. And `apps/api/src/routes/widgetPublic.ts:77` (`if (!origin) return;`)
means `allowed_domains` does not constrain non-browser callers.

**MCP audit outcome.** Already satisfied: token cache key SHA-256 hashed, API root a
hardcoded constant `https://api.getpinch.com.au`, no tool accepts a tenant/merchant
identity parameter, no generic passthrough tool, nine write tools `confirm:true`-gated
with a non-overridable refund cap. **Genuinely absent: idempotency keys.**

---

## 4. Next tasks, in order

1. **`pinch-remi-toolkit/SETUP.md` → v4** ("Remi × Pinch — Setup & Rollout Runbook").
   Restore every push/deploy/gcloud command that v3 had, and bring the MCP server and
   toolkit docs level with the recent CoachPlus changes. **This is `pinch-remi-toolkit/SETUP.md`,
   NOT `theCoachPlus/docs/SETUP.md`.** Add the Cloud Run hardening commands from finding G
   (`gcloud run services update --update-env-vars` for the allowlist, plus the shared-secret
   header and `--no-allow-unauthenticated`).

2. **Confirmed doc/code fixes from the two audits:**
   - `pinch-mcp/README.md:15` "7 guarded write tools" → 9
   - `pinch-mcp/SECURITY.md:49` (restated :121, :262) scope "Parameters, results, and
     secrets are never logged" to the pinch-mcp per-call audit line
   - `SECURITY.md:74` extend the CaptureJS surface list to "an application server, the
     Studio, the chat transcript, model context, an MCP request, or telemetry."
   - `SECURITY.md:84,86` widen verification greps to `src/ --include='*.ts' --exclude=smoke.ts`
   - `pinch-mcp/DEPLOY.md:40` relabel `pinch-mcp-coachplus` as demo-tenant-only fallback
   - `agent-pack/frontdesk-payments.md:6` "16-tool kit" → 22; rewrite lines 84-104 for the
     panel-based flow
   - `theCoachPlus/src/components/remi-widget.tsx` correct the embed convention:
     `data-widget-key` / `data-base-url` / `window.LyboWidget`, **not** `window.LYBO_WIDGET_KEY`
   - lyboai-platform: stop the dashboard posting secret fields as `config`; reject
     `pinchSecretKey` from `config` in `mcpTargetFromConnection`; note `widgetPublic.ts:77`

3. **Remaining audit remediation.** Docs: replace CaptureJS wording in `SECURITY.md:73`,
   `hackathon.html:497,527,575`, `arch-boundaries.mmd:13`; restate Row 6 as "no model in
   the path" for CoachPlus; scope the "no parameters logged" claim in `arch-approval.mmd:17`;
   add Pinch + AI/model-provider disclosure and a real complaints address to the CoachPlus
   privacy notice. Code: hash/seal `coachSecrets/{tenantId}` at rest
   (`api/coach/pinch/connect/route.ts:31-33` writes plaintext); redact `{{credentials.*}}`
   before writing `integration_logs.request` (`executor.ts:122`); stop persisting the raw
   user message in analytics (`orchestrator.ts:255`); implement a retention/de-identification
   schedule; add idempotency keys to pinch-mcp write tools.

4. **Awaiting the user:** deploy the four committed LyboAI Agent Knowledge Base files; run
   `npm run typecheck` and `npm run build` on CoachPlus before deploying (no compiler is
   available in the cloud session — see §5).

5. **Carried over:** rewrite SECURITY.md + submission docs in the factual register; commit
   + push then Actions → Deploy; prod dry run; `pinchdemo` LyboAI workspace; Vercel deploy
   `landing/` → `pinch.lybotechgroup.com`; dashboard polish; explicit `coachSecrets/**`
   Firestore deny rule; LyboAI course/blog; workspace-level BYO LLM key; "Calculate Plan
   Payments" + fee-preview tools; open-source strategy for pinch-mcp
   (`@lybotech/pinch-mcp`, Apache-2.0, after 31 Jul).

---

## 5. Environment facts that cost time to rediscover

- **`mcp__remote-devices__device_bash` was unavailable the whole session** ("Workspace
  unavailable"). The only working path to the user's disk is
  `device_stage_files` → edit in the cloud container → `SendUserFile` (yields `file_uuid`)
  → `device_commit_files`. **Try `device_bash` first in a new session — if it works,
  everything below gets much faster.**
- **Staged uploads under `/mnt/user-data/uploads/` are read-only** (`-r--r--r--`). Copy to
  a work dir and `chmod u+w`. The harness tracks read-state per path, so each work-dir copy
  must be `Read` before `Write`/`Edit`.
- **`device_list_dir` with `recursive:true` blew the token limit twice.** Use
  non-recursive listings.
- **No compiler in the cloud container.** Mitigation: `/tmp/parsecheck.js` using
  `typescript@5` at `/home/claude/node_modules/typescript`, running
  `ts.createSourceFile(f, src, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX).parseDiagnostics`
  per file. This catches syntax errors only — **the user still owes a real
  `npm run typecheck`.**
- **The staged `theCoachPlus` upload is a SUBSET** — 77 TS/TSX/MD/JSON files. Absent:
  `src/lib/geo.ts`, `src/lib/search.ts`, `src/lib/ratelimit.ts`, `src/lib/ics.ts`,
  `src/lib/google-calendar.ts`, `src/lib/adapters/email.ts`, `scripts/seed.ts`,
  `scripts/seed-demo-student.ts`, `src/app/coach/availability/page.tsx`, `firestore.rules`.
- **The staged `lyboai-platform/apps/api/src` upload is a SUBSET.** `db/` has only
  seed.ts, seedAgentPresets.ts, seedCatalog.ts, seedTemplates.ts — no `pool.ts`, no
  `migrate.ts`. `integrations/` has only executor.ts + mcp.ts. Known `db/pool.ts` exports
  (inferred from import sites): `pool`, `query`, `queryOne`, `withTx`, `toVectorLiteral`,
  `closePool`.
- **`NEXT_PUBLIC_*` is inlined at build time** — the root cause of the completed
  panel-config change. Widget URL + platform Remi key now live in `systemSettings/default`,
  read at runtime.

### Key code shapes

`Category` (types.ts:207-221): `slug, name, description, icon, parentId: string|null,
synonyms: string[], seoTitle?, ageSuitability: AgeGroup[], modes: CoachingMode[],
requiresWwcc: boolean, featured, order, visible`.

`Invoice` (types.ts:434-438): `number, amountAud, gstAud, totalAud, stripeInvoiceId?,
pdfUrl?, periodStart, periodEnd, paidAt?` plus `TenantScoped` + `BaseEntity`. Written by
`api/pinch/webhook/route.ts:135-141` as doc id `pinch-${payment.id}`.

`TenantIntegrations` (types.ts:189-199): `stripeConnect?{accountId,status}`,
`calendarToken?`, `meetingUrl?`, `zoom?{connected}`, `ai?{provider,apiKey}`, `webhookUrl?`,
`webhookSecret?`, `smsSenderName?`, `googleCalendar?{connected,refreshToken?,email?}`.

`Offer` exists (types.ts:440-451) but no `offers` collection reference is in the staged
subset — deliberately skipped in the seeder.

`secretsService.seal(orgId, name, value)` / `.open<T>(ref, enc): Promise<T|null>` — local
driver = AES-256-GCM into `credentials_enc` (`SECRET_KEY` env); gcp driver = Secret Manager
version name into `credentials_ref`.

---

## 6. Standing constraints — quote-level, still in force

**Writing register for all submission material:** *"they are not your opinions and no
emotional languauage of honest list etc.. facts what standard says, what currently have,
what is in pipeline"*

**Positioning:** "designed to minimise PCI scope", **not** "PCI compliant", unless the
complete implementation has been formally assessed. This security model could itself
become a major differentiator for LyboAI Billing Studio.

**Payment capture:** use **Pinch CaptureJS**, not a self-built payment-entry form, and
never send payment credentials through MCP. CaptureJS tokenises card and bank details in
the browser so they never touch an application server, the Studio, the chat transcript,
model context, an MCP request or telemetry. PCI rules prohibit storing CVV/CVC, PIN/PIN
blocks and related sensitive authentication data after authorisation — even encrypted — and
a customer cannot consent around that prohibition. Never let the agent ask "Please type
your card number and CVV." The agent receives only "payment method connected", source type
and perhaps last four digits. MCP's current specification requires sensitive payment
information to use out-of-band URL elicitation rather than an MCP form.
**No PAN, bank account or CVV fields anywhere in LyboAI.**

**MCP server is a constrained financial control plane, not a generic proxy.** Avoid a
generic tool such as `pinch.call_api(method, endpoint, body)` — that would let prompt
injection turn the agent into an unrestricted API client. Every tool: strict JSON schema,
tenant and merchant binding, maximum amount and frequency constraints, currency
restrictions, idempotency key, permitted payment states, defined approval requirement,
redacted structured response, stable error codes, audit event generation.

**Draft/execute split:** `create_payment_draft` → `validate_payment_draft` →
`approve_payment_draft` → `execute_approved_payment`. The execution tool must reject any
request without a valid, short-lived approval object bound to: payer token · merchant ·
amount and currency · payment purpose · payment source token · approving user · expiry time
· draft hash. Changing the amount or recipient invalidates the approval.

**Authentication:** OAuth 2.1 with PKCE · short-lived access tokens · audience-bound tokens
· tenant-specific scopes · **no token passthrough to Pinch** · separate MCP and Pinch
credentials · exact redirect URI validation · step-up authentication for high-risk
operations · server-side user and merchant verification · restricted outbound access to
approved Pinch endpoints.

**Redaction path:** user input → inbound DLP → model → outbound DLP → MCP tool; MCP
response → response DLP → model → UI. Treatments — **Remove:** CVV, full PAN, passwords,
API secrets. **Tokenise:** payer identity, payment source, bank-account reference.
**Mask:** `Visa •••• 4242`, `payer_7F21`, `$99 AUD`. Session-scoped aliases
(`CUSTOMER_01`) with the alias-to-identity mapping in a separate encrypted vault
inaccessible to the model. Detector covers structured tool arguments, free-text prompts,
uploaded invoices, OCR from screenshots, generated code, model outputs, error messages,
traces and audit logs, support exports. **If classification fails or a probable card
number appears unexpectedly, fail closed and block the request.**

**Data-handling boundaries** (Data class | Agent/LLM | MCP server | Storage):

| Data class | Agent/LLM | MCP server | Storage |
|---|---|---|---|
| Sensitive authentication data (CVV/CVC, PIN, track data) | Never | Never | Never after authorisation |
| Raw payment credentials (full PAN, bank account number) | Never | Avoid entirely | Pinch/tokenisation boundary only |
| Security credentials (Pinch secret, OAuth tokens, API keys) | Never | Memory/KMS retrieval only | Secrets manager |
| Tokenised payment references | Permitted | Permitted | Encrypted |
| Display-safe payment data (brand, source type, last four) | Permitted when necessary | Permitted | Limited retention |
| Personal information (name, email, address, IP, phone) | Redacted or pseudonymised | Only when operationally necessary | Purpose-limited |
| Transaction information | Permitted with pseudonymous customer ID | Permitted | Financial retention policy |
| Unstructured content | DLP scan before use | DLP scan both directions | Avoid raw prompt retention |

**The agent may:** interpret commercial requirements, recommend a Pinch pattern, generate a
billing blueprint, explain fees and schedules, create drafts, simulate failures, identify
reconciliation differences.

**The agent should not autonomously:** charge a customer · increase an amount · change the
receiving merchant · refund a settled payment · create or modify payout details · retry
indefinitely · make creditworthiness or financial-hardship decisions · override compliance
or KYC status. Financial execution should remain deterministic, bounded and reviewable.

**Australian privacy.** Personal information includes more than names: transaction
history, IP addresses, device identifiers, location and combinations of otherwise harmless
data may identify someone. OAIC guidance requires data minimisation and reasonable
protection, destruction or de-identification when information is no longer required. Also:
clear collection notices · specific consent rather than broad "AI use" consent · purpose
limitation · model-provider and cross-border disclosure review · data access and correction
· retention schedules · Notifiable Data Breaches response · automated-decision
transparency requirements commencing 10 December 2026 where personal information
contributes to decisions significantly affecting someone's rights or interests.

**Hackathon demonstration list.** Pinch sandbox and synthetic customers only · CaptureJS or
a Pinch-hosted flow for payment details · no PAN, bank account or CVV fields anywhere in
LyboAI · natural-language billing blueprint generation · deterministic validation · fee
preview · draft-versus-execute separation · explicit approval screen · one simulated
dishonour and permitted retry · redacted logs · a live demonstration of the system blocking
an unsafe request.

**Other:** CoachPlus is not an aggregator — every business registers on Pinch with their
own keys. Do not build what Pinch would obviously build itself. The LyboAI UI/UX identity
refresh is explicitly **off** the hackathon record.

---

## 7. Kickoff prompt for the new conversation

> Read `pinch-remi-toolkit/HANDOVER.md` first — it is the full state of this project,
> including the architecture already decided, what is already committed, the open findings,
> and the standing constraints on register and payment-data handling. Do not re-litigate
> decisions recorded there.
>
> Then pick up task 1 in §4: take `pinch-remi-toolkit/SETUP.md` to v4 — restore every
> push/deploy/gcloud command that v3 had, bring the MCP server and toolkit docs level with
> the recent CoachPlus changes, and add the Cloud Run hardening from finding G. Note this
> is `pinch-remi-toolkit/SETUP.md`, not `theCoachPlus/docs/SETUP.md`.
>
> Before you write anything, verify finding F: check whether
> `theCoachPlus/src/app/coach/availability/page.tsx` reads the `availability` collection or
> something else, and correct `COL_AVAILABILITY` at the top of
> `theCoachPlus/scripts/seed-demo-coaches.ts` if it differs.
