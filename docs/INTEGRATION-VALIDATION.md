# CoachPlus ↔ Pinch — integration validation & demo runbook

**Written:** 25 July 2026. **Method:** full read of the CoachPlus payment adapter,
billing/finance/remi/webhook routes, discount logic, and the pinch-mcp tool
surface. Register is factual — what the code does, what it does not, and what is
demonstrable today.

## 1. Verdict

For a demo of **subscriptions, direct debit, and discount codes, the integration
is effectively complete** — every path below is wired to a real Pinch primitive
against the sandbox. Three things are true and should be stated rather than hidden:

1. The **complete recurring feature set** (weekly/fortnightly/monthly, term limits,
   deposit + instalments, splits, refunds, cancellation) lives in the **Remi MCP
   tools**. CoachPlus's own REST routes expose monthly-open-ended subscriptions,
   one-off payment links, and the dishonour retry/recovery flow.
2. **Discount codes are applied as a server-side reduced amount** (a discounted
   sibling Pinch plan for recurring, a reduced link/charge for one-off) — Pinch is
   never sent a discount object. A 100%-off code short-circuits Pinch entirely and
   activates the tenant directly (Pinch has no $0 plan/link).
3. **Time-Travel is wired** (`Time-Travel` header, test env only) but, per the
   team's own sandbox testing, it does **not** reliably fast-forward an overnight
   direct-debit to processed/dishonoured through raw API reads. Demonstrate DD
   dishonour via the **synchronous payment-link path** (a `#dishonour-code` marker
   + the test card) instead of by advancing the clock.

## 2. Capability matrix

| Capability | State | Path | Pinch primitive |
|---|---|---|---|
| One-off payment / hosted link | Implemented | CoachPlus `pinch-client.createPaymentLink` (via `/api/coach/finance`, `/api/remi/act`); MCP `pinch_create_payment_link` | `POST /payment-links`, `POST /payments` |
| Direct debit (bank-account) | Implemented via hosted link | `allowedPaymentMethods` includes `bank-account` on every link; scheduling via `createPayment.transactionDate` + subscriptions | `/payment-links`, `/payments` |
| Payment-source attach (CaptureJS / raw) | Absent by design | No card/bank field anywhere; a stored source is created only when the payer pays a hosted link | Pinch-hosted only |
| Recurring — monthly, open-ended | Implemented | CoachPlus `findOrCreateMonthlyPlan` + `createSubscription` (platform plan/add-on billing, `adapters/payments/pinch.ts`) | `/plans` + `/subscriptions` |
| Recurring — weekly/fortnightly, term limits, deposit+instalments | Implemented (MCP only) | MCP `pinch_create_subscription` (`termPayments`/`endDate`, `depositCents` via `fixedPayments`) | `/plans` + `/subscriptions` |
| Discount codes — one-off, recurring, platform checkout | Implemented (reduced-amount) | `resolvePlatformDiscount` + `discount-math.applyDiscount`; consumed in `billing/checkout` and `adapters/payments/pinch.ts`; course promos via `offers.validateOffer` | Not a Pinch object — discounted amount / sibling plan |
| Discount — 100% off | Implemented (short-circuit) | `discountedCents()===0` → activate tenant directly, redeem code, audit; Pinch never called | — |
| Dishonour retry | Implemented | CoachPlus `/api/remi/act` `retry`; MCP `pinch_retry_payment` (clone +3d, `nonce`, hard-failure warning) | `POST /payments` |
| Refund (capped) | Implemented (MCP only) | MCP `pinch_create_refund` (≤ `PINCH_MAX_REFUND_CENTS`, default $200); CoachPlus `createRefund()` exists but no route calls it | `POST /refunds` |
| Split payments | Implemented (MCP only) | MCP `pinch_create_split` + `pinch_get_split_status` (2–10 parties, one tagged link each) | composition over `/payment-links` |
| Subscription cancel | Implemented (MCP only) | MCP `pinch_cancel_subscription`; CoachPlus cancels only reactively via webhook downgrade | `DELETE /subscriptions/{id}` |
| Webhooks + reconciliation | Implemented | `/api/pinch/webhook`: HMAC-SHA256 verify; `realtime-payment`/`bank-results`; enrolment finalise, tenant `active`/`past_due`, GST invoice `invoices/pinch-{id}`, subscription-cancelled → downgrade | webhook events |
| Dishonour diagnosis | Implemented (both) | 15-code `DISHONOUR_MAP` (plain-English + ownership + retryable) in both clients; powers `/api/remi/summary` | derived |
| Time-Travel / `#code` simulation | Implemented (with caveat) | `Time-Travel` header sent only when test + `PINCH_TIME_TRAVEL`; `#dishonour-code` markers; caveat: header doesn't reliably flip overnight DD via API | sandbox headers |
| Per-tenant BYO keys | Implemented | `resolvePinchForCoach` → `coachSecrets/{tenantId}` first, else platform env; `AsyncLocalStorage` request scoping; `remiAccessAllowed` gate | — |

