# @pinch-remi/pinch-mcp

An [MCP](https://modelcontextprotocol.io) (Model Context Protocol) server for the
[Pinch Payments](https://getpinch.com.au) API — the Australian payments platform
(direct debit, cards, payment links, plans & subscriptions).

Point Claude Desktop, Cursor, or any MCP-capable platform at it and your AI
assistant can **diagnose failed payments in plain English, spot silently stalled
subscriptions, and prepare recoveries (retries, payment links, refunds) that a
human approves before any money moves**.

- **13 read tools** — payments, failed-payment triage, payers, subscriptions (with
  stall detection), events, a UI-ready cashflow summary, per-payer statements,
  and split-bill status tracking.
- **7 guarded write tools** — payment links, dishonour retries, capped refunds,
  recurring-billing setup/cancellation (plan + subscription lifecycle),
  multi-party bill splits, and a deterministic billing-blueprint compiler.
  Every write requires `confirm: true`; without it the tool returns a structured
  preview and calls **no** API.
- **Dishonour diagnosis map** — every failure code translated to plain English
  with ownership (`customer` / `merchant-config` / `platform`), a recommended
  action, and soft/hard retryability.
- Transports: **stdio** (default) and **Streamable HTTP** (`--http <port>`,
  stateless — for platform integrations).

## Environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `PINCH_MERCHANT_ID` | yes | — | Merchant ID (`mch_...`) or Application ID from the [Pinch API-keys page](https://web.getpinch.com.au/api-keys) |
| `PINCH_SECRET_KEY` | yes | — | Matching Secret Key (`sk_...`) |
| `PINCH_ENV` | no | `test` | `test` (sandbox) or `live`. Same credentials; the base-URL path segment selects the environment |
| `PINCH_CURRENT_MERCHANT` | no | — | `mch_...` of a managed sub-merchant; sent as the `Current-Merchant` header on every call (master credentials required) |
| `PINCH_TIME_TRAVEL` | no | — | RFC3339 UTC timestamp; sent as the sandbox `Time-Travel` header (test env only — never sent in live) |
| `PINCH_MAX_REFUND_CENTS` | no | `20000` | Hard cap for `pinch_create_refund`, in integer cents ($200 default). Larger refunds are rejected outright |
| `PINCH_RETURN_URL` | no | `https://getpinch.com.au` | `returnUrl` for created payment links (Pinch appends `paymentLinkId`/`paymentId` on redirect) |

All amounts everywhere are **integer cents, AUD** (`5900` = $59.00).

## Quickstart

```bash
npm install
npm run build

# stdio MCP server (what Claude Desktop launches)
PINCH_MERCHANT_ID=mch_... PINCH_SECRET_KEY=sk_... npm start

# sanity check without credentials — prints all registered tool names
node dist/index.js --selftest

# end-to-end sandbox smoke test (safe: exits 0 with a message if creds unset)
npm run smoke
```

### Claude Desktop (stdio)

Add to `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "pinch": {
      "command": "node",
      "args": ["/absolute/path/to/packages/pinch-mcp/dist/index.js"],
      "env": {
        "PINCH_MERCHANT_ID": "mch_xxxxxxxxxxxxxxxx",
        "PINCH_SECRET_KEY": "sk_xxxxxxxxxxxxxxxx",
        "PINCH_ENV": "test"
      }
    }
  }
}
```

Restart Claude Desktop, then try: *“Check my Pinch payments — why did Sarah's
payment fail, and what should I do about it?”*

### HTTP mode (platform integration)

```bash
node dist/index.js --http 8787
```

Serves the MCP **Streamable HTTP** transport on `POST http://localhost:8787/mcp`
(stateless — no session affinity needed; safe behind a load balancer), plus a
plain `GET /healthz` liveness probe and a secret-free `GET /meta`
(`{name, version, toolCount, toolsHash, env, corsEnabled}` — `toolsHash` is a
SHA-256 over every tool's name/title/description; pin it to detect any change
to the tool surface). stdio stays active alongside
it. Any MCP client can `initialize` → `tools/list` → `tools/call` against that
URL; this is the endpoint a platform-side MCP connector (e.g. LyboAI) should be
pointed at.

## Hosting for your own platform(s)

> This is an **unofficial community MCP server** for the Pinch Payments API —
> merchants authorise it with their **own** API keys; no credentials are shared
> or proxied by anyone else. Security posture, hardening details, and known
> limitations: see [SECURITY.md](./SECURITY.md). HTTP mode ships with per-IP
> rate limiting (`PINCH_MCP_RATE_LIMIT`, default 60 req/min), a 256 KB body
> cap, slowloris-resistant socket timeouts, per-call audit logging (tool,
> outcome, duration, hashed tenant tag — never params or secrets), tool-result
> size caps (`PINCH_MCP_MAX_RESULT_CHARS`, default 200 000), and a `--bind`
> flag (`--bind 127.0.0.1` for local-only serving; default `0.0.0.0` for
> container platforms). Reviewed against the OWASP GenAI *Secure MCP Server
> Development* guide, Palo Alto's MCP-security analysis, and the SlowMist
> MCP-Security-Checklist — the mapping lives in SECURITY.md.

Three deployment patterns:

1. **Per-platform instance (env credentials)** — one process per merchant or
   platform, credentials via `PINCH_MERCHANT_ID`/`PINCH_SECRET_KEY` env vars.
   The simplest and safest default; what the Quickstart above sets up.
2. **Shared multi-tenant endpoint (header credentials + `--cors`)** — run one
   hosted process (`node dist/index.js --http 8787 --cors`) and let each caller
   bring their own keys per request via headers:
   `x-pinch-merchant-id`, `x-pinch-secret-key`, optional `x-pinch-env`
   (default `test`). Env credentials remain the fallback when headers are
   absent. OAuth tokens are cached per merchant+env (55 min), header secrets
   are never logged, and `--cors` (or `--cors-origin <origin>`) enables browser
   playgrounds by answering OPTIONS preflights. Ideal for a "try the Pinch MCP
   in your browser" playground against the sandbox.
   **Never enable `--allow-live` on a public playground** — without that flag
   the server refuses `x-pinch-env: live` outright, which is the safe default:
   a shared endpoint should only ever touch test data.
3. **Library import** — `buildServer(configOverride?)` is exported from
   `dist/index.js`; embed the fully-wired `McpServer` (all 20 tools) in your
   own Node process and connect whatever transport you like.

## Tool catalog

| Tool | Kind | What it does |
|---|---|---|
| `pinch_health` | read | Verifies credentials: fetches an OAuth token + trivial GET; reports env & ok |
| `pinch_list_payments` | read | Processed payments (or `scheduled:true` for upcoming), filter by status/date |
| `pinch_get_payment` | read | One payment incl. attempts + dishonour detail (+ diagnosis when failed) |
| `pinch_list_failed_payments` | read | Dishonoured payments, each annotated: plain English, ownership, recommended action, soft/hard |
| `pinch_get_payer` | read | One payer incl. stored payment sources |
| `pinch_list_payers` | read | Payers, optional free-text search |
| `pinch_list_subscriptions` | read | Subscriptions, with **silently-stalled detection** (no success in 35+ days, or recent dishonours) |
| `pinch_get_subscription` | read | One subscription |
| `pinch_list_events` | read | Event feed (e.g. `bank-results` — the failed-direct-debit signal) |
| `pinch_cashflow_summary` | read | "How am I doing?" snapshot: collected vs dishonoured (last N days, default 7), upcoming 7/30-day scheduled totals, top 5 payers — stable, UI-card-ready shape |
| `pinch_payer_statement` | read | Statement of account for one payer (by id or email): chronological lines with plain-English dishonour reasons, totals, and an email-ready `statementText` block |
| `pinch_get_split_status` | read | Who's paid / pending / failed on a split bill, exposure risk (largest outstanding party + days), and chase-up actions — reconstructed entirely from Pinch data |
| `pinch_settlement_summary` | read | "See the money": bank transfers with per-transfer line items (settlements, fees, clawbacks) plus the unsettled bucket — collected but not yet transferred |
| `pinch_create_payment_link` | **write** | Hosted checkout link for a payer (matched/created by email) — the re-collection tool |
| `pinch_retry_payment` | **write** | Clones a dishonoured payment into a new scheduled payment (default +3 days); warns on hard failures |
| `pinch_create_refund` | **write** | Full/partial refund, hard-capped by `PINCH_MAX_REFUND_CENTS` |
| `pinch_create_subscription` | **write** | Recurring billing (weekly/fortnightly/monthly) incl. term limits (`termPayments`/`endDate`), deposits, and plan-metadata attribution; degrades to `pendingSetup` + `setupLink` when the payer has no stored payment method (a Pinch requirement) |
| `pinch_cancel_subscription` | **write** | Cancels a subscription (in-flight payments complete, future scheduled payments deleted; payer sources untouched). Permanent — resuming needs a new subscription |
| `pinch_create_split` | **write** | Splits a shared B2B bill across 2–10 parties: one tagged payment link each, by explicit amounts or percentages (largest-remainder allocation — cents always sum exactly) |
| `pinch_design_billing` | **write** | Deterministic billing-blueprint compiler: maps 1–8 structured components to Pinch primitives with schedules, indicative fees, a timeline and review flags; `confirm:true` provisions only the provisionable-now subset |

### The confirm-guard convention

Write tools take a `confirm` parameter. **Unless `confirm` is exactly `true`,
no API call is made** — the tool returns:

```json
{
  "preview": true,
  "wouldDo": "Refund $50.00 of payment pmt_... (partial refund). Cap check passed ($50.00 ≤ $200.00).",
  "params": { "paymentId": "pmt_...", "amountCents": 5000, "...": "..." },
  "note": "Re-call with confirm:true after human approval"
}
```

The intended agent loop: call without `confirm` → show the preview to a human →
on approval, re-call with `confirm: true`. Refunds are additionally capped
(`PINCH_MAX_REFUND_CENTS`) with no in-band override — bigger refunds belong in
the Pinch portal.

## Design: the billing-blueprint compiler

The toolkit follows a **Design / Do / Ask / Fix** model:

- **Design** — `pinch_design_billing` turns a structured billing model into a
  deterministic blueprint (this section).
- **Do** — provisioning and collection tools (subscriptions, links, splits).
- **Ask** — read tools: cashflow summary, statements, split status, settlement
  summary (transfers + unsettled money), listings.
- **Fix** — failure triage: annotated dishonours, guarded retries, refunds.

The AI host (e.g. Remi) extracts the structured model from the merchant's plain
English; `pinch_design_billing` then does everything deterministic — validation,
mapping to Pinch primitives, schedules, indicative fee math (sandbox-observed
rates, clearly labelled), a chronological timeline, and review flags. Nothing is
written without `confirm: true`, and even then only the **provisionable-now**
subset is created (components without a known payer stay event-driven, each with
a ready-made `exampleCall`). A `platformFeePercent` is never auto-provisioned —
it is always flagged `needsReview` (fee retention needs Pinch Managed
Merchants / application fees).

Example — membership + casual sessions + a 10-week term with deposit, 7%
platform fee (`blueprintText` excerpt):

```
BILLING BLUEPRINT — CoachPlus Demo Club
Anchor date: 2026-07-27 · fee estimates are sandbox-observed, indicative — not official pricing

1. Adult membership [membership] → Pinch Plan + Subscription (monthly, ongoing until cancelled)
   $59.00 monthly from 2026-07-27, until cancelled
   per charge: gross $59.00 · est Pinch fee $1.30 · platform fee $4.13 · est net $53.57
   provisioning: event-driven · flags: 7% platform fee NOT applied automatically — see needsReview; ...

2. Casual session [per_session] → Payment link issued per booking (event-driven)
   $30.00 per session, on demand — no fixed dates
   ...

3. U12 Spring skills term [term] → Pinch Plan + Subscription (weekly, ends after 10 payments, deposit via fixedPayments)
   $50.00 deposit on 2026-07-27, then 10 × $45.00 weekly from 2026-08-03 to 2026-10-05 ($500.00 total)
   ...

TIMELINE (first events)
   2026-07-27     $59.00  Adult membership — monthly charge
   2026-07-27     $50.00  U12 Spring skills term — deposit
   2026-08-03     $45.00  U12 Spring skills term — instalment
   ...
FIRST 30 DAYS: gross $289.00 · est net $262.41 · recurring: $59.00/monthly, $45.00/weekly
POLICY: Soft-failure retry after 3 days — matches the insufficient-funds playbook ...
POLICY: Pause maps to cancel + re-subscribe (no native pause in Pinch) ...
NEEDS REVIEW: Platform fee retention (7%) requires Pinch Managed Merchants / application fees ...
```

## Recurring billing patterns (coach revenue models)

`pinch_create_subscription` covers the common coaching/service revenue shapes:

| Pattern | How |
|---|---|
| **Per-session / ongoing** | `interval` + `amountCents` only — bills until `pinch_cancel_subscription` |
| **Term** (e.g. 10-week season) | add `termPayments: 10` (maps to plan `endType: "number-of-payments"`), or `endDate: "2026-09-30"` (maps to `endType: "end-date"`) |
| **Package / deposit + instalments** | add `depositCents` (+ optional `depositDate`, default today) — the deposit is a `fixedPayments` entry on the same plan, collected before the recurring run starts |

Notes:

- The preview shows the full schedule — deposit, N payments of $X, first/last
  dates, and the total collected over the term — before anything is written.
- **Payment-source requirement (verified API behaviour)**: Pinch refuses to
  create a subscription for a payer with no stored payment source. In that case
  the tool returns `pendingSetup: true` plus a `setupLink` that collects the
  first charge AND stores the customer's payment method — re-call the tool once
  it's paid (the plan is already in place and is reused).
- **Multi-instructor attribution**: pass
  `metadata: '{"instructorId":"coach_42"}'` — plan metadata is copied by Pinch
  onto **every payment the plan generates**, so revenue reports can be filtered
  per instructor/venue. Different metadata produces a separate plan (plans are
  matched structurally — name, amounts, term fields, deposit, metadata — and a
  mismatched plan is never reused or edited).

## Split payments (shared-cost splitting)

Whoever fronts a shared bill becomes the group's unpaid lender — split at source
instead. Typical cases: three personal trainers splitting studio rent, two
coaches co-hosting a holiday clinic and splitting the venue + equipment bill, or
clubs co-funding a tournament. `pinch_create_split` divides one bill across 2–10
parties, giving each their own hosted payment link, and `pinch_get_split_status`
tracks who has paid and how much anyone is left carrying.

- **Shares**: explicit `amountCents` per party (must sum to `totalCents` if
  given), or `sharePercent` per party (must sum to 100, requires `totalCents`);
  percentage shares are converted with largest-remainder allocation so the cents
  always sum exactly. No mixing modes within one split.
- **How tracking works — no external storage**: each link's `metadata` carries a
  JSON envelope (`{"split":"spl_...","part":"1/3","totalCents":...,...}`).
  Pinch passes link metadata through to the resulting Payment on completion, so
  `pinch_get_split_status` reconstructs the whole picture from
  `GET /payment-links` + processed payments alone: per-party
  `paid | pending | failed` (failures annotated from the dishonour map),
  `daysOutstanding`, an exposure block (largest outstanding party + risk note),
  and ready-made chase-up actions with each party's link.
- **Caveats**: scanning is capped at 5 pages of links/payments
  (`truncated: true` beyond that); metadata is stored as JSON (the Pinch
  metadata guide requires valid JSON, and Pinch may append its own entries —
  parsing tolerates both).

## Sandbox failure simulation

Everything below is **test-env only** and how the smoke test works:

- **`#<dishonour-code>` markers** — put e.g. `#insufficient-funds` or
  `#invalid-card` anywhere in a payment `description` or a payer's `firstName`
  and the payment will fail with that code once processed. Test card:
  `4242 4242 4242 4242` (any future expiry/CVC). Test bank accounts: any BSB
  works, but the sandbox validates account numbers as **3–9 digits** (e.g.
  `000-000` / `123456` — a 10-digit account number is rejected with a 400,
  despite docs suggesting anything goes).
- **`Time-Travel` header — honest caveat.** The sandbox accepts the header (and
  event dates stamp at the simulated time), but in our live sandbox testing,
  polling reads with `Time-Travel` set did **not** flip a scheduled direct-debit
  payment to processed/dishonoured — the "overnight run" doesn't appear to be
  triggered by raw API reads (the Dev Portal seems to do more). For **instant**
  dishonour testing, prefer the synchronous path: create a payment link with a
  `#code` in the description and pay it with the test card — the failure is
  immediate. Otherwise wait for the real overnight sandbox run. `Time-Travel`
  is ignored in live mode (and this client never sends it in live).
- **Payment links** — `allowedPaymentMethods` is **required** by
  `POST /payment-links` (400 without it; the tool defaults it to both methods).
  Optional `metadata` is passed through to the resulting Payment object — handy
  for correlation. `returnUrl` gets `?paymentLinkId=&paymentId=` appended on
  redirect.
- **Smoke flow** (`npm run smoke`): health → create payer
  `"Demo #insufficient-funds"` with a test bank account → schedule a $59 payment
  for today → prints the Time-Travel instructions → lists failed payments with
  their diagnosis. Exits 0 with `SMOKE SKIPPED — set credentials` when no
  credentials are configured.

## Notes & design decisions

- **Casing tolerance** — Pinch responses are camelCase but event/webhook
  payloads are PascalCase (documented quirk); every response is deep-normalised
  to camelCase before use.
- **Retries** — rate limits are undocumented, so 429/5xx (and network errors)
  are retried twice with jittered backoff; 403 triggers one token refresh.
- **Idempotency** — write tools send Pinch `nonce` values
  (`pinch-mcp-retry-<paymentId>-<date>`, `pinch-mcp-refund-<paymentId>-<cents>`)
  so an accidental double-call cannot double-charge or double-refund.
- **Pagination** — list tools follow the `{page,pageSize,totalPages,totalItems,data[]}`
  envelope up to 5 pages and report `truncated: true` beyond that.
- **Dishonour typing on list items** — `GET /payments/processed` list items carry
  no `attempts[]`/`dishonour` object, only (usually) a flat `dishonourType`
  string (empirical; undocumented). Tools that diagnose failures read that flat
  field first and, when it's absent, fetch `GET /payments/{id}` for the
  attempt-level dishonour — capped at 10 detail lookups per call, with
  `truncatedDetails: true` reported when the cap is hit.
