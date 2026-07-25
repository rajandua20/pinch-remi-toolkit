# Demo Business Packs — three ready-to-run examples

Three example businesses for demonstrating the full actor model: each gets its
own Pinch app (own MerchantId + secret key), its own back-office **Remi** and
customer-facing **Remi Front Desk** on LyboAI, and a 1-touch onboarding you can
run live in chat. All sandbox (`test` env) — no real money.

Per business below: (a) the Pinch app to create, (b) the 1-touch onboarding
prompt to paste into Remi, (c) the raw `pinch_onboard_business` payload (for
the playground/REST demo), (d) starter knowledge for the Front Desk agent.

Setup per business (5 minutes each):
1. Pinch portal → create app (name below) → copy `app_test_…` + `sk_test_…`.
2. LyboAI → deploy **Remi** from the Agent Family → Integrations → MCP →
   serverUrl + THIS business's keys → Test (22 tools).
3. Paste the onboarding prompt → review the go-live plan → approve.
4. Deploy **Remi Front Desk** the same way (same keys), add the FAQ entries,
   publish, embed the widget on the demo site/channel.

---

## 1. RoadReady Driving School (driving instructor)

**Pinch app name:** `RoadReady Driving School (demo)`
**Billing model:** per-lesson payment links + a 10-lesson prepaid package with
deposit; learners often pay per lesson, parents often buy packages.

**Onboarding prompt (paste into Remi):**
> Set up RoadReady Driving School. Billing: single lessons $75 each paid by
> payment link; a 10-lesson package at $650 with a $100 deposit and the
> balance over 5 weekly instalments. Import these customers and enrol the
> package customers into the package: Liam Nguyen liam.nguyen@example.com
> 0400 111 222 (package), Sophie Carter sophie.carter@example.com (package),
> Aarav Patel aarav.patel@example.com (single lessons).

**Raw payload (`pinch_onboard_business`):**
```json
{
  "businessName": "RoadReady Driving School",
  "components": [
    { "kind": "package", "name": "10-Lesson Package", "amountCents": 11000, "interval": "weekly", "termPayments": 5, "depositCents": 10000 },
    { "kind": "per_session", "name": "Single Lesson", "amountCents": 7500 }
  ],
  "payers": [
    { "firstName": "Liam", "lastName": "Nguyen", "email": "liam.nguyen@example.com", "mobile": "0400111222" },
    { "firstName": "Sophie", "lastName": "Carter", "email": "sophie.carter@example.com" },
    { "firstName": "Aarav", "lastName": "Patel", "email": "aarav.patel@example.com" }
  ],
  "assignPlan": "10-Lesson Package"
}
```
*(Component kinds are the real schema: `membership | term | package |
per_session | one_off | split`. `amountCents` is per-collection for
package/term (deposit separate); always run without `confirm` first and read
the preview.)*

**Front Desk FAQ:**
- Q: How do I pay for lessons? → A: Single lessons are $75 — ask here and I'll
  send a secure payment link. The 10-lesson package is $650 ($100 deposit,
  balance over 5 weeks).
- Q: What if I miss a lesson? → A: 24 hours notice reschedules free; late
  cancels forfeit the lesson. Ask me to check any payment you've made.
- Q: Do you offer test-day packages? → A: Yes — test-day car hire + 1 hour
  warm-up is $190; I can send a link.

**Fix-demo seed:** after onboarding, create one $75 payment link and pay it
with a dishonour-marked card to give this business its own failed payment.

---

## 2. Elevate Business Coaching (business coach)

**Pinch app name:** `Elevate Business Coaching (demo)`
**Billing model:** monthly retainers (recurring), one-off strategy intensives,
and an invoice-style split for a co-delivered workshop.

**Onboarding prompt:**
> Set up Elevate Business Coaching. Billing: a Growth Retainer at $1,200/month
> recurring; a Founder Intensive one-off at $850. Import these clients and put
> the retainer clients on the Growth Retainer: Priya Sharma
> priya.sharma@example.com (retainer), Marcus Webb marcus.webb@example.com
> (retainer), Dana Kim dana.kim@example.com (intensive only).

