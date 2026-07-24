# Remi × Pinch — Setup Instructions (Rajan's runbook)

Everything needed to activate the build, in order. Sandbox creds: app `Remi – AI Payments Agent` → **test** keys only (`app_test_kPR4h10nCQrQ8a` / your `sk_test_…`).

---

## Phase 0 — Security (2 min)
1. web.getpinch.com.au → API Keys → "Remi – AI Payments Agent" → **regenerate the LIVE keys** (they were exposed in a screenshot). Do not touch the test keys.

## Phase 1 — Sandbox demo data (3 min) — ✅ mostly done
- ✅ Dishonour payment done: `pmt_lOb1nrunAStqfs` (dishonoured, insufficient-funds) — Remi's hero data exists.
- Optional: pay **one** studio-split share so the exposure story reads well — Priya Fitness $600: https://pay.getpinch.com.au/pay/plk_0JEUcaqF0qjn2x (test card `4242 4242 4242 4242`, any expiry/CVC). Leave Marcus ($360) and Southside ($240) unpaid.
- Spare dishonour link if ever needed: https://pay.getpinch.com.au/pay/plk_FQbR4SXNx7hdZr

## Phase 2 — CoachPlus local (10–15 min)
1. Append to `theCoachPlus\.env.local`:
```
# ── Pinch (sandbox) ──
PINCH_MERCHANT_ID=app_test_kPR4h10nCQrQ8a
PINCH_SECRET_KEY=<your sk_test_... key>
PINCH_ENV=test
PAYMENTS_PROVIDER=pinch
SUBSCRIPTION_PROVIDER=pinch
```
2. Run:
```powershell
cd C:\Users\rajan\Claude\Projects\theCoachPlus
npm run typecheck    # expect exit 0
npm test             # expect green
npm run dev
```
3. Browser → localhost:3000 → coach login → **/coach/payments** ("Payments & Remi" in nav).
   Expect: digest strip with live sandbox numbers + a needs-attention card diagnosing the $59 insufficient-funds payment, with Approve buttons.
4. Any errors → paste them to Claude verbatim; do not debug solo.

## Phase 3 — pinch-mcp local (5–10 min)
```powershell
cd C:\Users\rajan\Claude\Projects\pinch-remi-toolkit\packages\pinch-mcp
npm install
copy .env.example .env
notepad .env                      # PINCH_MERCHANT_ID, PINCH_SECRET_KEY (test), PINCH_ENV=test
npm run build                     # expect clean
node dist/index.js --selftest     # expect "18 registered tools"
npm run smoke                     # expect SMOKE COMPLETE ✔ + annotated diagnosis
node dist/index.js --http 3333    # leave running (serves LyboAI)
```
Optional — Claude Desktop demo: add the stdio config from `packages\pinch-mcp\README.md` ("Claude Desktop" section), restart Claude Desktop, ask *"who owes on the studio rent split?"*.

## Phase 4 — LyboAI activation (15 min)
1. In chat, say **"merge the seeds"** → Claude produces fully-merged `seedCatalog.ts`/`seedTemplates.ts` (all 4 patches: catalog → templates → support-remi → split) and commits them. (Manual alternative: follow `docs\pinch-remi\REPORT*.md`; insertion points are marked in each patch.)
2. Then:
```powershell
cd C:\Users\rajan\Claude\Projects\lyboai-platform\apps\api
npm run typecheck
npm run db:seed
```
3. Boot the platform (your usual docker-compose/dev flow), dashboard + API up.
4. Dashboard → Integrations → connect **MCP** → serverUrl `http://localhost:3333/mcp` (if the API runs in Docker: `http://host.docker.internal:3333/mcp`) → **Test connection** (expect success, 18 tools).
5. Bots → **New from template → "support-with-remi"** → name **"CoachPlus Support Agent"** → publish draft → live.
6. Try in the widget/chat: *"how did we do this week?"* · *"who still owes on the studio rent split?"* · *"bill Sarah $59/week for the 10-week term with a $100 deposit"* (expect preview → approve → creates).

