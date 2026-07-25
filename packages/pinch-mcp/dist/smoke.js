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
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PinchClient, configFromEnv, hasCredentials, formatAud, } from "./pinch-client.js";
import { annotateDishonouredPayment, computeCashflowSummary } from "./tools.js";
// Tiny zero-dependency .env loader (package root), never overriding real env.
try {
    const envPath = join(dirname(fileURLToPath(import.meta.url)), "..", ".env");
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
        if (m && process.env[m[1]] === undefined) {
            process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
        }
    }
}
catch {
    /* no .env — fall back to whatever the shell provides */
}
function log(step, detail) {
    console.log(`\n=== ${step} ===`);
    if (detail !== undefined)
        console.log(typeof detail === "string" ? detail : JSON.stringify(detail, null, 2));
}
async function main() {
    if (!hasCredentials()) {
        console.log("SMOKE SKIPPED — set credentials (PINCH_MERCHANT_ID and PINCH_SECRET_KEY) to run the sandbox smoke test.");
        process.exit(0);
    }
    const config = configFromEnv();
    if (config.env !== "test") {
        console.error("SMOKE ABORTED — this script creates payers/payments and must only run with PINCH_ENV=test.");
        process.exit(1);
    }
    const client = new PinchClient(config);
    const today = new Date().toISOString().slice(0, 10);
    // 1. Health -----------------------------------------------------------------
    const health = await client.health();
    log("1. HEALTH", health);
    // 2. Create payer with the sandbox failure marker ---------------------------
    // "#insufficient-funds" in firstName makes every payment for this payer
    // dishonour with that code once processed (sandbox simulation feature).
    const stamp = Date.now();
    const payer = await client.post("/payers", {
        firstName: "Demo #insufficient-funds",
        lastName: "Smoke",
        emailAddress: `pinch-mcp-smoke+${stamp}@example.com`,
        source: {
            sourceType: "bank-account",
            bankAccountName: "Demo Smoke",
            bankAccountBsb: "000-000", // any BSB/account is accepted in test mode
            bankAccountNumber: "123456",
        },
    });
    log("2. PAYER CREATED", { id: payer.id, firstName: payer.firstName, email: payer.emailAddress });
    // 3. Schedule a payment for today -------------------------------------------
    const payment = await client.post("/payments", {
        payerId: payer.id,
        amount: 5900, // $59.00
        transactionDate: today,
        description: "pinch-mcp smoke test — expected to dishonour (insufficient funds)",
        nonce: `pinch-mcp-smoke-${stamp}`,
    });
    log("3. PAYMENT SCHEDULED", {
        id: payment.id,
        amount: formatAud(payment.amount ?? 5900),
        transactionDate: payment.transactionDate,
        status: payment.status,
    });
    // 4. Time-Travel note --------------------------------------------------------
    log("4. TIME-TRAVEL", config.timeTravel
        ? `PINCH_TIME_TRAVEL is set to ${config.timeTravel} — requests below simulate that moment, so the overnight direct-debit run should have processed this payment.`
        : "Direct-debit dishonours land after the simulated overnight run. To fast-forward, re-run with e.g.\n" +
            `  PINCH_TIME_TRAVEL=${new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)}T09:00:00Z npm run smoke\n` +
            "and the payment above will appear as dishonoured with an annotated diagnosis.");
    // 5. List failed payments with diagnosis ------------------------------------
    const { items } = await client.getAllPages("/payments/processed", {
        startDate: new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10),
    });
    const failed = items
        .filter((p) => p.status === "dishonoured")
        .map((p) => annotateDishonouredPayment(p));
    log("5. FAILED PAYMENTS (annotated)");
    if (failed.length === 0) {
        console.log("No dishonoured payments visible yet — expected on a first run without Time-Travel (see step 4).");
    }
    else {
        for (const f of failed) {
            console.log(`\n- ${f.paymentId} · ${f.amount} · ${f.payer?.name ?? f.payer?.id ?? "unknown payer"} · code: ${f.diagnosis.code}`);
            console.log(`  What happened : ${f.diagnosis.plainEnglish}`);
            console.log(`  Ownership     : ${f.diagnosis.ownership}`);
            console.log(`  Next step     : ${f.diagnosis.recommendedAction}`);
            console.log(`  Retryable     : ${f.diagnosis.retryable}`);
        }
    }
    // 6. Cashflow summary --------------------------------------------------------
    // Same computation as the pinch_cashflow_summary tool (7-day window).
    const summary = await computeCashflowSummary(client, 7);
    log("6. CASHFLOW SUMMARY (7 days)", {
        collected: summary.collected,
        dishonoured: { count: summary.dishonoured.count, atRiskAud: summary.dishonoured.atRiskAud },
        scheduledNext7Days: summary.scheduledNext7Days,
        scheduledNext30Days: summary.scheduledNext30Days,
        topPayers: summary.topPayers,
    });
    console.log("\nSMOKE COMPLETE ✔");
}
main().catch((err) => {
    console.error("\nSMOKE FAILED:", err instanceof Error ? err.message : err);
    process.exit(1);
});
//# sourceMappingURL=smoke.js.map