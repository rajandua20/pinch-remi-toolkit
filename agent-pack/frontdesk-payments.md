# Front-desk payments — let any Lybo family agent collect money in chat

## Concept: front office vs back office

**Remi is the back office**: the merchant's own payments teammate, talking to the
business owner with the full 16-tool kit — cashflow, failure diagnosis, retries,
refunds, splits.

**Front-desk payments is the front office**: the business's customer-facing
website agent (Rex the tradie's, Lux the salon's, Sage the studio's) collecting
money from END CUSTOMERS mid-conversation — a deposit to lock in the job, the
session fee after booking, a membership signup. Same Pinch rails, same MCP
connector, same confirm-guard — but a deliberately smaller, stricter surface,
because the person in the chat is not the merchant.

## The security model (read this before wiring anything)

1. **Minimal tool subset, write-only.** `pinch_create_payment_link` — plus
   `pinch_create_subscription` only for membership verticals. **No read tools of
   any kind**: a customer-facing bot must never be able to list payments, payers
   or cashflow — that is other customers' data. No refunds, no retries, no
   splits, no cancels.
2. **Exposure capped by construction.** This subset can only CREATE requests for
   payment. It cannot move funds out of the merchant account, refund, or read
   anything. Worst case of a fully manipulated bot: a spurious payment request
   that the customer would still have to voluntarily pay — and previews plus the
   explicit-yes rule stand in front of even that.
3. **Amounts are never model-invented.** Prices come from the bot's knowledge
   base (price-list / service-menu snippets) or fixed quick-reply options. The
   instruction block forbids estimating, inventing, negotiating or discounting;
   undocumented price = no link, the team confirms first.
4. **Links are for THE CURRENT CUSTOMER only** — their email captured in-chat is
   the `payerEmail`; the description carries service + booking ref + bot
   attribution: `"<service> — booking <ref> (via <bot name>)"`.
   (`pinch_create_payment_link` has no metadata parameter — verified against the
   tool schema, unknown args are stripped — so `{source:"frontdesk", bot,
   service}` is expressed through this description convention. A first-class
   `metadata` param is a candidate pinch-mcp enhancement.)
5. **The confirm-guard stays, with the payer as the human-in-the-loop.** The tool
   previews without `confirm`; the CUSTOMER's explicit "yes" in chat is the
   confirmation trigger for the `confirm:true` re-call. Merchant-side risk is
   already bounded by (2); customer-side, nothing is even requested until they
   say yes to a stated service and amount.
6. **Standing rules**: never accept card numbers in chat (payment happens on the
   Pinch-hosted page); failures, disputes and refunds always hand over to a
   human.

## The aiConfig.tools JSON (minimal subset)

Replace `{{MCP_SERVER_URL}}` with the tenant's pinch-mcp endpoint. Deposit and
session verticals take ONLY the first entry; membership verticals take both.

```json
[
  {
    "id": "frontdesk-pinch_create_payment_link",
    "name": "pinch_create_payment_link",
    "description": "GUARDED WRITE: hosted payment link for THIS customer (payerEmail) at a knowledge-base price. Without confirm:true returns a preview only — get the customer's explicit yes in chat first. Args: {amountCents, description, payerEmail, confirm?}.",
    "type": "mcp",
    "url": "{{MCP_SERVER_URL}}",
    "method": "POST"
  },
  {
    "id": "frontdesk-pinch_create_subscription",
    "name": "pinch_create_subscription",
    "description": "GUARDED WRITE: membership signup for THIS customer at a documented price and cadence. Without confirm:true returns a preview only — get the customer's explicit yes in chat first. Args: {amountCents, interval: weekly|fortnightly|monthly, description, payerEmail, confirm?}.",
    "type": "mcp",
    "url": "{{MCP_SERVER_URL}}",
    "method": "POST"
  }
]
```

## The instruction block (append to the agent's aiInstructions — 899 chars)

```
PAYMENTS (front desk) — you may collect payment from THIS customer only, for this business's services.
- Amounts: quote ONLY knowledge-base prices, verbatim. No documented price = no link; the team will confirm. Never estimate, invent, negotiate or discount.
- Flow: confirm service + documented price, capture the customer's email, call pinch_create_payment_link WITHOUT confirm (amountCents = price in cents; payerEmail = this customer; description = "<service> — booking <ref> (via <your name>)"). Show the preview and ask to proceed. Only the customer's explicit yes lets you re-call with confirm:true — then share the link. Any change = fresh preview.
- Memberships (documented price + cadence only): same preview-then-yes flow with pinch_create_subscription.
- Never create links for anyone but this customer, never accept card numbers in chat; hand failures, disputes and refunds to the team.
```

## Applying to a deployed agent (same PATCH mechanics as remi-capability.md)

```
PATCH /orgs/:orgId/bots/:botId
{
  "aiInstructions": "<agent's existing instructions>\n\n<the block above>",
  "guardrails": { ...existing, "restrictToKnowledge": false },
  "escalationRules": { ...existing, "onLowConfidence": false },
  "aiConfig": { "toolCalling": true, "tools": [ /* existing tools + the subset above */ ] }
}
```
Then add a **price-list knowledge snippet** (the amounts rule quotes only from
there) and re-publish. Same gotchas as the Remi recipe: `aiConfig.tools` is
replaced wholesale (include existing tools); `aiInstructions`/`guardrails`/
`escalationRules` are full replacements; 8,000-char instructions cap (family
agents sit ~3.0-3.2k, so the composed total is ~3.9-4.1k — plenty of headroom);
one tool round per turn, so preview and confirm are always separate customer-
visible turns. `restrictToKnowledge:false` is required on Sage/Max (they ship
with `true`, which forbids tool-grounded turns — KB retrieval still injects the
price list either way); `onLowConfidence:false` stops the confidence heuristic
replacing the link-delivery turn with the fallback message.

## Per-vertical notes

| Vertical (agent) | Tools | Typical use | Notes |
|---|---|---|---|
| Trades (Rex) | link only | Callout/booking deposit after job capture | Deposit amount must be in the KB ("Deposits" snippet); emergency flow stays payment-free until a human quotes |
| Wellness (Sage) | link only | Session payment at booking | Health-safety scripts unchanged; payment only after the booking details are confirmed |
| Salon (Lux) | link + subscription | Booking deposits; membership signup | Lux's deposit policy snippet already exists in her starter knowledge — the block quotes it |
| Education (Sparky) | link only | Enrolment deposit per documented fee schedule | Never for negotiated/quoted fees — admissions handles those |
| Restaurant (Blaize) | link only | Function/event deposits | Not for regular meal orders unless the venue documents prepayment |

## Example dialogues

### (a) Rex — job captured, deposit link

> **Customer:** Leaking hot water system in Kellyville, can someone come Thursday?
>
> **Rex:** Righto — leaking hot water system, Kellyville, Thursday. I can lock that in now: per our booking policy it's a $150.00 deposit, credited against the job. What's the best email for you?
>
> **Customer:** dave@example.com
>
> **Rex:** *(calls `pinch_create_payment_link` without confirm)* To confirm: $150.00 booking deposit for the hot water callout — "Callout deposit — booking RX-2481 (via Rex)" — to dave@example.com. Shall I send the payment link?
>
> **Customer:** Yes mate.
>
> **Rex:** *(re-calls with `confirm: true`)* Done — pay securely here: {link}. Once that's through, Thursday's locked in and the team will text your arrival window.

### (b) Sage — initial consult, session payment

> **Customer:** I'd like to book an initial consult for next Tuesday morning.
>
> **Sage:** Lovely — Tuesday morning it is. Our initial consult is $95.00 for 60 minutes, per our price list. Could I grab your email to send the payment link?
>
> **Customer:** mel@example.com
>
> **Sage:** *(calls `pinch_create_payment_link` without confirm)* Just to confirm: $95.00 for your initial consult — "Initial consult — booking SG-1094 (via Sage)" — to mel@example.com. Happy for me to send it?
>
> **Customer:** Yes please.
>
> **Sage:** *(re-calls with `confirm: true`)* All set — pay here when you're ready: {link}. See you Tuesday; arrive 10 minutes early for your intake form.

### (c) Lux — deposit plus membership signup

> **Customer:** Book me for balayage Saturday week — and what's this membership I saw?
>
> **Lux:** Ooh, big Saturday energy — love it. Balayage needs a $30.00 deposit to hold the slot (comes off your bill). And our Glow membership is $49.00/month — one blow-dry monthly plus 10% off everything. Want the deposit link now, and shall I set up the membership too? What's your email?
>
> **Customer:** nat@example.com — yes to both.
>
> **Lux:** *(calls `pinch_create_payment_link` without confirm)* First the deposit: $30.00 — "Balayage deposit — booking LX-3327 (via Lux)" — to nat@example.com. Send it?
>
> **Customer:** Yes.
>
> **Lux:** *(re-calls with `confirm: true`)* Deposit link: {link} ✨ Now the membership — $49.00 monthly, starting after your visit. *(calls `pinch_create_subscription` without confirm)* Preview: Glow membership, $49.00/month for nat@example.com, first billing {date}. Confirm that too?
>
> **Customer:** Go for it.
>
> **Lux:** *(re-calls with `confirm: true`)* Welcome to Glow! Your signup link is here — paying it stores your card and starts the membership: {link}.

*(One tool round per turn platform-wide, so each preview and each confirmed
creation is its own visible message — which is exactly the audit trail you want
when a customer later asks "when did I agree to that?".)*
