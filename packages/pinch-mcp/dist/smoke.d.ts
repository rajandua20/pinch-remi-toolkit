/**
 * smoke.ts — end-to-end sandbox smoke test for pinch-mcp.
 *
 * Flow (TEST environment only):
 *   1. health          — token fetch + trivial GET proves credentials
 *   2. create payer    — firstName "Demo #insufficient-funds" (the sandbox
 *                        failure-simulation marker) with a test bank account
 *   3. schedule payment for today
 *   4. note on Time-Travel — direct-debit dishonours only land after the
 *      simulated overnight run; set PINCH_TIME_TRAVEL to tomorrow to see them
 *   5. list failed payments and print the annotated diagnosis
 *
 * No credentials? Exits 0 with "SMOKE SKIPPED — set credentials" so CI and
 * fresh clones never fail on this script.
 *
 * Run: npm run smoke   (env: PINCH_MERCHANT_ID, PINCH_SECRET_KEY[, PINCH_TIME_TRAVEL])
 */
export {};