**Raw payload:**
```json
{
  "businessName": "Elevate Business Coaching",
  "components": [
    { "kind": "membership", "name": "Growth Retainer", "amountCents": 120000, "interval": "monthly" },
    { "kind": "one_off", "name": "Founder Intensive", "amountCents": 85000 }
  ],
  "payers": [
    { "firstName": "Priya", "lastName": "Sharma", "email": "priya.sharma@example.com" },
    { "firstName": "Marcus", "lastName": "Webb", "email": "marcus.webb@example.com" },
    { "firstName": "Dana", "lastName": "Kim", "email": "dana.kim@example.com" }
  ],
  "assignPlan": "Growth Retainer"
}
```

**Extra demo beat (splits):** "Split the $1,800 workshop venue + catering cost
three ways between me, priya.sharma@example.com and marcus.webb@example.com —
40/30/30." → allocation preview → per-party links → `pinch_get_split_status`
for the exposure story.

**Front Desk FAQ:**
- Q: How does the retainer work? → A: $1,200/month by direct debit, pause or
  cancel with 14 days notice. I can send your setup link.
- Q: Can I pay an invoice here? → A: Yes — tell me the amount and what it's
  for, I'll confirm and send a secure link.
- Q: Do you invoice companies? → A: Yes — links carry your company reference;
  receipts are emailed automatically.

---

## 3. BlueFin Swim School (swimming school)

**Pinch app name:** `BlueFin Swim School (demo)`
**Billing model:** the classic term model — weekly debits over a 10-week term
with an annual registration fee; multiple children per family.

**Onboarding prompt:**
> Set up BlueFin Swim School. Billing: Term 3 swimming is $59 per week for 10
> weeks per child, plus a $45 annual registration one-off. Import these
> families and enrol them in Term 3: Emma Wilson emma.wilson@example.com
> 0400 333 444, Jack Wilson via emma.wilson@example.com, Chloe Martinez
> chloe.martinez@example.com, Noah Chen noah.chen@example.com.

**Raw payload:**
```json
{
  "businessName": "BlueFin Swim School",
  "components": [
    { "kind": "term", "name": "Term 3 Swimming", "amountCents": 5900, "interval": "weekly", "termPayments": 10 },
    { "kind": "one_off", "name": "Annual Registration", "amountCents": 4500 }
  ],
  "payers": [
    { "firstName": "Emma", "lastName": "Wilson", "email": "emma.wilson@example.com", "mobile": "0400333444" },
    { "firstName": "Chloe", "lastName": "Martinez", "email": "chloe.martinez@example.com" },
    { "firstName": "Noah", "lastName": "Chen", "email": "noah.chen@example.com" }
  ],
  "assignPlan": "Term 3 Swimming"
}
```

**Front Desk FAQ:**
- Q: How do term fees work? → A: $59/week per child, debited weekly across the
  10-week term. Makeup classes for missed weeks per our policy.
- Q: We're mid-term — do we pay the full term? → A: Fees are pro-rated from
  your start week — ask me and I'll confirm the amount before any payment.
- Q: My payment failed, what happens? → A: No stress — it retries after we
  contact you, or I can send a fresh payment link. Ask me to check the status.

**Fix-demo:** BlueFin doubles as the CoachPlus demo coach (this mirrors the
existing CoachPlus scenario — term sub + the $59 dishonour story).

---

## Demo storyline across the three (for judges/stakeholders)

1. **Three businesses, three Pinch apps, three keys** — open LyboAI, show three
   orgs each with Remi connected to a different app: proof of BYO-keys
   multi-tenancy on one hosted pinch-mcp endpoint.
2. **1-touch each** — three different billing models (per-lesson package,
   retainer, term) provisioned by describing them in a sentence.
3. **One failure, one recovery** — RoadReady's dishonoured lesson payment:
   diagnose → approve → recover.
4. **The customer side** — BlueFin's Front Desk on the CoachPlus-built site:
   a parent asks "what do I owe?" and pays by hosted link.