## Phase 5 — Hosted CoachPlus against the sandbox (optional, better for demo)
1. Ask Claude to **"prep the deploy"** (commit for your approval + the `next.config.mjs` env-inline edit).
2. ⚠️ Amplify injects env at BUILD, not SSR runtime — all new server vars (`PINCH_MERCHANT_ID`, `PINCH_SECRET_KEY`, `PINCH_ENV`, `PAYMENTS_PROVIDER`, `SUBSCRIPTION_PROVIDER`, `PINCH_WEBHOOK_SECRET`) must be in the `env` block of `next.config.mjs`, like the existing server vars.
3. Amplify console → Environment variables → set the test values → redeploy.
4. Webhooks (now possible with a public URL): register `https://<your-domain>/api/pinch/webhook` in Pinch, put the returned `whsec_…` into `PINCH_WEBHOOK_SECRET`, redeploy. This completes enrolment auto-finalisation.
5. After the hackathon: flip `PAYMENTS_PROVIDER`/`SUBSCRIPTION_PROVIDER` back until go-live.

## Phase 6 — Hackathon admin (5 min)
1. `#hackathon-help-2026`: post the solo/team question (draft in chat). `#hackathon-general-2026`: teammate post.
2. Optional: RSVP Demo Night — https://luma.com/m5baswti

## Phase 7 — Commit & push to GitHub (15 min)

> **Golden rule first:** never commit secrets. Before every commit, run `git status` and confirm no `.env` / `.env.local` files are staged. All three repos' `.gitignore` should cover them (the toolkit one now does).

### 7a — pinch-remi-toolkit (new repo — init required)
```powershell
cd C:\Users\rajan\Claude\Projects\pinch-remi-toolkit
git init -b main
git add .
git status                       # VERIFY: .env NOT listed (only .env.example)
git commit -m "pinch-mcp v6: 18-tool Pinch MCP server + Remi toolkit (hackathon build weekend)"
gh repo create pinch-remi-toolkit --private --source . --push
# (no gh CLI? create an empty private repo named pinch-remi-toolkit on github.com, then:)
#   git remote add origin https://github.com/<you>/pinch-remi-toolkit.git
#   git push -u origin main
```

### 7b — theCoachPlus
```powershell
cd C:\Users\rajan\Claude\Projects\theCoachPlus
git checkout -b pinch-remi
git add .
git status                       # VERIFY: .env.local NOT staged
npm run typecheck                # gate before committing
git commit -m "Pinch integration + Remi payments panel (hackathon build weekend)"
git push -u origin pinch-remi
```
- Keep the work on the `pinch-remi` branch until you're ready to deploy; **merging/pushing to the Amplify-connected branch (main) triggers a production build** — do that as part of Phase 5, after the `next.config.mjs` env-inline edit and Amplify env vars are in place.

### 7c — lyboai-platform
```powershell
cd C:\Users\rajan\Claude\Projects\lyboai-platform
git checkout -b pinch-remi
git add apps/api/src docs/pinch-remi
git status                       # VERIFY: no .env files staged
git commit -m "Generic MCP bridge + Remi payments agent templates (hackathon build weekend)"
git push -u origin pinch-remi
```
- ⚠️ This repo has GitHub Actions (`ci.yml`, `deploy.yml`) — **stay on the feature branch** unless you intend to trigger CI/deploy; check which branches the workflows fire on before merging.

### 7d — Hackathon note
Private repos are fine — organisers may request temporary access for verification only (per T&Cs; ownership unaffected). Keep commits during the build window so the git history itself evidences what was built this weekend.

## Report back to Claude
① typecheck/test results (both repos) ② `/coach/payments` rendering with real data? ③ LyboAI test-connection + template chat working? ④ Slack's answer on solo.

## Key dates
- **Sun 26 Jul 19:00 AEST** build ends · **20:00** First Submission (60-sec YouTube video + prototype): https://getpinch.com.au/hackathon-first-submission
- 27–31 Jul Polish Week (no new features) · **31 Jul 23:59** Final Submission (2–3 min pitch video)
- 3 Aug finalists · **10 Aug Demo Night**

## Troubleshooting quick hits
- `payments not configured` on hosted → env vars not inlined in next.config (Phase 5.2).
- MCP test-connection fails from Docker → use `host.docker.internal`, and keep `--http 3333` running.
- Sandbox 400 on payers → bank accounts must be 3–9 digits; payment links require `allowedPaymentMethods`.
- Scheduled direct-debit failures only appear after the overnight run — card-path (payment link) dishonours are instant.
