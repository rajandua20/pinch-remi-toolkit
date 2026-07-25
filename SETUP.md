# Remi × Pinch — Setup & Rollout Runbook (v2 — Sat 25 Jul)

Supersedes v1. Order matters; each phase unblocks the next.

## 0 — Every terminal, first line (Node fix)
```powershell
$env:Path = "$env:APPDATA\nvm\v20.18.0;$env:Path"   # matched node 20 + npm 10 pair
```
Permanent fix later: remove `\nvm\v17.8.0` PATH entries / consolidate on one Node.

---

## 1 — Push all three repos

### 1a. theCoachPlus → main (⚠️ triggers Amplify PROD build)
**First**, Amplify Console → Environment variables — all seven:
```
PINCH_MERCHANT_ID=app_test_kPR4h10nCQrQ8a
PINCH_SECRET_KEY=<sk_test_…>
PINCH_ENV=test
PAYMENTS_PROVIDER=pinch
SUBSCRIPTION_PROVIDER=pinch
PINCH_WEBHOOK_SECRET=whsec_s6aMlYzYW8JZsypJZjdSRztp91KHOmx0
NEXT_PUBLIC_LYBO_WIDGET_URL=<later, when LyboAI prod is up — see 3c>
NEXT_PUBLIC_LYBO_WIDGET_KEY=<later>
```
Then:
```powershell
cd C:\Users\rajan\Claude\Projects\theCoachPlus
npm run typecheck                       # gate
git status                              # .env.local absent; consider gitignoring data\ (PII check!)
git add . && git status && git commit -m "Pinch platform + Remi floating assistant + billing panel"
git push origin main
```
Verify after build: https://thecoachplus.com/coach/payments (digest + dishonoured $59 card; "Billing & Payments" in sidebar).

### 1b. lyboai-platform → main
```powershell
cd C:\Users\rajan\Claude\Projects\lyboai-platform
git checkout main && git pull origin main
git merge pinch-remi --no-edit          # if branch exists; else add/commit on main
git add apps/api/src docs/pinch-remi && git commit -m "Remi agent preset + MCP bridge + merged seeds" 
git push origin main                    # CI runs automatically (typecheck+vitest+build)
```
Note: latest seed files (agent preset + template exports) were committed AFTER any earlier commit — make sure they're included (`git status` before commit).

### 1c. pinch-remi-toolkit → new private repo
```powershell
cd C:\Users\rajan\Claude\Projects\pinch-remi-toolkit
git init -b main
git add . && git status                 # .env must NOT appear (only .env.example)
git commit -m "pinch-mcp (19 tools) + Remi toolkit + landing"
gh repo create pinch-remi-toolkit --private --source . --push
#  or: create empty repo on github.com, then git remote add origin <url> && git push -u origin main
```
Then tell Claude the repo URL → gets wired into the landing page buttons.

---

## 2 — Production pipelines

### 2a. CoachPlus (Amplify) — automatic on the 1a push. Watch the build; env is inlined via next.config.mjs.
### 2b. LyboAI (manual, after CI green)
1. GitHub → Actions → **Migrate DB** → Run workflow → **tick "seed"** (loads mcp connector entry, both Remi templates, and the 9-agent family incl. Remi into Supabase prod). If prod was seeded before, confirm seed.ts upserts (it's your original design).
2. Actions → **Deploy** → Run workflow (Cloud Run API + Firebase Hosting dashboard/widget).
### 2c. Hosted pinch-mcp (Cloud Run)
```powershell
cd C:\Users\rajan\Claude\Projects\pinch-remi-toolkit\packages\pinch-mcp
gcloud run deploy pinch-mcp --source . --region australia-southeast1 --allow-unauthenticated
curl https://<url>/healthz ; curl https://<url>/meta
```
Give Claude the URL → landing playground default + docs get it. Prod LyboAI's mcp connector uses `https://<url>/mcp`.

---

## 3 — LyboAI activation (local AND prod — same steps)
1. **RE-SEED (required — seed files changed):** local: `npm run db:seed` in apps\api (Docker postgres up); prod: the Migrate+seed workflow (2b).
2. Dashboard → **Your Agent Family** → **Remi — AI Payments & Billing Agent** → **Deploy** (one click).
3. Integrations → connect **MCP**: serverUrl = local `http://localhost:3333/mcp` (pinch-mcp running `--http 3333 --cors`; Docker: `host.docker.internal`) or prod = the Cloud Run `/mcp` URL. Test connection → 19 tools.
4. Publish Remi (draft → live) → open the bot's **Widget/Channel** settings → copy its **widgetKey**; add your CoachPlus domain(s) to allowed domains (`http://localhost:3000`, `https://thecoachplus.com`).
5. Chat test: "How did we do this week?" · "Who owes on the studio rent split?" · "Bill Sarah $59/week for a 10-week term with a $100 deposit."

## 4 — CoachPlus ↔ Remi floating bubble
Set (locally in `.env.local`; prod in Amplify env) once step 3 gives you values:
```
NEXT_PUBLIC_LYBO_WIDGET_URL=  # local: the built/served widget.js from apps\widget; prod: https://lyboai-agents.web.app/widget.js
NEXT_PUBLIC_LYBO_WIDGET_KEY=  # the Remi bot's widgetKey
```
Rebuild/restart → Remi floats bottom-right on every coach page. (CSP for the widget origins is already in next.config.mjs.)

## 5 — Sandbox demo data (state)
- Real dishonoured payment exists: `pmt_lOb1nrunAStqfs` (insufficient-funds). Spare marked link: https://pay.getpinch.com.au/pay/plk_FQbR4SXNx7hdZr
- Studio-rent split `spl_Bh8QfH0Rai`: Priya $600 **paid**, Marcus $360 + Southside $240 pending — exposure story live.
- Test card `4242 4242 4242 4242`; DD payments process in the overnight run.

## 6 — Hackathon admin
- Slack `#hackathon-help-2026`: solo/team question (rules say teams of 2–4) — still the top open risk.
- First Submission **Sun 20:00 AEST**: https://getpinch.com.au/hackathon-first-submission (60-sec YouTube video — script coming from Claude). Final: 31 Jul. Demo night RSVP: https://luma.com/m5baswti

## Troubleshooting quick hits
- `minimatch is not a function` → wrong npm on PATH → §0 line.
- Seed ECONNREFUSED :5433 → `docker compose up -d` at lyboai root, then `db:migrate` → `db:seed`.
- 502 from /api/remi/summary → dev now returns a `detail` field + logs `[remi/summary] failed:` — paste it to Claude. Usual cause: wrong `PINCH_SECRET_KEY`.
- `invalid_client` on smoke → re-copy sk_test from portal Development Keys (no quotes/spaces; not the live key).
- Widget bubble absent → both NEXT_PUBLIC vars set? rebuilt after setting? domain in bot's allowed list? Check browser console for CSP blocks.
- Amplify page says payments not configured → env var missing from console OR not in next.config env block (it is, if unchanged).
