# Remi × Pinch — Setup & Rollout Runbook (v5 — Sat 25 Jul, night)

Supersedes v4. New in v5: pinch-mcp is now **23 tools** (added
`pinch_create_payment_qr` — QR payment links + vendor-notification tag, and a
`qrcode` dependency, so the Docker build runs `npm ci`); the Dockerfile now
honours Cloud Run's **`$PORT`** (the old build hardcoded 8080 and 404'd on
redeploy); and CoachPlus gained **in-platform payment actions + a simulator**
(§10) that call the MCP engine, so `PINCH_MCP_URL` is now **required** in
CoachPlus. See §10 for the new pieces and the test script. Everything else below
reflects the current committed state:
pinch-mcp **23 tools** + two security passes + platform mode; LyboAI presets v2
with **REMI_PRESETS applied (10 tiles)** and **per-org MCP credential resolution**
(`mcpOrg.ts` + orgId plumbing — a coach's own Pinch keys ride the org's MCP
connection, never plaintext inside `bots.ai_config.tools[]`); CoachPlus **demo
seeder rewritten** into a three-business, three-step CoachPlus↔LyboAI round trip
(§6c). New in v4: **§9 Cloud Run hardening** (finding G). Order matters.

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
git log --oneline -8          # expect the security-pass, platform-mode, 22-tool and demo-seeder commits on top
git push origin main          # first push: gh repo create pinch-remi-toolkit --private --source . --push
```

### 2b. lyboai-platform
```powershell
cd C:\Users\rajan\Claude\Projects\lyboai-platform
git log --oneline -5          # expect the REMI_PRESETS, mcpOrg + orgId, bots.ts schema and demo-coaches seed commits
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
PINCH_DEMO_TENANT_ID=<your coach/tenant id>   # OPTIONAL — see note
```
**`PINCH_DEMO_TENANT_ID` (and the platform `PINCH_MERCHANT_ID`/`PINCH_SECRET_KEY`
fallback) are optional under the BYO-keys model.** `remiAccessAllowed()` grants
Remi to a tenant that has its own `coachSecrets/{tenantId}` keys **or** to the one
tenant whose id equals `PINCH_DEMO_TENANT_ID` (that tenant runs on the platform env
keys). The §6c seeder writes `coachSecrets` for every demo business, so they don't
need it — set it only if you keep a single demo tenant with no connected keys of
its own. `PINCH_WEBHOOK_SECRET`, `PAYMENTS_PROVIDER`, `SUBSCRIPTION_PROVIDER` are
always required. (NEXT_PUBLIC_LYBO_WIDGET_URL / _KEY come later — step 6.)
```powershell
cd C:\Users\rajan\Claude\Projects\theCoachPlus
npm run typecheck && git push origin main    # triggers Amplify prod build
```
The "Pinch isn't connected yet" empty state on /coach/payments disappears once
these vars are in and the build finishes.

## 3 — Redeploy hosted pinch-mcp (REQUIRED — the old URL is 404ing)

The Dockerfile fix (honours `$PORT`) and the QR tool + `qrcode` dep are committed.
A prior symptom was `/healthz` → **404 "that's all we know"** (no serving revision
because the container hardcoded `--http 8080`). Redeploy from a clean build:
```powershell
cd C:\Users\rajan\Claude\Projects\pinch-remi-toolkit\packages\pinch-mcp
gcloud run deploy pinch-mcp --source . --region australia-southeast1 --allow-unauthenticated
curl https://<printed-url>/healthz     # {"ok":true}  ← must be 200 now
curl https://<printed-url>/meta        # "toolCount":23 + toolsHash present
```
**Then set `PINCH_MCP_URL` to `https://<printed-url>/mcp`** in CoachPlus Amplify
env AND `theCoachPlus/.env.local` (the new coach payment routes in §10 require it),
and in the LyboAI seed/workflow. **Send Claude the printed URL.** If it differs
from `https://pinch-mcp-238547086112.australia-southeast1.run.app`, the landing
page, this guide, and `.github/workflows/migrate.yml` (PINCH_MCP_URL) need a
one-pass update.

> This step deploys the **public multi-tenant endpoint** (each request brings its
> own Pinch keys via `x-pinch-merchant-id` / `x-pinch-secret-key`; the browser
> playground and every platform share it). Before you point production LyboAI at
> it, read **§9** — the LyboAI→pinch-mcp path should run on a **locked-down**
> deployment, not this open one.

