# First Submission — 60-second video

Structured to the pitch coaching session (AIM + rocket). Constraints applied:
150–190 spoken words (≈ half a page of A4), normal conversation pace, intention
stated in the first five seconds and restated in the last five, screen footage
instead of slides.

## AIM

**Audience** — the Pinch payments team and the judging panel. Both know
payments; neither knows LyboAI or CoachPlus. Nothing in the script assumes
prior knowledge of either product.

**Intention** — in ten words:
> *Remi sets up and fixes a business's payments by conversation.*
Explainable to a year 12 student: you tell it what you charge and who your
customers are, the billing exists; when a payment bounces it tells you why and
fixes it.

**Messages** — two, one each side of the midpoint, and they are the same
customer's story two weeks apart rather than two unrelated features:

1. **Setup** — a week of onboarding forms becomes one paragraph and one
   approval.
2. **Recovery** — a bounced debit is diagnosed from the dishonour code and
   recovered, with a human approval gate enforced server-side.

Deliberately cut and carried by the written submission instead: splits and
party allocation, the customer-facing Front Desk agent, the MCP server tool
surface, the OWASP mapping, and the three demo businesses. Two messages fit in
45 seconds; six do not.

## Script — 166 words

### 0–6s · Intention (before anything else)

**Screen:** Remi mark, then straight into the LyboAI chat. No title sequence.

> "Remi sets up a business's payments by conversation, and fixes them when they
> break. Built on Pinch."

### 6–30s · Message 1 — one-touch setup

**Screen, one unbroken take:** empty swim-school workspace → type the billing
sentence and paste the family list → the go-live plan preview renders (plan
structure, payer count, what will be created) → Approve → the go-live pack
appears with a setup link per family.

> "Here's a swim school with sixty families and nothing set up. I type what I
> charge — fifty-nine a week for ten weeks, hundred-dollar deposit — and paste
> the family list. Remi shows me exactly what it will create. I approve. Sixty
> plans, sixty setup links, one sitting. The last platform that onboarded me
> took a week of forms to get here."

### 30–52s · Message 2 — the payment that bounces

**Screen:** same workspace, later. Chat: "anything wrong with my payments?" →
the dishonoured $59 with its code and plain-English cause → the drafted parent
message → Approve → recovered. Cut to the Pinch dashboard showing the retry.

> "Two weeks later a debit bounces. I ask Remi what's wrong. It reads the
> dishonour code — insufficient funds, safe to retry — drafts the message to
> the parent, and waits. I approve, and it recovers. Nothing moves money
> without that yes. The approval gate sits in the server, not in the prompt."

### 52–60s · Intention restated + the hate

**Screen:** the setup links and the recovered payment side by side, held still.
Closing frame: "Remi. Powered by Pinch." + pinch.lybotechgroup.com

> "Remi sets up payments by conversation, and fixes them when they break. I hate
> being made to spend a week onboarding before I can take one payment. Remi
> removes that. Powered by Pinch."

The closing line answers the metric from the Pinch briefing — what do you hate
about the world, and what does your product remove. It is a real experience,
not a constructed one; say it as one.

## Recording notes

- **Pace:** normal conversation, not presentation. 166 words across 60 seconds
  sits mid-band (150–190). Do not speed up to add content back in — if it runs
  long, cut the "last platform that onboarded me" sentence from Message 1
  rather than compressing delivery, since the same point lands in the close.
- **Anxiety:** Post-it note with a smiley face stuck behind the camera lens, at
  eye line. Talk to it.
- **Movie in their mind:** the sixty-families count, the stack of setup links,
  and the single red failed payment are the pictures. Hold each long enough to
  register; the voiceover states the claim once and does not repeat it.
- **No PowerPoint.** Two title frames only (open mark, close mark); everything
  between them is live screen.
- **Takes:** record each message block as one continuous take — a cut inside
  Message 1 undercuts "one sitting". Pre-run the setup preview once so the
  approval renders instantly on the recorded take.
- **Environment:** sandbox (`test`) only. Seed sixty families before recording
  so the count on screen is real, and use the existing dishonoured payment
  `pmt_lOb1nrunAStqfs` (insufficient-funds) for Message 2.
- **Audible line:** "nothing moves money without that yes" — the compliance
  sentence for this audience. Do not clip it.

## Cut from this video (carried elsewhere)

| Capability | Where it lands instead |
|---|---|
| Split payments / party allocation | Written submission; demo night |
| Remi Front Desk (customer-facing agent) | Written submission; `docs/ACTOR-GUIDE.md` |
| Pinch MCP server, 22 tools, `toolsHash` | Written submission; `SECURITY.md` |
| OWASP GenAI minimum-bar mapping | `SECURITY.md` standards-mapping table |
| Three demo businesses, BYO keys | `demo/DEMO-BUSINESSES.md`; demo night |
| CoachPlus embedded deployment | Written submission; demo night |
