# Remi × Pinch — Setup & Rollout Runbook (v3 — Sat 25 Jul, evening)

Supersedes v2. Everything below reflects the current committed state:
pinch-mcp **22 tools** + two security passes + platform mode; LyboAI presets v2
(back-office Remi + **Remi Front Desk**, per-org Pinch credential fields on the
MCP connector); CoachPlus unchanged since ws3e. Order matters.

## 0 — Every terminal, first line (Node fix)
```powershell
$env:Path = "$env:APPDATA\nvm\v20.18.0;$env:Path"
```

---

## 1 — Fix prod database connectivity (blocks sign-in AND seeding)

The connection string must be the **Session Pooler** form in TWO places
(Supabase Dashboard → Connect → Session pooler tab):
`postgresql://postgres.<project-ref>:<password>@aws-0-ap-southeast-2.pooler.supabase.com:5432/postgres`

1. **GitHub secret** (used by Migrate DB workflow): repo `lyboai-platform` →
   Settings → Secrets → Actions → `SUPABASE_DATABASE_URL` → update.
2. **GCP secret** (used by the running API — this fixed Google sign-in):
   ```powershell
   "postgresql://postgres.<ref>:<password>@aws-0-ap-southeast-2.pooler.supabase.com:5432/postgres" | Out-File -Encoding ascii -NoNewline dburl.txt
   gcloud secrets versions add lyboai-database-url --data-file=dburl.txt
   Remove-Item dburl.txt
   gcloud run services update lyboai-api --region australia-southeast1 --update-env-vars "DEPLOY_BUMP=$(Get-Date -Format yyyyMMddHHmmss)"
   ```
   Verify: `gcloud run services logs read lyboai-api --region australia-southeast1 --limit 20`
   → the repeating "worker loop error" should stop; Google sign-in works.

## 2 — Push all three repos

### 2a. pinch-remi-toolkit
Local commits are already made (security passes, 1-touch tools, platform mode,
fresh dist). Delete the `_to_delete\` folder at the repo root first (stale git
locks I couldn't remove — safe to delete).
```powershell
cd C:\Users\rajan\Claude\Projects\pinch-remi-toolkit
git log --oneline -5          # expect: 7aaf187, c922c92, fd5b999, ...
git push origin main          # first push: gh repo create pinch-remi-toolkit --private --source . --push
```

### 2b. lyboai-platform
```powershell
cd C:\Users\rajan\Claude\Projects\lyboai-platform
git log --oneline -3          # expect: 0ec86aa, d1a6834
git push origin main          # CI runs typecheck+tests automatically
```
Also delete `_to_delete\` here when convenient (gitignored).

### 2c. theCoachPlus — set Amplify env FIRST, then push
Amplify Console → Environment variables (all seven):
```
PINCH_MERCHANT_ID=app_test_kPR4h10nCQrQ8a
PINCH_SECRET_KEY=<sk_test_…>
PINCH_ENV=test
PAYMENTS_PROVIDER=pinch
SUBSCRIPTION_PROVIDER=pinch
PINCH_WEBHOOK_SECRET=whsec_s6aMlYzYW8JZsypJZjdSRztp91KHOmx0
PINCH_DEMO_TENANT_ID=<your coach/tenant id>
```
(NEXT_PUBLIC_LYBO_WIDGET_URL / _KEY come later — step 6.)
```powershell
cd C:\Users\rajan\Claude\Projects\theCoachPlus
npm run typecheck && git push origin main    # triggers Amplify prod build
```
The "Pinch isn't connected yet" empty state on /coach/payments disappears once
these vars are in and the build finishes.

## 3 — Redeploy hosted pinch-mcp (REQUIRED — old revision lacks everything from today)
```powershell
cd C:\Users\rajan\Claude\Projects\pinch-remi-toolkit\packages\pinch-mcp
gcloud run deploy pinch-mcp --source . --region australia-southeast1 --allow-unauthenticated
curl https://<printed-url>/healthz     # {"ok":true}
curl https://<printed-url>/meta        # toolCount: 22 + toolsHash present
```
**Send Claude the printed URL.** If it differs from
`https://pinch-mcp-238547086112.australia-southeast1.run.app`, the landing
page, this guide, and `.github/workflows/migrate.yml` (PINCH_MCP_URL) need a
one-pass update.