## 4 — Re-seed LyboAI (REQUIRED — presets/catalog/templates all changed)
Now writes **10 agent presets** (`REMI_PRESETS` spread into `seedAgentPresets`)
and a **22-action catalog** (added `pinch_cancel_subscription`,
`pinch_payer_statement`, `pinch_settlement_summary`).
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
   - **Pinch Merchant ID / Pinch Secret Key**: the org's OWN Pinch keys (new fields — this is how each business brings their own account). These now resolve through `mcpOrg.ts`: the org's `integration_connections` row (catalog_key `mcp`) carries the keys, `type:'mcp'` ai_config tools inherit them per org, and `bots.ts`' `superRefine` **rejects** any credential-named header baked into a tool. Do NOT paste secrets into a tool's `headers`.
   - Pinch environment: `test`
   - (Acting-as sub-merchant: leave empty — only for licensed aggregator platforms)
   - Test connection → 23 tools.
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

The seeder was rewritten. It is now a **three-step CoachPlus↔LyboAI round trip**,
one config file per side, all idempotent. Three businesses share two learners
(`rajan.dua20+priya@gmail.com` paid, `rajan.dua20+marcus@gmail.com` pending —
that split mirrors the sandbox split payment `spl_Bh8QfH0Rai`).

| | RoadReady | Elevate | Glenunga |
|---|---|---|---|
| Login email | `rajan.dua20+roadready@gmail.com` | `rajan.dua20+elevate@gmail.com` | `rajan.dua20+glenunga@gmail.com` |
| Slug | `roadready-driving` | `elevate-business-coaching` | `glenunga-swim-school` |
| Vertical | `driving` | `business` | `swim` |
| Theme | `#2563eb` | `#7c3aed` | `#0891b2` |
| Pinch app | driving-instructor | business-coach | glenunga-swim-school |

**All `+alias` accounts are email/password sign-in only — Google sign-in does
not work for Gmail plus-addresses.** All mail still lands in the one real inbox.

**Step 1 — fill the CoachPlus config.**
```powershell
cd C:\Users\rajan\Claude\Projects\theCoachPlus
Copy-Item scripts\demo-coaches.local.json.example scripts\demo-coaches.local.json
```
Edit `scripts\demo-coaches.local.json` — one object per business, each carrying
`email`, `password`, `name`, `slug`, `vertical`, `pinch.{merchantId,secretKey,env}`,
`mcpServerUrl` (your §3/§9 Cloud Run `/mcp` URL) and `domains`. Fill each
`pinch.*` from the matching Pinch app and set real passwords. Leave
`lyboWidgetKey` empty — step 3 fills it.

**Step 2 — seed CoachPlus and emit the LyboAI half.** Creates auth users,
tenants, published coach profiles + websites + app configs, availability, courses,
enrolments/invoices/bookings, conversations, and each business's own Pinch keys in
`coachSecrets/{tenantId}` (Remi switches on per coach automatically). Profiles now
write a top-level `primaryGeohash` (finding D — so they appear in marketplace
radius search) and runtime-resolved `categoryIds` (finding E — so they appear on
category browse pages).
```powershell
npm run seed:demo-coaches -- --emit-lybo ..\lyboai-platform\apps\api\demo-coaches.local.json
```
Useful flags: `--only <slug|vertical>` (seed one business), `--widget-keys <path>`
(step 3), `--emit-lybo <path>` (this step).

**Step 3 — seed LyboAI, then re-run CoachPlus to record the widget keys.**
```powershell
cd ..\lyboai-platform\apps\api
npm run db:seed:coaches          # creates the three orgs + Remi/Front Desk, emits demo-widget-keys.json
cd ..\..\..\theCoachPlus
npm run seed:demo-coaches -- --widget-keys ..\lyboai-platform\apps\api\demo-widget-keys.json
```
The final pass writes each business's Front Desk `lyboWidgetKey` onto its tenant.

