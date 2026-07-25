# Remi × Pinch — Demo Runbook

What to demo, how to demo it, and what to expect. Built for a live 5–10 minute
walkthrough (judges / investors / the Pinch team). Everything runs against the
**Pinch test environment**. Times are honest — where a thing has a caveat, it's
called out so nothing surprises you on stage.

> **Naming aside, if asked:** *Remi* is named for **remittance** — the safe
> movement of money is the one job it exists to do. `pinch-mcp` is the tool;
> **Remi** is the teammate that uses it.

---

## 0. Pre-flight (do this before you present)

1. **pinch-mcp is live.** `curl https://<url>/healthz` → `{"ok":true}` and
   `curl https://<url>/meta` → `"toolCount":23`. If not, redeploy (SETUP §3).
2. **`PINCH_MCP_URL`** is set in CoachPlus (Amplify + `.env.local`) and points at
   `https://<url>/mcp`.
3. **Smoke test passes:** `node demo/test-mcp.mjs` with a set of Pinch test keys →
   all green.
4. **Logged in** to CoachPlus as a demo coach (a business with its own Pinch keys
   in `coachSecrets`), on `/coach/payments`.
5. Have the **test card** handy: `4242 4242 4242 4242`, any future expiry/CVC.
6. Keep the **pre-seeded artifacts** as a fallback: split `spl_Bh8QfH0Rai`,
   dishonour `pmt_lOb1nrunAStqfs`, marked link `plk_FQbR4SXNx7hdZr`.

**One honest caveat to hold in mind:** the Pinch sandbox does **not** fast-forward
an overnight direct debit via the API (Time-Travel is accepted but doesn't flip
scheduled DD). So demonstrate a *dishonour* through the **synchronous payment-link
path** (a `#code` marker + the test card), not by advancing the clock.

---

## 1. The MCP server & its guardrails  *(≈1 min — the foundation)*

**Say:** "The base is the first MCP server for Pinch — 23 tools, and every write
is confirm-guarded in the tool layer, not the prompt."

**Do:** On the landing playground (or Claude Desktop), call a write tool **without**
`confirm` — e.g. `pinch_create_refund`.

**Expect:** a structured **preview** (`preview: true`, `wouldDo: …`) and **no API
call**. Re-call with `confirm:true` to execute. Mention the refund cap and that the
public endpoint **refuses `live`**.

---

## 2. Remi designs the billing  *(≈1.5 min — Design)*

**Say:** "A coach describes their pricing in plain English; Remi turns it into a
deterministic billing blueprint and sets it up — no dev work."

**Do:** In Remi (LyboAI) or the playground:
> "Set up my swim school: $59/week for 10 weeks with a $100 deposit, direct debit."

**Expect:** a blueprint preview (deposit + 10 instalments, first/last dates, term
total, indicative fees), then on approval a **Pinch plan + subscription**. If the
payer has no stored method you'll see `pendingSetup: true` + a `setupLink` — that's
the correct two-step (pay the link to store the bank account, then it collects).
This is the **direct-debit term** demo.

---

## 3. CoachPlus, in-platform  *(≈3 min — the platform story)*

The platform now does these itself (calling the MCP engine). Use the **Payments
simulator** so it's fast and reliable on stage.

**3a. Mock mode — instant, no keys, shows Remi detecting issues.**
`POST /api/coach/finance/simulate { "mode": "mock" }` (or the simulator button).
**Expect:** a scripted scenario + **Remi's findings** — 3 dishonoured payments
(insufficient-funds / expired-card / blocked-by-bank) each with plain-English
diagnosis, a **silently-stalled subscription** (no collection in 39 days), and a
**split** with the largest outstanding exposure named. This is the "Remi catches
what you'd miss" moment.

**3b. Sandbox mode — real Pinch artifacts.**
`POST /api/coach/finance/simulate { "mode": "sandbox", "scenario": "all" }`.
**Expect:** real ids/links back — a `#insufficient-funds` payment link, a term
subscription, a 3-way split, and a discounted collect (WELCOME20). Pay the marked
link with `4242…` → it **dishonours immediately** and shows up in the
needs-attention feed with a retry.

**3c. Discount code on a customer payment.**
`POST /api/coach/finance/act { "action": "collect", "email": "...", "amountCents": 5900, "description": "Intro session", "discountCode": "WELCOME20", "confirm": true }`.
**Expect:** the hosted link is created for **$47.20** (20% off $59), the code +
saving recorded. A 100%-off code activates without any Pinch charge.

**3d. Refund / cancel (preview first).**
`POST /api/coach/finance/act { "action": "refund", "paymentId": "pmt_...", "confirm": false }` → preview (capped);
`confirm:true` executes. Same shape for `cancel_subscription`.

---

## 4. QR to get paid  *(≈45 sec — the "anyone can pay" moment)*

**Do:** Call `pinch_create_payment_qr` (via Remi or the coach flow) for a $59
session with a `vendorEmail`.

**Expect:** a hosted link **plus a scannable PNG QR**, and a **vendor-notification
tag** in the response. Scan it with a phone → Pinch's hosted checkout. Note: the
"payment received" notification is delivered by the CoachPlus webhook on
completion (the MCP server itself never sends outbound mail — egress is locked to
Pinch).

---

## 5. Dishonour → diagnosis → recovery  *(≈1 min — Fix)*

**Say:** "When money doesn't arrive, Remi explains why and fixes it — with a human
in the loop."

**Do:** Open the needs-attention feed (`/api/remi/summary`) after 3b, pick the
failed payment, approve the retry (`/api/remi/act`).

**Expect:** a plain-English diagnosis (ownership: customer / merchant / platform),
a drafted customer message, and — on approval — a **soft** failure retried +3 days
(the `#code` is stripped from the clone so it succeeds), or a **hard** failure
routed to a fresh card link.

---

## 6. Security, if asked  *(≈45 sec — the differentiator)*

**Say:** "The security model is the product. No card or bank field exists anywhere
in the 23 tool schemas — payment details are captured on Pinch's hosted page, never
in the app, the model, the transcript or an MCP request."

**Do (optional):** show the data-handling boundaries on the hackathon page, and
demonstrate the server **blocking an unsafe request** (a write without `confirm`,
or `live` refused).

**Expect:** confirm-guard preview / `live` refusal / capped refund — the guardrails
hold at the tool layer.

---

## What's real vs. what's polish (say it plainly if asked)

- **Real, verified against the sandbox:** subscriptions (weekly/fortnightly/monthly,
  terms, deposits), direct-debit collection, dishonour diagnosis + retry, refunds,
  splits, discounts (reduced-amount), QR links, webhook GST invoices.
- **MCP-backed today:** the CoachPlus payment *actions* call the MCP engine; a
  native direct-REST path is a Polish-Week item.
- **Discounts** are applied as a reduced amount, not a first-class Pinch discount
  object (Pinch has none); 100%-off skips Pinch.
- **Time-Travel** won't fast-forward overnight DD — demo dishonours via the
  synchronous link path (§0).

## If something breaks on stage

- MCP call errors / "PINCH_MCP_URL is not set" → §0 pre-flight; fall back to the
  **mock** simulator (needs no keys) and the pre-seeded artifacts.
- Hosted pay page won't load from a locked network → open it on a phone/hotspot.
- Anything flaky → the landing **playground demo mode** replays captured real
  sandbox outputs offline.