## 3. Demonstrable use cases (end to end, today)

- **One-off fee / deposit** — `/api/coach/finance` → hosted link → paying it fires
  the webhook → invoice/enrolment side-effects.
- **Platform plan upgrade with a discount code** — `/api/billing/checkout`
  `{planSlug, discountCode}` → discounted monthly plan + subscription + setup link;
  webhook flips the tenant to `active` and writes a GST invoice.
- **100%-off code** — same route; tenant activates directly, code redeemed, Pinch
  untouched.
- **Membership / term billing** (Remi) — `pinch_create_subscription` for
  weekly/fortnightly/monthly, a 10-payment term, or a deposit + instalments;
  degrades to a setup link if the payer has no stored source.
- **Triage + recover a dishonour** — `/api/remi/summary` lists failures with
  plain-English diagnosis and a drafted message → approve → `/api/remi/act` retry
  (soft) or new link (hard).
- **Split a shared bill** (Remi) — `pinch_create_split` → one tagged link per
  party; `pinch_get_split_status` tracks paid/outstanding/failed + exposure.
- **Refund / cancel** (Remi) — `pinch_create_refund` (≤ $200), `pinch_cancel_subscription`.
- **Design / onboard a business** (Remi) — `pinch_design_billing` blueprint,
  `pinch_onboard_business` (import payers + provision + per-payer setup links).
- **Sandbox failure demo** — description `"Demo #insufficient-funds"` + test bank
  account → payment dishonours with that code → appears in the needs-attention feed.

## 4. Recommended demo script (subscriptions · direct debit · discounts · simulation)

1. **Discount on a recurring plan.** Upgrade a tenant on `/api/billing/checkout`
   with a percentage code → show the discounted sibling Pinch plan created at the
   reduced amount, then the 100%-off variant activating with no Pinch call.
2. **Term subscription with deposit** (Remi/playground) — "set up $59/week for 10
   weeks with a $100 deposit" → preview → `confirm:true` → plan + subscription (or
   setup link if source-less).
3. **Direct-debit collection + dishonour** — create a payment link with
   `#insufficient-funds` in the description, pay with the test card `4242 4242 4242
   4242` (synchronous path) → it dishonours immediately → appears in
   `/api/remi/summary` with diagnosis → approve a retry.
4. **Recovery** — soft failure → `retry` (+3 days, `#code` stripped from the clone
   so it succeeds); hard failure → new payment link.
5. **Split** (Remi) — split a studio-rent bill across three parties → track exposure.

> Do **not** rely on `PINCH_TIME_TRAVEL` to fast-forward an overnight direct debit
> to settlement — it is accepted but did not flip scheduled DD via raw API reads in
> sandbox testing. Use the synchronous link path (step 3) for instant dishonours,
> or pre-seed sandbox data (`spl_Bh8QfH0Rai`, `pmt_lOb1nrunAStqfs`).

## 5. Gaps / not yet wired (state honestly; none block the demo)

- Discounts are reduced-amount only, never a Pinch discount object; **no discount
  tool in the MCP** (CoachPlus-only concept).
- CoachPlus's own REST subscriptions are **monthly, open-ended only**; term/deposit/
  weekly billing is reachable only through the MCP tools (Remi).
- **Refund and subscription-cancel are not wired into a CoachPlus route** — both
  exist in the client; demonstrable only through Remi/MCP.
- **No direct payment-source management** — a source-less payer must pay a setup
  link before a subscription can collect.
- **Time-Travel does not reliably fast-forward overnight DD** via the API.
- **Splits are MCP-only** and are a composition over payment links, not a native
  Pinch split.
- Code approximations to note: trials via `startDate` shift (true deferred-first-
  charge trials are post-hackathon); invoice period bounds approximated to the
  event month; `pinch_design_billing` never auto-provisions a platform fee (flagged
  `needsReview`, needs Pinch Managed Merchants); fee figures are sandbox-observed
  and labelled indicative.
