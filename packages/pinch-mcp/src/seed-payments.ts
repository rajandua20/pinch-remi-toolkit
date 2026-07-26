/**
 * seed-payments.ts — create REAL, per-coach demo payments in the Pinch sandbox.
 *
 * The finance console groups a business's transactions per coach by reading a
 * `coachId` / `coachName` from Pinch metadata (the attribution pattern Pinch's
 * own team endorses — there is no first-class coupon/tag concept). This script
 * generates that data so the grouping demo has something real behind it.
 *
 * For each coach in the config it creates, tagged with the coach in metadata:
 *   - a SUCCESSFUL direct debit   (normal payer + a same-day payment)
 *   - a DISHONOURED direct debit  (payer marked "#insufficient-funds")
 *   - a CARD payment LINK         (open the printed URL, pay with 4242 4242 4242 4242)
 *
 * Card-link metadata reliably flows onto the resulting Payment. For the two
 * headless direct-debit payments we also set the payer's metadata to the coachId
 * (a string — the shape Pinch uses for payer attribution) as a belt-and-braces
 * fallback, and pass metadata on the payment body too.
 *
 * ONE MERCHANT PER RUN: it uses the connected merchant's env keys, so run it once
 * per business with that business's PINCH_MERCHANT_ID / PINCH_SECRET_KEY.
 * Direct-debit dishonours only surface after the simulated overnight run — set
 * PINCH_TIME_TRAVEL to tomorrow to see them immediately (same as smoke.ts).
 *
 * Config: coach-payments.local.json at the package root (git-ignored) — an array
 * of { coachId, coachName }. Copy coach-payments.local.json.example.
 *
 * Run: npm run seed:payments      (PINCH_ENV=test ONLY — it creates real records)
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PinchClient, configFromEnv, hasCredentials, formatAud } from "./pinch-client.js";

type AnyRecord = Record<string, any>;
interface CoachEntry { coachId: string; coachName: string }

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(HERE, "..");

// Tiny zero-dependency .env loader (package root), never overriding real env.
try {
  for (const line of readFileSync(join(PKG_ROOT, ".env"), "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {
  /* no .env — use the shell env */
}

function loadCoaches(): CoachEntry[] {
  const path = join(PKG_ROOT, "coach-payments.local.json");
  if (!existsSync(path)) {
    console.error(
      `Missing ${path} — copy coach-payments.local.json.example and fill in each coach's\n` +
        "coachId (the CoachPlus coachProfile id) and coachName.",
    );
    process.exit(1);
  }
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(parsed) || parsed.length === 0) {
    console.error("coach-payments.local.json must be a non-empty array of { coachId, coachName }.");
    process.exit(1);
  }
  for (const e of parsed as CoachEntry[]) {
    if (!e.coachId || !e.coachName) {
      console.error(`Each entry needs coachId and coachName: ${JSON.stringify(e).slice(0, 120)}`);
      process.exit(1);
    }
  }
  return parsed as CoachEntry[];
}

/** Create a payer with a test bank account. `marker` is prepended to the first
 * name; "#insufficient-funds" makes every payment for this payer dishonour. */
async function createPayer(client: PinchClient, coach: CoachEntry, learner: string, stamp: number, marker = ""): Promise<AnyRecord> {
  const [firstName, ...rest] = learner.split(" ");
  return client.post<AnyRecord>("/payers", {
    firstName: `${marker}${firstName}`.trim(),
    lastName: rest.join(" ") || "Demo",
    emailAddress: `demo.learner+${coach.coachId.slice(0, 6)}.${stamp}@example.com`,
    // Payer-level attribution fallback (Pinch stores payer metadata as a string).
    metadata: coach.coachId,
    source: { sourceType: "bank-account", bankAccountName: learner, bankAccountBsb: "000-000", bankAccountNumber: "123456" },
  });
}

async function main(): Promise<void> {
  if (!hasCredentials()) {
    console.error("Set PINCH_MERCHANT_ID and PINCH_SECRET_KEY (the business's own sandbox keys) first.");
    process.exit(1);
  }
  const config = configFromEnv();
  if (config.env !== "test") {
    console.error("ABORTED — this creates real payers/payments and must only run with PINCH_ENV=test.");
    process.exit(1);
  }

  const client = new PinchClient(config);
  const coaches = loadCoaches();
  const today = new Date().toISOString().slice(0, 10);
  const health = await client.health();
  console.log(`Merchant OK (env ${health.env ?? config.env}) — seeding ${coaches.length} coach(es).`);

  const cardLinks: Array<{ coach: string; url: string }> = [];

  for (const coach of coaches) {
    const stamp = Date.now();
    const meta = { coachId: coach.coachId, coachName: coach.coachName };
    console.log(`\n=== ${coach.coachName} (${coach.coachId}) ===`);

    // 1. Successful direct debit -------------------------------------------------
    const okPayer = await createPayer(client, coach, "Jordan Lee", stamp);
    const okPay = await client.post<AnyRecord>("/payments", {
      payerId: okPayer.id, amount: 5900, transactionDate: today,
      description: `Lesson block with ${coach.coachName}`,
      nonce: `seed-ok-${coach.coachId}-${stamp}`, metadata: meta,
    });
    console.log(`  ✓ direct debit ${formatAud(okPay.amount ?? 5900)} scheduled (${okPay.id})`);

    // 2. Dishonoured direct debit -----------------------------------------------
    const badPayer = await createPayer(client, coach, "Sam Park", stamp + 1, "Demo #insufficient-funds ");
    const badPay = await client.post<AnyRecord>("/payments", {
      payerId: badPayer.id, amount: 6500, transactionDate: today,
      description: `Term fee with ${coach.coachName} — expected to dishonour`,
      nonce: `seed-bad-${coach.coachId}-${stamp}`, metadata: meta,
    });
    console.log(`  ✓ dishonour-bound direct debit ${formatAud(badPay.amount ?? 6500)} scheduled (${badPay.id})`);

    // 3. Card payment link (pay with 4242 on the hosted page) --------------------
    const cardPayer = await createPayer(client, coach, "Ava Taylor", stamp + 2);
    const link = await client.post<AnyRecord>("/payment-links", {
      payerId: cardPayer.id, amount: 7500,
      description: `Single session with ${coach.coachName}`,
      allowedPaymentMethods: ["credit-card", "bank-account"],
      returnUrl: "https://www.thecoachplus.com/coach/payments?collected=1",
      metadata: meta,
    });
    if (link.url) {
      cardLinks.push({ coach: coach.coachName, url: link.url });
      console.log(`  ✓ card link ${formatAud(7500)} → ${link.url}`);
    } else {
      console.log(`  ! card link created (${link.id}) but no url returned — check the response shape`);
    }
  }

  console.log("\n=== CARD LINKS TO PAY (test card 4242 4242 4242 4242, exp 12/34, CVV 123) ===");
  if (cardLinks.length === 0) console.log("  (none)");
  for (const l of cardLinks) console.log(`  ${l.coach}: ${l.url}`);

  console.log(
    "\nDirect-debit results land after the simulated overnight run. To fast-forward,\n" +
      `re-run reads with PINCH_TIME_TRAVEL=${new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)}T09:00:00Z.\n` +
      "SEED COMPLETE ✔",
  );
}

main().catch((err) => {
  console.error("\nSEED FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
