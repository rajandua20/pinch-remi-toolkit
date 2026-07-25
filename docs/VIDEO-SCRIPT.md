# First Submission — 60-second video script

Format: screen recording with voiceover. Two live demo beats (1-touch setup,
failed-payment recovery), one architecture beat, close. Record the demos in
the LyboAI chat against the sandbox; have the CoachPlus payments panel open in
a second tab.

| t | Screen | Voiceover |
|---|---|---|
| 0–8s | Title card: Remi logo mark + "Remi — the AI payments teammate. Powered by Pinch." | "Small businesses lose money in the payment gaps — billing that takes weeks to set up, and direct debits that bounce quietly. Meet Remi." |
| 8–24s | LyboAI chat: type "Set up my swim school: $59/week for 10 weeks with a $100 deposit, and import these customers…" → show the go-live plan preview → click approve → go-live pack with per-payer setup links | "This is 1-touch setup. Describe your billing, hand over your customer list — Remi designs the structure, provisions it in Pinch, and returns a setup link for every customer. Signup to first collection, one sitting." |
| 24–40s | Chat: "Anything wrong with my payments?" → dishonoured $59 diagnosed (insufficient funds, safe to retry, drafted note) → approve retry | "When a payment fails, Remi knows why, whose fault it is, and whether a retry is safe — then recovers it with your approval. Nothing moves money without a human yes. That guard lives in the server, not the prompt." |
| 40–52s | Split screen: CoachPlus Billing & Payments panel + floating Remi; then the Agent Family gallery (Remi + Remi Front Desk tiles); flash `/meta` with toolsHash | "It ships three ways: embedded in a real product — CoachPlus; as deployable agents for any business on LyboAI, including a customer-facing front desk; and as the first Pinch MCP server — 22 tools, security-mapped to the OWASP GenAI standard." |
| 52–60s | Title card: "Remi. Design · Do · Ask · Fix. Built on Pinch." + URL | "Remi — the payments teammate, powered by Pinch. Every business keeps its own Pinch account; Remi does the work." |

Recording notes:
- Sandbox only; the dishonoured payment `pmt_lOb1nrunAStqfs` and the split are
  already live for the Ask/Fix beats.
- Pre-run the 1-touch preview once so the second take is instant.
- Say "with your approval" audibly in beat 3 — it is the compliance line.
