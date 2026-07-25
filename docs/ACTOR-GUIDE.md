# Remi × Pinch — Manual Setup Guide for All Three Actors

This guide describes how each participant in the Remi ecosystem gets set up and
what they can do. It reflects the BYO-keys model: **every business holds its
own Pinch merchant account and API keys**. No platform in this ecosystem
aggregates funds or holds keys on a business's behalf.

The three actors:

| # | Actor | Example | Pinch relationship | Agent |
|---|---|---|---|---|
| 1 | Platform owner | CoachPlus (LyboTech) | Own Pinch account for platform revenue; integrates Pinch as the platform's payments provider | Back-office Remi for the platform's own finances; ships Remi to every business on the platform |
| 2 | Business on the platform | A coach, studio, tutor | **Registers directly with Pinch; owns their keys** | Back-office Remi (Design · Do · Ask · Fix) scoped to their account; configures customer channels |
| 3 | End customer | The coach's client | None — pays via hosted Pinch pages | Interacts with the business's **Remi Front Desk** agent |

---

## Actor 1 — Platform owner (e.g. CoachPlus)

**Goal:** offer Pinch-powered payments plus the Remi agent line inside your
product, and run your own money through the same tooling.

1. **Pinch account.** Register at https://getpinch.com.au → create an app in
   the portal → collect test (`app_test_…` / `sk_test_…`) and live keys. Start
   everything in `test`.
2. **Host the toolkit.** Deploy `pinch-mcp` (Cloud Run: `gcloud run deploy
   pinch-mcp --source . --allow-unauthenticated`). One hosted endpoint serves
   every actor — callers bring their own keys per request (`x-pinch-*`
   headers), the server stores nothing. Verify `GET /meta` (22 tools, pinned
   `toolsHash`).
3. **Integrate the product.** In your platform codebase, use the library
   directly (the CoachPlus pattern: `pinch-client.ts` + webhook handler with
   HMAC verification, auto GST invoices, dishonour → past-due status) and set
   platform deployment env: `PINCH_MERCHANT_ID`, `PINCH_SECRET_KEY`,
   `PINCH_ENV`, `PINCH_WEBHOOK_SECRET`, provider flags. Register your webhook
   endpoint in the Pinch portal.
4. **Your own back office.** On LyboAI, deploy **Remi** from the Agent Family
   and connect the MCP integration with **your platform's keys** (fields:
   serverUrl, Pinch Merchant ID, Pinch Secret Key, env). Ask "how are we
   doing?" about your own revenue.
5. **Ship agents to your businesses.** Surface two paths in your product:
   "Connect Pinch" (each business enters their own keys — see Actor 2) and
   "Create your customer agent" (guided LyboAI deploy of Remi Front Desk,
   embedded into the website/app your product already builds for them).

> Note on *platform mode*: pinch-mcp also supports
> `x-pinch-current-merchant` (Pinch Managed Merchants) for platforms licensed
> by Pinch to operate sub-merchants. CoachPlus does **not** use this — it is
> documented for platforms that have that arrangement with Pinch.

## Actor 2 — Business on the platform (e.g. a coach)

**Goal:** own your merchant relationship, let Remi run your payments back
office, and put a payments front desk in front of your customers.

1. **Register with Pinch directly** (https://getpinch.com.au). Complete their
   onboarding; you own the account, the settlement bank account, and the API
   keys. Copy your test keys first.
2. **Connect Pinch in the platform product** (CoachPlus → Billing & Payments →
   *Connect Pinch*): paste your Merchant ID and Secret Key. They are stored
   encrypted against your profile and used only server-side. From here your
   Billing & Payments panel, invoices and webhooks run against **your**
   account. *(Demo note: platform and demo coach currently share one set of
   keys via deployment env; the per-coach key form is the same flow.)*
3. **Your back-office Remi** now works in context: design billing ("10-week
   term, $59/week, $100 deposit"), 1-touch import your customer list, ask
   money questions, approve failed-payment recoveries. Every money action is
   preview → your approval → execute.
4. **Optional — run your own agents on LyboAI:** create a LyboAI account,
   deploy **Remi** (back office, for you) and **Remi Front Desk** (for your
   customers) from the Agent Family, and connect each with **your own Pinch
   keys** in the MCP integration. Publish, copy the widgetKey.
5. **Put the front desk on your channels.** In CoachPlus you already build a
   website/app — enable the payments agent there (widget embed with your
   widgetKey and allowed domains). Your customers can now pay and ask billing
   questions 24/7.

## Actor 3 — End customer (the coach's client)

**No setup.** On the business's website, app or messaging channels they meet
the business's Remi Front Desk, which can:

- Take a payment: the agent confirms the amount, then issues a **hosted Pinch
  payment link** — card/bank details are entered only on Pinch's secure page,
  never in chat.
- Check a payment they made (by reference) and explain its status in plain
  English.
- Answer billing questions (due dates, how direct debit works, updating
  details) from the business's knowledge base.

Privacy and safety are structural: the front-desk agent has a restricted tool
set (no account-wide reads, no refunds), serves one customer per conversation,
and hands refunds/disputes to a human.

---

## Current implementation status

| Capability | Status |
|---|---|
| pinch-mcp hosted, BYO-keys per request, 22 tools | Implemented |
| LyboAI: Remi + Remi Front Desk presets, per-org Pinch key fields on the MCP connector | Implemented (re-seed to load) |
| CoachPlus: Pinch as payments provider, billing panel, webhook/GST invoices, Remi widget seam | Implemented |
| CoachPlus: per-coach "Connect Pinch" key entry (encrypted per profile) | In development — demo uses platform deployment keys |
| CoachPlus: "Create your customer agent" guided LyboAI provisioning | In development (manual path works today) |
| Platform mode (`Current-Merchant`) for licensed aggregator platforms | Implemented in pinch-mcp; not used by CoachPlus |
