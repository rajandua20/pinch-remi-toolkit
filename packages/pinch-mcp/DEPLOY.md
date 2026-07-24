# Hosting pinch-mcp

Three patterns (details in README.md → "Hosting for your own platform(s)"). This doc is the how-to.

## A. Multi-tenant shared endpoint (one URL for all your platforms + the playground)

No credentials on the server — every request brings its own via headers
(`x-pinch-merchant-id`, `x-pinch-secret-key`, optional `x-pinch-env` — `live` is refused).

**Google Cloud Run (recommended — matches the LyboAI GCP stack):**
```bash
cd packages/pinch-mcp
gcloud run deploy pinch-mcp \
  --source . \
  --region australia-southeast1 \
  --allow-unauthenticated \
  --min-instances 0 --max-instances 3
# → https://pinch-mcp-xxxxx.australia-southeast1.run.app/mcp
```
(Uses the Dockerfile in this folder; Cloud Run injects PORT automatically.)

Verify:
```bash
curl https://<url>/healthz
curl https://<url>/meta       # {"env":"per-request"|"env","corsEnabled":true,...}
```

Point consumers at it:
- LyboAI mcp connector → serverUrl `https://<url>/mcp` (+ per-connection credentials)
- Landing-page playground live mode → same URL, user enters their own test keys
- Coach+/GreenWallST/CareLync → each connects with its own merchant credentials

**Alternatives (equally fine, faster to set up):** Railway / Render / Fly.io —
point them at this Dockerfile, expose the PORT they inject, done.

## B. Per-platform single-tenant instance

Same image, credentials baked as env (one deployment per platform):
```bash
gcloud run deploy pinch-mcp-coachplus \
  --source . --region australia-southeast1 --no-allow-unauthenticated \
  --set-env-vars PINCH_MERCHANT_ID=app_test_...,PINCH_ENV=test \
  --set-secrets PINCH_SECRET_KEY=pinch-coachplus-secret:latest
```
Use `--no-allow-unauthenticated` + an auth proxy or IAM invoker for private use.

## C. Library / in-process

Next.js or Node backends can skip the server entirely and use the client
directly (CoachPlus does this — see `theCoachPlus/src/lib/adapters/payments/pinch-client.ts`).

## Safety rails (all patterns)

- **Never** `--allow-live` on anything public. Test keys only on shared endpoints.
- Secrets belong in Secret Manager (pattern B), never in images or git.
- The confirm-guard on write tools applies regardless of host — money never moves
  without an explicit `confirm: true` from an approving human.