**Then, per business:** run its 1-touch onboarding from
`pinch-remi-toolkit\demo\DEMO-BUSINESSES.md` (via that business's Remi on LyboAI,
or the playground with that app's keys). Each of the three LyboAI orgs uses the
same plus-alias email; each org's MCP connection carries only that business's keys.

**Firestore rules:** ensure `coachSecrets/**` denies ALL client access (server
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

## 9 — Cloud Run hardening for the LyboAI → pinch-mcp path (finding G)

**Read this before pointing production LyboAI at the §3 endpoint.** The §3
deployment is `--allow-unauthenticated`: `index.ts` concedes the hosted endpoint
is an open relay running with whatever keys the caller sends. That is fine for the
public browser playground (test keys only, per-IP rate-limited, `live` refused),
but the LyboAI→pinch-mcp leg should not run over an open endpoint.

**What does NOT gate it — do not rely on this alone.** An Origin/Referer allowlist
cannot protect the endpoint: LyboAI calls it **server-to-server and sends no
`Origin`**, and any non-browser client can forge one. In the current build CORS is
a single `--cors-origin` value (default `*`) set via `applyCorsHeaders`; it only
affects browsers, never a server caller. Setting it is defence-in-depth and
cosmetic against the real threat, nothing more.

**What actually gates it — ship both.**

1. **Cloud Run IAM (`--no-allow-unauthenticated`) — real, no code change, but use
   a SEPARATE deployment so the public playground keeps working.** The public
   playground (§3) must stay open; a locked endpoint would break it. Deploy a
   second, private service for the LyboAI leg:
   ```powershell
   cd C:\Users\rajan\Claude\Projects\pinch-remi-toolkit\packages\pinch-mcp
   gcloud run deploy pinch-mcp-lyboai --source . --region australia-southeast1 --no-allow-unauthenticated
   # grant ONLY the LyboAI API's runtime service account permission to invoke it:
   gcloud run services add-iam-policy-binding pinch-mcp-lyboai --region australia-southeast1 `
     --member="serviceAccount:<lyboai-api-runtime-sa>@<project>.iam.gserviceaccount.com" `
     --role="roles/run.invoker"
   ```
   The caller (LyboAI API) must send a Google-signed **OIDC identity token** whose
   audience is the `pinch-mcp-lyboai` URL as the `Authorization: Bearer` header.
   Because Cloud Run's front end consumes the `Authorization` header for IAM, the
   app-layer shared secret in (2) must use a **different** header — see the caveat.
   Verify with an identity token (unauthenticated curl now returns 403):
   ```powershell
   curl -H "Authorization: Bearer $(gcloud auth print-identity-token)" https://<lyboai-url>/meta
   ```

2. **Application shared-secret header — real gate, but NOT yet enforced in code.**
   Finding G's premise ("the connector can already send `authorization`, built
   from `credentials.authHeader ?? config.authHeader`, so no platform change is
   needed") is only half true: the LyboAI connector **can send** it, but
   **pinch-mcp does not check any shared secret today** — `index.ts` lists
   `authorization` only in the CORS allow-headers and never validates it. To make
   this a gate, add a small check to `pinch-mcp` (e.g. read `PINCH_MCP_SHARED_SECRET`
   and reject any `/mcp` request whose header does not match) and set it:
   ```powershell
   gcloud run services update pinch-mcp-lyboai --region australia-southeast1 `
     --update-env-vars "PINCH_MCP_SHARED_SECRET=<long-random-string>"
   ```
   If you also enable IAM (1), have the connector send this secret on a custom
   header (e.g. `x-pinch-mcp-secret`), because `Authorization` is taken by IAM.
   **Until that code lands, IAM (1) is the only working gate — ship it first.**

**Defence-in-depth (do it, but it is not the gate):** restrict CORS on the
private deployment and log the intended browser origins.
```powershell
gcloud run deploy pinch-mcp-lyboai --source . --region australia-southeast1 --no-allow-unauthenticated `
  --set-env-vars "PINCH_MCP_RATE_LIMIT=60"
# CORS origin is a CLI flag on the server process, not an env var in this build:
#   pinch-mcp --http $PORT --cors-origin https://thecoachplus.com
# The current build sets a single Access-Control-Allow-Origin value; a real
# multi-origin allowlist (thecoachplus.com + lyboai.app) needs a small code change.
```

**Backlog polish (separate from shipping the gate):** MCP tool sign-in,
per-company domain whitelist, contact email and phone on the connector. Also the
two open LyboAI defects noted in the handover: the dashboard posts secret-typed
connector fields as plaintext `config` (`IntegrationsPage.tsx:42-46`), and
`widgetPublic.ts:77` (`if (!origin) return;`) does not constrain non-browser callers.

## 10 — CoachPlus in-platform payment actions + simulator (new this session)

CoachPlus now performs the richer payment operations itself (not only Remi), by
calling the MCP engine — one implementation shared by the platform and the agent.
A native direct-REST path is a Polish-Week item.

**New CoachPlus files (committed):**
- `src/lib/adapters/payments/pinch-mcp-client.ts` — server-side MCP client
  (`initialize → notifications/initialized → tools/call`, the coach's own keys in
  headers, JSON/SSE parsing). **Requires `PINCH_MCP_URL`** — no hardcoded default.
- `src/lib/coach-discounts.ts` — tenant-scoped discount codes (`discountCodes`
  collection) for customer payments (reduced-amount; 100%-off short-circuits).
- `src/app/api/coach/finance/act/route.ts` — actions: `subscribe`, `collect`,
  `refund`, `cancel_subscription`, `split` (BYO-key scoped, preview then confirm).
- `src/app/api/coach/finance/simulate/route.ts` — `mock` mode (fabricated
  failures + Remi's real issue-detection, no keys) and `sandbox` mode
  (`#dishonour-code` synchronous dishonour, term subscription, split, discount).
- `src/lib/types.ts` — `pinchPayerId` / `pinchSubscriptionId` on `Tenant`,
  `pinchPlanId` on `SubscriptionPlan` (fixes the billing-checkout TS errors).

**Env:** set `PINCH_MCP_URL=https://<cloud-run-url>/mcp` in Amplify **and**
`theCoachPlus/.env.local`. Everything else (per-coach Pinch keys) already resolves
through `coachSecrets` / `resolvePinchForCoach`.

**Build check (no compiler in the cloud session):**
```powershell
cd C:\Users\rajan\Claude\Projects\theCoachPlus
npm run typecheck        # expect clean (these files were parse-checked only)
```

**Smoke-test the MCP engine end to end** (before wiring the UI) — a standalone
Node script that speaks MCP to your endpoint with a set of Pinch test keys and
runs `/healthz`, `/meta` (asserts 23 tools), `pinch_health`, and confirm:false
previews of subscription + QR:
```powershell
cd C:\Users\rajan\Claude\Projects\pinch-remi-toolkit
$env:PINCH_MCP_URL="https://<cloud-run-url>/mcp"
$env:PINCH_MERCHANT_ID="app_test_..."; $env:PINCH_SECRET_KEY="sk_test_..."
node demo/test-mcp.mjs
```

**Test the platform routes** (need a signed-in coach session in the browser):
easiest is the simulator — on `/coach/payments`, or:
```
POST /api/coach/finance/simulate   { "mode": "mock" }      # no keys — always works
POST /api/coach/finance/simulate   { "mode": "sandbox", "scenario": "all" }
POST /api/coach/finance/act        { "action": "subscribe", "email": "...", "amountCents": 5900, "interval": "weekly", "termPayments": 10, "depositCents": 10000, "description": "Swim term", "confirm": false }
```
`confirm:false` returns a preview (no money moves); re-send `confirm:true` to execute.

**Demo:** the full "what to demo / how / what to expect" script is in
`demo/DEMO-RUNBOOK.md`.

## Troubleshooting quick hits
- `minimatch is not a function` → §0 PATH line.
- Google sign-in 500 / "worker loop error" every ~5s → §1 (DB secret).
- Migrate workflow ETIMEDOUT → §1 GitHub secret (pooler form) + Supabase
  Network Restrictions off + project not paused.
- Agent tools all point at localhost:8787 → deployed before re-seed; delete the
  agent, re-seed with PINCH_MCP_URL, redeploy from the Family.
- Tools error in chat → Integrations → MCP → Test; check Pinch keys in the
  connection (auth errors = wrong sk_test); pinch_health tool reports env + actingAs.
- /meta shows toolCount below 23 or no toolsHash → old Cloud Run revision; redeploy §3.
- /healthz returns a Google 404 ("that's all we know") → no serving revision; the
  `$PORT` Dockerfile fix must be deployed (§3), then re-check.
- CoachPlus payment action returns "PINCH_MCP_URL is not set" → set it in Amplify +
  `.env.local` (§10).
- Widget bubble absent → both NEXT_PUBLIC vars set + rebuilt + domain in bot's
  allowed list; check console for CSP blocks.
- `--widget-keys ... not found` from the CoachPlus seeder → run the LyboAI seeder
  first (`npm run db:seed:coaches`); step 3 order matters.
- Seeded coach missing from search/browse → confirm the profile has a top-level
  `primaryGeohash` and resolved `categoryIds` (findings D/E); re-run the seeder.
- 403 from the private pinch-mcp → §9: caller not sending a valid identity token,
  or its service account lacks `roles/run.invoker` on `pinch-mcp-lyboai`.