## 3b — LyboAI AI provider (REQUIRED before re-seed — powers Design + RAG)

The agents run on `AI_PROVIDER` (apps/api `config.ts`), which **defaults to
`mock`** (a deterministic stub — no real model). Set a real provider on the
**lyboai-api** service BEFORE the step-4 seed, so knowledge is embedded by the
same model it will later be searched with. Using existing OpenAI credits:
```
AI_PROVIDER=openai
OPENAI_BASE_URL=https://api.openai.com/v1   # REQUIRED — without it the openai driver is skipped and it silently falls back to mock
OPENAI_API_KEY=sk-…
OPENAI_CHAT_MODEL=gpt-4o-mini
OPENAI_EMBED_MODEL=text-embedding-3-small   # the driver requests dimensions:768 to match the pgvector column
```
Prod: set these as Cloud Run env vars on `lyboai-api` (same place as the DB
secret in step 1), then redeploy. Local: `apps/api/.env`. Both chat (Design) and
embeddings (RAG) run off the one key; `gpt-4o-mini` is cheap. If you switch
providers AFTER seeding, re-run the seed — embeddings from different models are
not comparable and RAG search will return junk.
(Alternative — Google Vertex/Gemini: `AI_PROVIDER=vertex` + `GCP_PROJECT`, uses
the Cloud Run service account so there's no API key, but it bills GCP.)

## 4 — Re-seed LyboAI (REQUIRED — presets/catalog/templates all changed)
- **Local:** `docker compose up -d` at repo root, then in `apps\api`:
  ```powershell
  $env:PINCH_MCP_URL = "https://<cloud-run-url>/mcp"
  npm run db:migrate; npm run db:seed
  ```
- **Prod:** GitHub → Actions → **Migrate DB** → Run workflow → tick **seed**
  (PINCH_MCP_URL is baked into the workflow). Needs step 1 done first.

## 5 — Deploy the agents (local AND prod dashboards, same steps)
1. **Delete the old test "Remi - CoachPlus" agent** — its tools point at
   `http://localhost:8787/mcp` from the pre-URL seed.
2. Dashboard → Your Agent Family → now **10 tiles** →
   **Remi — AI Payments & Billing Agent** (back office) → Deploy.
3. Integrations → **MCP Server** → connect:
   - serverUrl: `https://<cloud-run-url>/mcp` (local dev alternative: `http://localhost:3333/mcp` with pinch-mcp running `--http 3333 --cors`)
   - **Pinch Merchant ID / Pinch Secret Key**: the org's OWN Pinch keys (new fields — this is how each business brings their own account)
   - Pinch environment: `test`
   - (Acting-as sub-merchant: leave empty — only for licensed aggregator platforms)
   - Test connection → 22 tools.
4. Publish Remi → Widget/Channel settings → copy **widgetKey** → add allowed
   domains (`http://localhost:3000`, `https://thecoachplus.com`).
5. Optionally deploy **Remi Front Desk** (customer-facing tile, indigo) the same
   way — this is the agent for a coach's website/app channels.
6. Chat test: "Set up my swim school: $59/week for 10 weeks with a $100 deposit,
   and import these customers: Priya priya@example.com, Marcus marcus@example.com"
   → preview → approve → go-live pack with setup links. That's the 1-touch demo.

## 6 — CoachPlus ↔ Remi widget
Once step 5 gives values, set locally in `.env.local` and in Amplify env:
```
NEXT_PUBLIC_LYBO_WIDGET_URL=   # prod: https://lyboai-agents.web.app/widget.js
NEXT_PUBLIC_LYBO_WIDGET_KEY=   # the back-office Remi bot's widgetKey
```
Rebuild → Remi floats bottom-right on coach pages.

## 6b — Landing page → pinch.lybotechgroup.com (Vercel)
```powershell
cd C:\Users\rajan\Claude\Projects\pinch-remi-toolkit\landing
npx vercel login          # once
npx vercel --prod         # deploys this folder as a static site
```
Then Vercel dashboard → the project → Settings → **Domains** → add
`pinch.lybotechgroup.com`, and at your DNS provider for lybotechgroup.com add:
`CNAME  pinch  →  cname.vercel-dns.com`. Propagation is usually minutes.
Pages: `/` (landing + playground) and `/hackathon.html` (the feedback page —
this is the link to send Pinch dev + marketing contacts).

## 6c — Three demo businesses (BYO keys — apps already created in Pinch)
1. `cd theCoachPlus` → `Copy-Item scripts\demo-coaches.local.json.example scripts\demo-coaches.local.json`
   → fill each entry's `pinch.merchantId`/`secretKey` from the matching Pinch
   app (**driving-instructor**, **business-coach**, **glenunga-swim-school**)
   and set passwords. Logins use Gmail plus-addressing — all mail arrives in
   YOUR inbox, one real mailbox:
   `rajan.dua20+driving@gmail.com` · `rajan.dua20+bizcoach@gmail.com` · `rajan.dua20+swim@gmail.com`
   (**email/password sign-in only** — Google sign-in does not work for + aliases).
2. `npm run seed:demo-coaches` — creates auth users, tenants, published coach
   profiles + websites + app configs, and each business's own Pinch keys in
   `coachSecrets/` (Remi switches on per coach automatically). Idempotent.
3. Per business, run its 1-touch onboarding from
   `pinch-remi-toolkit\demo\DEMO-BUSINESSES.md` (via that business's Remi on
   LyboAI, or the playground with that app's keys).
4. LyboAI: three orgs (same plus-alias emails), each org's MCP connection
   carries that business's keys; deploy Remi + Remi Front Desk per org; put
   each Front Desk widgetKey on the tenant via the seed json (`lyboWidgetKey`)
   and re-run the seed.
5. Firestore rules: ensure `coachSecrets/**` denies ALL client access (server
   SDK only) before pushing to prod.

## 7 — Sandbox demo state (unchanged, still live)
- Dishonoured payment `pmt_lOb1nrunAStqfs` (insufficient-funds); spare marked
  link: https://pay.getpinch.com.au/pay/plk_FQbR4SXNx7hdZr
- Split `spl_Bh8QfH0Rai`: Priya $600 paid; Marcus $360 + Southside $240 pending.
- Test card `4242 4242 4242 4242`; DD processes overnight.

## 8 — Hackathon admin
- First Submission Sun 20:00 AEST: https://getpinch.com.au/hackathon-first-submission
  (60-sec video — script: `docs/VIDEO-SCRIPT.md` in the toolkit). Final 31 Jul.
  Demo night RSVP: https://luma.com/m5baswti
- Slack solo/team question still open. Also worth asking: "does the sandbox
  support OAuth connect for apps (redirect URLs)?" and "can sandbox apps create
  managed merchants via API?"
- Regenerate the exposed LIVE Pinch keys (portal → API keys) before Final.

## Troubleshooting quick hits
- `minimatch is not a function` → §0 PATH line.
- Google sign-in 500 / "worker loop error" every ~5s → §1 (DB secret).
- Migrate workflow ETIMEDOUT → §1 GitHub secret (pooler form) + Supabase
  Network Restrictions off + project not paused.
- Agent tools all point at localhost:8787 → deployed before re-seed; delete the
  agent, re-seed with PINCH_MCP_URL, redeploy from the Family.
- Tools error in chat → Integrations → MCP → Test; check Pinch keys in the
  connection (auth errors = wrong sk_test); pinch_health tool reports env + actingAs.
- /meta shows toolCount 20 or no toolsHash → old Cloud Run revision; redeploy §3.
- Widget bubble absent → both NEXT_PUBLIC vars set + rebuilt + domain in bot's
  allowed list; check console for CSP blocks.
