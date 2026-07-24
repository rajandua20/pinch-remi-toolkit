/**
 * tools.ts — MCP tool registrations for the Pinch Payments API.
 *
 * Conventions:
 *  - READ tools never mutate anything and are annotated readOnlyHint.
 *  - WRITE tools require `confirm: true`. Without it they DO NOT call the API;
 *    they return a structured preview so a human (or supervising agent) can
 *    approve before money moves. This is the toolkit's human-in-the-loop seam.
 *  - All money is integer cents (AUD). Responses include formatted amounts.
 *  - Failed ("dishonoured") payments are annotated with the dishonour-map
 *    diagnosis: plain English, ownership, recommended action, retryability.
 */

import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { PinchClient, PinchApiError, formatAud, centsToAud } from "./pinch-client.js";
import { diagnoseDishonour, DISHONOUR_MAP } from "./dishonour-map.js";

// ---------------------------------------------------------------------------
// Shared result helpers
// ---------------------------------------------------------------------------

function jsonResult(payload: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function errorResult(message: string, detail?: unknown): CallToolResult {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify({ error: message, detail: detail ?? null }, null, 2),
      },
    ],
  };
}

/** Structured preview returned by guarded write tools when confirm !== true. */
function previewResult(wouldDo: string, params: unknown): CallToolResult {
  return jsonResult({
    preview: true,
    wouldDo,
    params,
    note: "Re-call with confirm:true after human approval",
  });
}

/** Wrap a tool handler so API/config errors surface as structured MCP errors. */
function safe<A extends unknown[]>(
  fn: (...args: A) => Promise<CallToolResult>,
): (...args: A) => Promise<CallToolResult> {
  return async (...args: A) => {
    try {
      return await fn(...args);
    } catch (err) {
      if (err instanceof PinchApiError) {
        return errorResult(err.message, { status: err.status, body: err.body, path: err.path });
      }
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  };
}

// ---------------------------------------------------------------------------
// Payment-shape helpers (tolerant of the loosely-specified Pinch shapes)
// ---------------------------------------------------------------------------

type AnyRecord = Record<string, any>;

/** ISO date (YYYY-MM-DD) param schema. */
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected an ISO date like 2026-07-24");

/** Payment statuses we count as a successful collection. */
const SUCCESS_STATUSES = new Set([
  "approved",
  "settled",
  "cleared-settlements-disabled",
  "cleared-pending-dispute",
]);

/**
 * Pull the dishonour info off a payment. Three shapes exist in the wild:
 *  - detail (GET /payments/{id}): attempts[].dishonour = {type, ...} — richest;
 *  - a top-level `dishonour` object (event payloads);
 *  - LIST items (GET /payments/processed): a flat `dishonourType` string only
 *    (empirical — list items carry NO attempts[] and no dishonour object).
 */
function extractDishonour(payment: AnyRecord): { type?: string; reason?: string } | undefined {
  const attempts: AnyRecord[] = Array.isArray(payment.attempts) ? payment.attempts : [];
  // Latest attempt first — the most recent failure is the actionable one.
  for (let i = attempts.length - 1; i >= 0; i--) {
    const d = attempts[i]?.dishonour;
    if (d && typeof d === "object") {
      return { type: d.type, reason: d.reason ?? d.description };
    }
  }
  const d = payment.dishonour;
  if (d && typeof d === "object") return { type: d.type, reason: d.reason ?? d.description };
  if (typeof payment.dishonourType === "string" && payment.dishonourType.length > 0) {
    return { type: payment.dishonourType, reason: payment.dishonourReason ?? undefined };
  }
  return undefined;
}

/** Budget for per-call payment-detail lookups (keeps request volume bounded). */
interface DetailBudget {
  remaining: number;
  exhausted: boolean;
}

export function newDetailBudget(max = 10): DetailBudget {
  return { remaining: max, exhausted: false };
}

/**
 * Resolve a payment's dishonour info, fetching GET /payments/{id} when the
 * in-hand record has no usable type (processed-LIST items usually carry a flat
 * `dishonourType`, but some shapes carry nothing). Detail fetches are capped
 * by the shared per-call budget — when it runs dry, `budget.exhausted` is set
 * so callers can report truncatedDetails:true.
 */
async function resolveDishonour(
  client: PinchClient,
  payment: AnyRecord,
  budget: DetailBudget,
): Promise<{ type?: string; reason?: string } | undefined> {
  const local = extractDishonour(payment);
  if (local?.type) return local;
  if (typeof payment.id !== "string" || payment.id.length === 0) return local;
  if (budget.remaining <= 0) {
    budget.exhausted = true;
    return local;
  }
  budget.remaining--;
  try {
    const detail = await client.get<AnyRecord>(`/payments/${encodeURIComponent(payment.id)}`);
    return extractDishonour(detail) ?? local;
  } catch {
    return local; // annotation is best-effort — never fail the whole call
  }
}

/** Resolve the payer id off a payment (nested payer object or flat payerId). */
function extractPayerId(payment: AnyRecord): string | undefined {
  return payment.payer?.id ?? payment.payerId ?? undefined;
}

/** Resolve the subscription id off a payment (string or nested object, or absent). */
function extractSubscriptionId(payment: AnyRecord): string | undefined {
  const sub = payment.subscription;
  if (!sub) return undefined;
  if (typeof sub === "string") return sub;
  if (typeof sub === "object") return sub.id;
  return undefined;
}

/**
 * Annotate a dishonoured payment with the diagnosis table entry. Exported so
 * the smoke script (and downstream consumers) reuse identical semantics.
 * Pass a pre-resolved dishonour (from resolveDishonour) to avoid re-extraction.
 */
export function annotateDishonouredPayment(
  payment: AnyRecord,
  resolved?: { type?: string; reason?: string },
): AnyRecord {
  const dishonour = resolved ?? extractDishonour(payment);
  const diagnosis = diagnoseDishonour(dishonour?.type);
  return {
    paymentId: payment.id,
    status: payment.status,
    amountCents: payment.amount,
    amount: typeof payment.amount === "number" ? formatAud(payment.amount) : undefined,
    transactionDate: payment.transactionDate,
    payer: payment.payer
      ? {
          id: payment.payer.id,
          name:
            payment.payer.fullName ??
            [payment.payer.firstName, payment.payer.lastName].filter(Boolean).join(" "),
          email: payment.payer.emailAddress,
        }
      : { id: extractPayerId(payment) },
    dishonour: dishonour ?? { type: "unknown" },
    diagnosis, // { code, plainEnglish, ownership, recommendedAction, retryable }
  };
}

/** Integer-cents amount of a payment record (0 when absent/malformed). */
function centsOf(p: AnyRecord): number {
  return typeof p.amount === "number" ? p.amount : 0;
}

/** Days between an ISO date/timestamp and now (positive = in the past). */
function daysAgo(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return undefined;
  return (Date.now() - t) / 86_400_000;
}

function todayPlus(days: number): string {
  const d = new Date(Date.now() + days * 86_400_000);
  return d.toISOString().slice(0, 10);
}

/**
 * Extract the calendar date from a Pinch transactionDate. Pinch stores dates
 * as midnight AEST rendered in UTC (e.g. "2026-07-23T14:00:00.0000000Z" means
 * 2026-07-24 in Australia) — naively slicing the UTC date shifts everything a
 * day early (verified empirically in the sandbox). Shift +10h (AEST) first.
 */
function pinchDate(value: string | undefined | null): string {
  if (!value) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value; // already a plain date
  const t = Date.parse(value);
  if (Number.isNaN(t)) return value.slice(0, 10);
  return new Date(t + 10 * 3_600_000).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Cashflow summary (shared with smoke.ts)
// ---------------------------------------------------------------------------

/**
 * Stable output shape for pinch_cashflow_summary — rendered directly in UI
 * cards downstream, so: *Cents fields are integers, *Aud fields are "$x.yy"
 * strings, and the key set never varies between calls.
 */
export interface CashflowSummary {
  periodDays: number;
  collected: { count: number; totalCents: number; totalAud: string };
  dishonoured: {
    count: number;
    totalCents: number;
    atRiskAud: string;
    /** true when the ≤10-per-call detail-lookup budget ran out before every
     *  dishonour could be typed (remaining items may show "unknown"). */
    truncatedDetails: boolean;
    items: Array<{
      paymentId: string;
      payerName: string;
      amountAud: string;
      dishonourType: string;
      plainEnglish: string;
    }>;
  };
  scheduledNext7Days: { count: number; totalCents: number; totalAud: string };
  scheduledNext30Days: { count: number; totalCents: number; totalAud: string };
  topPayers: Array<{ payerId: string; name: string; totalAud: string; totalCents: number }>;
  generatedAt: string;
}

/** Compute the merchant cashflow summary over processed + scheduled payments. */
export async function computeCashflowSummary(
  client: PinchClient,
  days: number,
): Promise<CashflowSummary> {
  const [processed, scheduled] = await Promise.all([
    client.getAllPages<AnyRecord>("/payments/processed", { startDate: todayPlus(-days) }),
    client.getAllPages<AnyRecord>("/payments/scheduled"),
  ]);

  const cents = (p: AnyRecord): number => (typeof p.amount === "number" ? p.amount : 0);
  const payerName = (p: AnyRecord): string =>
    p.payer?.fullName ??
    ([p.payer?.firstName, p.payer?.lastName].filter(Boolean).join(" ") ||
      (extractPayerId(p) ?? "unknown payer"));

  // Collected = successful collections in the window.
  const collected = processed.items.filter((p) => SUCCESS_STATUSES.has(p.status));
  const collectedCents = collected.reduce((sum, p) => sum + cents(p), 0);

  // Dishonoured = failed collections in the window, annotated for UI.
  // List items usually carry a flat dishonourType; detail-fetch (≤10) otherwise.
  const failed = processed.items.filter((p) => p.status === "dishonoured");
  const failedCents = failed.reduce((sum, p) => sum + cents(p), 0);
  const detailBudget = newDetailBudget();
  const failedItems = [];
  for (const p of failed) {
    const diagnosis = diagnoseDishonour((await resolveDishonour(client, p, detailBudget))?.type);
    failedItems.push({
      paymentId: String(p.id ?? ""),
      payerName: payerName(p),
      amountAud: formatAud(cents(p)),
      dishonourType: diagnosis.code,
      plainEnglish: diagnosis.plainEnglish,
    });
  }

  // Upcoming scheduled collections (forward-looking, independent of `days`).
  const today = todayPlus(0);
  const inWindow = (p: AnyRecord, horizon: string): boolean => {
    const when = pinchDate(p.transactionDate);
    return when >= today && when <= horizon;
  };
  const next7 = scheduled.items.filter((p) => inWindow(p, todayPlus(7)));
  const next30 = scheduled.items.filter((p) => inWindow(p, todayPlus(30)));
  const sumCents = (list: AnyRecord[]) => list.reduce((s, p) => s + cents(p), 0);

  // Top 5 payers by collected amount in the window.
  const byPayer = new Map<string, { name: string; totalCents: number }>();
  for (const p of collected) {
    const id = extractPayerId(p) ?? "unknown";
    const entry = byPayer.get(id) ?? { name: payerName(p), totalCents: 0 };
    entry.totalCents += cents(p);
    byPayer.set(id, entry);
  }
  const topPayers = [...byPayer.entries()]
    .sort((a, b) => b[1].totalCents - a[1].totalCents)
    .slice(0, 5)
    .map(([payerId, { name, totalCents }]) => ({
      payerId,
      name,
      totalAud: formatAud(totalCents),
      totalCents,
    }));

  return {
    periodDays: days,
    collected: { count: collected.length, totalCents: collectedCents, totalAud: formatAud(collectedCents) },
    dishonoured: {
      count: failed.length,
      totalCents: failedCents,
      atRiskAud: formatAud(failedCents),
      truncatedDetails: detailBudget.exhausted,
      items: failedItems,
    },
    scheduledNext7Days: { count: next7.length, totalCents: sumCents(next7), totalAud: formatAud(sumCents(next7)) },
    scheduledNext30Days: { count: next30.length, totalCents: sumCents(next30), totalAud: formatAud(sumCents(next30)) },
    topPayers,
    generatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Split payments — shared helpers
//
// A "split" is a pure composition over verified primitives: N payment links
// (one per party) tagged with a JSON metadata blob carrying the split id.
// Nothing is stored server-side by us — pinch_get_split_status reconstructs
// the whole picture from GET /payment-links (whose list items DO return
// metadata — verified empirically; the docs omit it) plus processed payments
// (metadata passes through from link to Payment on completion).
// ---------------------------------------------------------------------------

/** Generate a split id: "spl_" + 10 random alphanumerics. */
function newSplitId(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = randomBytes(10);
  let id = "spl_";
  for (let i = 0; i < 10; i++) id += alphabet[bytes[i] % alphabet.length];
  return id;
}

/**
 * Largest-remainder allocation: convert percentage shares into integer cents
 * that ALWAYS sum exactly to totalCents (floors first, then hand the leftover
 * cents to the largest fractional remainders).
 */
function allocateByPercent(totalCents: number, percents: number[]): number[] {
  const raw = percents.map((p) => (totalCents * p) / 100);
  const alloc = raw.map(Math.floor);
  let leftover = totalCents - alloc.reduce((a, b) => a + b, 0);
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac);
  for (let k = 0; leftover > 0; k++, leftover--) alloc[order[k % order.length].i]++;
  return alloc;
}

/** Shape of the JSON blob we store in each split link's metadata. */
interface SplitMeta {
  split: string;
  part: string; // "1/3"
  totalCents: number;
  amountCents: number;
  description: string;
  email: string | null; // party email (link list items omit payer emailAddress)
  createdAt: string; // YYYY-MM-DD
  dueDate: string | null;
}

/** Parse split metadata tolerantly (JSON first, `split=x;part=1/3` style as fallback). */
function parseSplitMeta(metadata: unknown): Partial<SplitMeta> | undefined {
  if (typeof metadata !== "string" || metadata.length === 0) return undefined;
  try {
    const parsed = JSON.parse(metadata);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "split" in parsed) {
      return parsed as Partial<SplitMeta>;
    }
    // Metadata may be an array of objects (Pinch can append its own entries).
    if (Array.isArray(parsed)) {
      const hit = parsed.find((e) => e && typeof e === "object" && "split" in e);
      if (hit) return hit as Partial<SplitMeta>;
    }
  } catch {
    /* not JSON — try key=value;key=value */
  }
  const kv = new Map<string, string>();
  for (const pair of metadata.split(";")) {
    const idx = pair.indexOf("=");
    if (idx > 0) kv.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
  }
  if (!kv.has("split")) return undefined;
  return {
    split: kv.get("split"),
    part: kv.get("part"),
    totalCents: kv.has("total") ? Number(kv.get("total")) : undefined,
  } as Partial<SplitMeta>;
}

/** Find-or-create a payer by email (case-insensitive email match). */
async function ensurePayer(
  client: PinchClient,
  email: string,
  name?: string,
): Promise<{ payer: AnyRecord; created: boolean }> {
  const { items } = await client.getAllPages<AnyRecord>("/payers", { filter: email });
  const match = items.find((p) => (p.emailAddress ?? "").toLowerCase() === email.toLowerCase());
  if (match) return { payer: match, created: false };
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  const created = await client.post<AnyRecord>("/payers", {
    firstName: parts[0] || email.split("@")[0] || "Customer",
    lastName: parts.slice(1).join(" ") || undefined,
    emailAddress: email,
  });
  return { payer: created, created: true };
}

// ---------------------------------------------------------------------------
// Billing-blueprint compiler (pinch_design_billing) — deterministic helpers.
// The AI host extracts a structured model from plain English; this compiles it.
// ---------------------------------------------------------------------------

// Fee estimates are SANDBOX-OBSERVED, INDICATIVE ONLY — never official pricing:
//  - card: totalFee 129c observed on a 5900c payment link charge (~2.19%) → 2.2%
//  - direct debit: 85c flat observed on a 5900c bank-account payment
const EST_CARD_FEE_RATE = 0.022;
const EST_DD_FEE_CENTS = 85; // kept for reference/documentation of the DD basis
void EST_DD_FEE_CENTS;
const FEE_BASIS = "sandbox-observed, indicative";

function estFeeCents(amountCents: number): number {
  return Math.round(amountCents * EST_CARD_FEE_RATE);
}

interface BillingEvent {
  date: string;
  componentName: string;
  description: string;
  amountCents: number;
  amountAud: string;
}

interface CompiledComponent {
  component: AnyRecord; // blueprint entry
  events: BillingEvent[]; // ALL events within the 30-day horizon (for totals)
}

interface DesignComponentInput {
  kind: "membership" | "term" | "package" | "per_session" | "one_off" | "split";
  name: string;
  amountCents: number;
  interval?: SubscriptionInterval;
  termPayments?: number;
  depositCents?: number;
  parties?: Array<{ email: string; name?: string; amountCents?: number; sharePercent?: number }>;
  payerEmail?: string;
  notes?: string;
}

/** Money block for one collection event (per charge). */
function moneyBlock(amountCents: number, platformFeePercent?: number) {
  const fee = estFeeCents(amountCents);
  const platform =
    platformFeePercent !== undefined ? Math.round((amountCents * platformFeePercent) / 100) : null;
  const net = amountCents - fee - (platform ?? 0);
  return {
    gross: { cents: amountCents, aud: formatAud(amountCents) },
    estPinchFee: { cents: fee, aud: formatAud(fee), basis: FEE_BASIS },
    platformFee: platform !== null ? { cents: platform, aud: formatAud(platform) } : null,
    estNet: { cents: net, aud: formatAud(net) },
  };
}

/** Validate one component's field combination. Returns an error string or null. */
function validateDesignComponent(c: DesignComponentInput): string | null {
  const need = (cond: boolean, msg: string) => (cond ? null : `${c.name}: ${msg}`);
  switch (c.kind) {
    case "membership":
      return need(c.interval !== undefined, "membership requires interval (weekly|fortnightly|monthly)");
    case "term": {
      if (c.interval === undefined) return `${c.name}: term requires interval`;
      return need(c.termPayments !== undefined, "term requires termPayments (it must end — use membership for open-ended)");
    }
    case "package":
      if (c.termPayments !== undefined && c.interval === undefined) {
        return `${c.name}: package instalments require interval`;
      }
      return null;
    case "per_session":
    case "one_off":
      return null;
    case "split": {
      if (!c.parties || c.parties.length === 0) return null; // event-driven split is fine
      if (c.parties.length < 2) return `${c.name}: split needs ≥2 parties (or omit parties for event-driven)`;
      const withAmt = c.parties.filter((p) => p.amountCents !== undefined);
      const withPct = c.parties.filter((p) => p.sharePercent !== undefined);
      if (withAmt.length > 0 && withPct.length > 0) return `${c.name}: split parties must ALL use amountCents or ALL use sharePercent`;
      if (withAmt.length + withPct.length < c.parties.length) return `${c.name}: every split party needs amountCents or sharePercent`;
      if (withPct.length === c.parties.length) {
        const sum = c.parties.reduce((s, p) => s + (p.sharePercent ?? 0), 0);
        if (Math.abs(sum - 100) > 0.01) return `${c.name}: split sharePercent must sum to 100 (got ${sum})`;
      } else {
        const sum = c.parties.reduce((s, p) => s + (p.amountCents ?? 0), 0);
        if (sum !== c.amountCents) return `${c.name}: split party amounts (${sum}c) must sum to amountCents (${c.amountCents}c)`;
      }
      return null;
    }
  }
}

/**
 * Deterministically compile one component: capability mapping, schedule,
 * money, provisioning class, flags, example follow-up call. Pure function.
 */
function compileBillingComponent(
  c: DesignComponentInput,
  startDate: string,
  horizonDate: string,
  platformFeePercent?: number,
): CompiledComponent {
  const flags: string[] = [];
  if (platformFeePercent !== undefined) {
    flags.push(`${platformFeePercent}% platform fee NOT applied automatically — see needsReview`);
  }
  const events: BillingEvent[] = [];
  const ev = (date: string, description: string, amountCents: number) => {
    if (date <= horizonDate) {
      events.push({ date, componentName: c.name, description, amountCents, amountAud: formatAud(amountCents) });
    }
  };

  let mapsTo = "";
  let scheduleSummary = "";
  let provisioning: "provisionable-now" | "event-driven" | "needs-review" = "event-driven";
  let exampleCall: AnyRecord | undefined;
  const firstEvents: Array<{ date: string; amountAud: string; description: string }> = [];
  const pushFirst = (date: string, amountCents: number, description: string) => {
    if (firstEvents.length < 4) firstEvents.push({ date, amountAud: formatAud(amountCents), description });
  };

  const recurringSeries = (first: string, count: number | null, label: string) => {
    // Generate events to the horizon (for totals) and up to 4 firstEvents.
    for (let k = 0; ; k++) {
      if (count !== null && k >= count) break;
      const d = addIntervals(first, c.interval!, k);
      if (k < 4) pushFirst(d, c.amountCents, label);
      if (d > horizonDate && k >= 4) break;
      ev(d, label, c.amountCents);
      if (count === null && d > horizonDate) break;
    }
  };

  switch (c.kind) {
    case "membership": {
      mapsTo = `Pinch Plan + Subscription (${c.interval}, ongoing until cancelled)`;
      scheduleSummary = `${formatAud(c.amountCents)} ${c.interval} from ${startDate}, until cancelled`;
      recurringSeries(startDate, null, `${c.interval} charge`);
      provisioning = c.payerEmail ? "provisionable-now" : "event-driven";
      if (!c.payerEmail) {
        exampleCall = {
          tool: "pinch_create_subscription",
          params: { payerEmail: "customer@example.com", amountCents: c.amountCents, interval: c.interval, description: c.name, confirm: true },
        };
        flags.push("no payerEmail — provision per customer as they sign up (see exampleCall)");
      }
      break;
    }
    case "term":
    case "package": {
      const instalments = c.termPayments !== undefined;
      if (!instalments) {
        // package without instalments = one-off payment link for the full amount
        mapsTo = "Payment link for the full package amount (one-off)";
        scheduleSummary = `${formatAud(c.amountCents)} once, collected via hosted payment link`;
        ev(startDate, "package payment link", c.amountCents);
        pushFirst(startDate, c.amountCents, "package payment link");
        provisioning = c.payerEmail ? "provisionable-now" : "event-driven";
        if (!c.payerEmail) {
          exampleCall = {
            tool: "pinch_create_payment_link",
            params: { amountCents: c.amountCents, description: c.name, payerEmail: "customer@example.com", confirm: true },
          };
        }
        break;
      }
      const dep = c.depositCents;
      mapsTo =
        `Pinch Plan + Subscription (${c.interval}, ends after ${c.termPayments} payments` +
        (dep !== undefined ? ", deposit via fixedPayments" : "") +
        ")";
      const firstRecurring = dep !== undefined ? addIntervals(startDate, c.interval!, 1) : startDate;
      const last = addIntervals(firstRecurring, c.interval!, c.termPayments! - 1);
      const total = (dep ?? 0) + c.termPayments! * c.amountCents;
      scheduleSummary =
        (dep !== undefined ? `${formatAud(dep)} deposit on ${startDate}, then ` : "") +
        `${c.termPayments} × ${formatAud(c.amountCents)} ${c.interval} from ${firstRecurring} to ${last} ` +
        `(${formatAud(total)} total)`;
      if (dep !== undefined) {
        ev(startDate, "deposit", dep);
        pushFirst(startDate, dep, "deposit");
      }
      recurringSeries(firstRecurring, c.termPayments!, "instalment");
      provisioning = c.payerEmail ? "provisionable-now" : "event-driven";
      if (!c.payerEmail) {
        exampleCall = {
          tool: "pinch_create_subscription",
          params: {
            payerEmail: "customer@example.com", amountCents: c.amountCents, interval: c.interval,
            description: c.name, termPayments: c.termPayments,
            ...(dep !== undefined ? { depositCents: dep } : {}), confirm: true,
          },
        };
        flags.push("no payerEmail — provision per customer as they enrol (see exampleCall)");
      }
      break;
    }
    case "per_session": {
      mapsTo = "Payment link issued per booking (event-driven)";
      scheduleSummary = `${formatAud(c.amountCents)} per session, on demand — no fixed dates`;
      provisioning = "event-driven";
      exampleCall = {
        tool: "pinch_create_payment_link",
        params: { amountCents: c.amountCents, description: c.name, payerEmail: "customer@example.com", confirm: true },
      };
      flags.push("not auto-provisioned — issue a payment link at each booking (see exampleCall)");
      break;
    }
    case "one_off": {
      mapsTo = "Hosted payment link (one-off)";
      scheduleSummary = `${formatAud(c.amountCents)} once via hosted payment link`;
      ev(startDate, "payment link", c.amountCents);
      pushFirst(startDate, c.amountCents, "payment link");
      provisioning = c.payerEmail ? "provisionable-now" : "event-driven";
      if (!c.payerEmail) {
        exampleCall = {
          tool: "pinch_create_payment_link",
          params: { amountCents: c.amountCents, description: c.name, payerEmail: "customer@example.com", confirm: true },
        };
      }
      break;
    }
    case "split": {
      mapsTo = "Split payment links with exposure tracking";
      const n = c.parties?.length ?? 0;
      scheduleSummary =
        n >= 2
          ? `${formatAud(c.amountCents)} split across ${n} parties — one tagged link each, tracked by split id`
          : `${formatAud(c.amountCents)} split (parties supplied at run time)`;
      if (n >= 2) {
        ev(startDate, `split links issued (${n} parties)`, c.amountCents);
        pushFirst(startDate, c.amountCents, `split links issued (${n} parties)`);
        provisioning = "provisionable-now";
      } else {
        provisioning = "event-driven";
        exampleCall = {
          tool: "pinch_create_split",
          params: {
            description: c.name, totalCents: c.amountCents,
            parts: [
              { email: "party1@example.com", sharePercent: 50 },
              { email: "party2@example.com", sharePercent: 50 },
            ],
            confirm: true,
          },
        };
        flags.push("no parties given — call pinch_create_split when the group is known (see exampleCall)");
      }
      break;
    }
  }

  return {
    component: {
      name: c.name,
      kind: c.kind,
      mapsTo,
      schedule: { summary: scheduleSummary, firstEvents },
      money: moneyBlock(c.amountCents, platformFeePercent),
      provisioning,
      flags,
      ...(exampleCall ? { exampleCall } : {}),
      ...(c.notes ? { notes: c.notes } : {}),
    },
    events,
  };
}

const INTERVAL_MAP = {
  weekly: { frequencyOffset: 7, frequencyInterval: "days" },
  fortnightly: { frequencyOffset: 14, frequencyInterval: "days" },
  monthly: { frequencyOffset: 1, frequencyInterval: "months" },
} as const;

type SubscriptionInterval = keyof typeof INTERVAL_MAP;

/**
 * The exact POST /plans body we want (field names verified against the
 * ref-save-plan.md OpenAPI schema). Also acts as the find-or-create identity:
 * an existing plan is only reused when it matches this spec structurally —
 * name, metadata, every recurring end/term field, and the fixedPayments
 * (deposit) signature. Plans can't be edited once subscribed, so a mismatched
 * plan is never reused or mutated; a new one is created instead.
 */
interface PlanSpec {
  name: string;
  metadata?: string;
  recurringPayment: {
    amountInCents: number;
    description: string;
    startDateOffset?: number; // days from subscription start to first recurring payment
    startDateInterval?: "days";
    frequencyOffset: number;
    frequencyInterval: "days" | "months" | "years";
    endType: "never" | "number-of-payments" | "end-date";
    endAfterNumberOfPayments?: number;
    endDateOffset?: number;
    endDateInterval?: "days";
    cancelPlanOnFailure: boolean;
  };
  fixedPayments?: Array<{
    amountInCents: number;
    description: string;
    scheduledDateOffset: number;
    scheduledDateInterval: "days";
    cancelPlanOnFailure: boolean;
  }>;
}

/** Structural plan identity match (null/undefined/default-0 tolerant). */
function planMatchesSpec(plan: AnyRecord, spec: PlanSpec): boolean {
  const rp = plan.recurringPayment;
  const want = spec.recurringPayment;
  if (plan.name !== spec.name || rp == null) return false;
  if ((plan.metadata ?? "") !== (spec.metadata ?? "")) return false;
  const eq = (a: unknown, b: unknown) => (a ?? null) === (b ?? null);
  if (
    rp.amountInCents !== want.amountInCents ||
    rp.frequencyOffset !== want.frequencyOffset ||
    rp.frequencyInterval !== want.frequencyInterval ||
    (rp.endType ?? "never") !== want.endType ||
    !eq(rp.endAfterNumberOfPayments, want.endAfterNumberOfPayments) ||
    !eq(rp.endDateOffset, want.endDateOffset) ||
    (rp.startDateOffset ?? 0) !== (want.startDateOffset ?? 0)
  ) {
    return false;
  }
  const fixed: AnyRecord[] = Array.isArray(plan.fixedPayments) ? plan.fixedPayments : [];
  const wantFixed = spec.fixedPayments ?? [];
  if (fixed.length !== wantFixed.length) return false;
  for (let i = 0; i < wantFixed.length; i++) {
    if (
      fixed[i].amountInCents !== wantFixed[i].amountInCents ||
      (fixed[i].scheduledDateOffset ?? 0) !== wantFixed[i].scheduledDateOffset
    ) {
      return false;
    }
  }
  return true;
}

/** Add k billing intervals to an ISO date (calendar months for monthly). */
function addIntervals(isoDateStr: string, interval: SubscriptionInterval, k: number): string {
  if (interval === "monthly") {
    const d = new Date(`${isoDateStr}T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + k);
    return d.toISOString().slice(0, 10);
  }
  const step = interval === "weekly" ? 7 : 14;
  return new Date(Date.parse(`${isoDateStr}T00:00:00Z`) + k * step * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/** Whole days from one ISO date to another (positive when `to` is later). */
function daysFromTo(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export interface RegisterOptions {
  /**
   * Lazily supplies the Pinch client. Deferred so the server can be
   * constructed (e.g. for --selftest / tools:list) without credentials;
   * missing-credential errors surface per tool call instead.
   */
  getClient: () => PinchClient;
  /** Refund safety cap in cents (env PINCH_MAX_REFUND_CENTS, default 20000). */
  maxRefundCents: number;
}

/** Register every pinch tool on the given McpServer. Returns the tool names. */
export function registerPinchTools(server: McpServer, options: RegisterOptions): string[] {
  const { getClient, maxRefundCents } = options;
  const names: string[] = [];
  const track = (name: string) => {
    names.push(name);
    return name;
  };

  // =========================================================================
  // READ TOOLS (no side effects)
  // =========================================================================

  server.registerTool(
    track("pinch_health"),
    {
      title: "Pinch health check",
      description:
        "Verify Pinch credentials and connectivity: fetches an OAuth token and performs a trivial GET " +
        "(/payers?pageSize=1). Reports the active environment (test/live), base URL, and whether the check passed. " +
        "Run this first if any other tool errors.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    safe(async () => {
      const client = getClient();
      const health = await client.health();
      return jsonResult({
        ...health,
        note:
          client.env === "test"
            ? "Sandbox (test) environment — no real money moves."
            : "LIVE environment — real money. Write tools will move real funds.",
      });
    }),
  );

  server.registerTool(
    track("pinch_list_payments"),
    {
      title: "List payments",
      description:
        "List Pinch payments. By default lists PROCESSED payments (things that have run), optionally filtered by " +
        "status (e.g. settled, approved, dishonoured, processing) and date range. Set scheduled:true to list " +
        "upcoming SCHEDULED payments instead. Amounts are integer cents (AUD). Returns at most 5 pages (250 items).",
      inputSchema: {
        status: z
          .string()
          .optional()
          .describe(
            "Filter by payment status, e.g. settled | approved | dishonoured | processing | scheduled | cancelled",
          ),
        from: isoDate.optional().describe("Start date (YYYY-MM-DD), processed payments only"),
        to: isoDate.optional().describe("End date (YYYY-MM-DD), processed payments only"),
        scheduled: z
          .boolean()
          .optional()
          .describe("true = list upcoming scheduled payments instead of processed ones"),
      },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ status, from, to, scheduled }) => {
      const client = getClient();
      const path = scheduled ? "/payments/scheduled" : "/payments/processed";
      // Date-range query params are documented for /payments/processed only.
      const query = scheduled ? {} : { startDate: from, endDate: to };
      const { items, totalItems, truncated } = await client.getAllPages<AnyRecord>(path, query);

      let payments = items;
      if (status) payments = payments.filter((p) => p.status === status);
      if (scheduled && (from || to)) {
        // Client-side date filter for the scheduled list.
        payments = payments.filter(
          (p) =>
            (!from || pinchDate(p.transactionDate) >= from) &&
            (!to || pinchDate(p.transactionDate) <= to),
        );
      }

      return jsonResult({
        source: path,
        count: payments.length,
        totalItemsBeforeFilters: totalItems,
        truncated,
        payments: payments.map((p) => ({
          id: p.id,
          status: p.status,
          amountCents: p.amount,
          amount: typeof p.amount === "number" ? formatAud(p.amount) : undefined,
          transactionDate: p.transactionDate,
          sourceType: p.sourceType,
          description: p.description,
          payerId: extractPayerId(p),
          payerName:
            p.payer?.fullName ??
            ([p.payer?.firstName, p.payer?.lastName].filter(Boolean).join(" ") || undefined),
          subscriptionId: extractSubscriptionId(p),
        })),
      });
    }),
  );

  server.registerTool(
    track("pinch_get_payment"),
    {
      title: "Get payment",
      description:
        "Fetch one Pinch payment by id (pmt_...), including its attempts and any dishonour detail. If the payment " +
        "is dishonoured, the response includes a plain-English diagnosis (cause, ownership, recommended action, retryability).",
      inputSchema: {
        paymentId: z.string().describe("Payment id, e.g. pmt_XXXXXXXXXXXXXXXX"),
      },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ paymentId }) => {
      const client = getClient();
      const payment = await client.get<AnyRecord>(`/payments/${encodeURIComponent(paymentId)}`);
      const result: AnyRecord = { payment };
      if (payment.status === "dishonoured") {
        result.diagnosis = annotateDishonouredPayment(payment).diagnosis;
      }
      return jsonResult(result);
    }),
  );

  server.registerTool(
    track("pinch_list_failed_payments"),
    {
      title: "List failed (dishonoured) payments",
      description:
        "List payments that FAILED (status 'dishonoured'), each annotated with a diagnosis from the dishonour " +
        "taxonomy: plainEnglish explanation, ownership (customer | merchant-config | platform), recommendedAction, " +
        "and retryable (soft = retry can work as-is, hard = something must change first). This is the primary tool " +
        "for a payments-support agent triaging failures.",
      inputSchema: {
        from: isoDate.optional().describe("Start date (YYYY-MM-DD)"),
        to: isoDate.optional().describe("End date (YYYY-MM-DD)"),
      },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ from, to }) => {
      const client = getClient();
      const { items, truncated } = await client.getAllPages<AnyRecord>("/payments/processed", {
        startDate: from,
        endDate: to,
      });
      const failed = items.filter((p) => p.status === "dishonoured");
      // LIST items usually carry a flat dishonourType; when even that is
      // missing, fetch the payment detail (≤10 lookups per call).
      const budget = newDetailBudget();
      const annotated: AnyRecord[] = [];
      for (const p of failed) {
        annotated.push(annotateDishonouredPayment(p, await resolveDishonour(client, p, budget)));
      }
      const atRiskCents = failed.reduce(
        (sum, p) => sum + (typeof p.amount === "number" ? p.amount : 0),
        0,
      );
      return jsonResult({
        count: annotated.length,
        totalAtRiskCents: atRiskCents,
        totalAtRisk: formatAud(atRiskCents),
        truncated,
        truncatedDetails: budget.exhausted,
        failedPayments: annotated,
      });
    }),
  );

  server.registerTool(
    track("pinch_get_payer"),
    {
      title: "Get payer",
      description:
        "Fetch one Pinch payer by id (pyr_...), including contact details and stored payment sources " +
        "(bank accounts / cards). Sources only appear here — there is no separate list-sources endpoint.",
      inputSchema: {
        payerId: z.string().describe("Payer id, e.g. pyr_XXXXXXXXXXXXXXXX"),
      },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ payerId }) => {
      const client = getClient();
      const payer = await client.get<AnyRecord>(`/payers/${encodeURIComponent(payerId)}`);
      return jsonResult({ payer });
    }),
  );

  server.registerTool(
    track("pinch_list_payers"),
    {
      title: "List payers",
      description:
        "List Pinch payers (customers), optionally filtered with a free-text search (matched server-side against " +
        "name/email). Returns at most 5 pages (250 payers).",
      inputSchema: {
        search: z.string().optional().describe("Free-text filter, e.g. a name or email address"),
      },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ search }) => {
      const client = getClient();
      const { items, totalItems, truncated } = await client.getAllPages<AnyRecord>("/payers", {
        filter: search,
      });
      return jsonResult({
        count: items.length,
        totalItems,
        truncated,
        payers: items.map((p) => ({
          id: p.id,
          name: p.fullName ?? [p.firstName, p.lastName].filter(Boolean).join(" "),
          email: p.emailAddress,
          mobile: p.mobileNumber,
          company: p.companyName,
        })),
      });
    }),
  );

  server.registerTool(
    track("pinch_list_subscriptions"),
    {
      title: "List subscriptions (with stall detection)",
      description:
        "List Pinch subscriptions, cross-referenced against the last ~90 days of processed payments to flag " +
        "SILENTLY STALLED subscriptions: active subscriptions whose last successful payment is more than 35 days " +
        "old (or that have never collected and are older than 35 days), or that have a dishonoured payment in the " +
        "last 14 days. Stalled subscriptions are usually leaking revenue nobody has noticed.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    safe(async () => {
      const client = getClient();
      const [subsResult, paymentsResult] = await Promise.all([
        client.getAllPages<AnyRecord>("/subscriptions"),
        client.getAllPages<AnyRecord>("/payments/processed", { startDate: todayPlus(-90) }),
      ]);

      // Index recent payments by subscription id AND payer id (payments carry a
      // subscription link when generated by one; payer id is the fallback).
      const bySub = new Map<string, AnyRecord[]>();
      const byPayer = new Map<string, AnyRecord[]>();
      for (const p of paymentsResult.items) {
        const subId = extractSubscriptionId(p);
        if (subId) (bySub.get(subId) ?? bySub.set(subId, []).get(subId)!).push(p);
        const payerId = extractPayerId(p);
        if (payerId) (byPayer.get(payerId) ?? byPayer.set(payerId, []).get(payerId)!).push(p);
      }

      const STALL_DAYS = 35;
      const RECENT_DISHONOUR_DAYS = 14;

      const subscriptions = subsResult.items.map((sub) => {
        const related =
          bySub.get(sub.id) ?? byPayer.get(sub.payer?.id ?? sub.payerId ?? "") ?? [];

        let lastSuccessDate: string | undefined;
        let recentDishonours = 0;
        for (const p of related) {
          const when: string | undefined = p.transactionDate;
          if (SUCCESS_STATUSES.has(p.status)) {
            if (!lastSuccessDate || (when ?? "") > lastSuccessDate) lastSuccessDate = when;
          } else if (p.status === "dishonoured") {
            const age = daysAgo(when);
            if (age !== undefined && age <= RECENT_DISHONOUR_DAYS) recentDishonours++;
          }
        }

        const successAge = daysAgo(lastSuccessDate);
        const startAge = daysAgo(sub.startDate);
        const isActive = sub.status === "active";

        const reasons: string[] = [];
        if (isActive && recentDishonours > 0) {
          reasons.push(`${recentDishonours} dishonoured payment(s) in the last ${RECENT_DISHONOUR_DAYS} days`);
        }
        if (isActive && lastSuccessDate && successAge !== undefined && successAge > STALL_DAYS) {
          reasons.push(`last successful payment was ${Math.floor(successAge)} days ago (> ${STALL_DAYS})`);
        }
        if (isActive && !lastSuccessDate && startAge !== undefined && startAge > STALL_DAYS) {
          reasons.push(`no successful payment observed in the last 90 days`);
        }

        return {
          id: sub.id,
          status: sub.status,
          planId: sub.planId,
          planName: sub.planName,
          startDate: sub.startDate,
          payerId: sub.payer?.id ?? sub.payerId,
          payerName:
            sub.payer?.fullName ??
            ([sub.payer?.firstName, sub.payer?.lastName].filter(Boolean).join(" ") || undefined),
          lastSuccessfulPaymentDate: lastSuccessDate ?? null,
          recentDishonours,
          stalled: reasons.length > 0,
          stalledReasons: reasons,
        };
      });

      const stalled = subscriptions.filter((s) => s.stalled);
      return jsonResult({
        count: subscriptions.length,
        stalledCount: stalled.length,
        truncated: subsResult.truncated || paymentsResult.truncated,
        note:
          "Stall detection uses the last 90 days of processed payments (max 5 pages); " +
          "'stalled' = active subscription with no success in 35+ days or a dishonour in the last 14 days.",
        stalledSubscriptions: stalled,
        subscriptions,
      });
    }),
  );

  server.registerTool(
    track("pinch_get_subscription"),
    {
      title: "Get subscription",
      description:
        "Fetch one Pinch subscription by id (sub_...): plan, payer, status (active | cancelled | complete), " +
        "start date, and resolved payment amounts.",
      inputSchema: {
        subscriptionId: z.string().describe("Subscription id, e.g. sub_XXXXXXXXXXXXXXXX"),
      },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ subscriptionId }) => {
      const client = getClient();
      const subscription = await client.get<AnyRecord>(
        `/subscriptions/${encodeURIComponent(subscriptionId)}`,
      );
      return jsonResult({ subscription });
    }),
  );

  server.registerTool(
    track("pinch_list_events"),
    {
      title: "List events",
      description:
        "Poll the Pinch event feed (GET /events), optionally filtered by eventType and start date. Useful types: " +
        "'bank-results' (THE failed-direct-debit signal — there is no discrete payment-failed event), " +
        "'payment-created', 'realtime-payment', 'transfer', 'refund-created', 'subscription-cancelled'. " +
        "List items are summaries; fetch GET /events/{id} for full payloads (not wrapped here).",
      inputSchema: {
        eventType: z
          .string()
          .optional()
          .describe("Filter by event type, e.g. bank-results | payment-created | transfer"),
        from: isoDate.optional().describe("Start date (YYYY-MM-DD)"),
      },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ eventType, from }) => {
      const client = getClient();
      const { items, totalItems, truncated } = await client.getAllPages<AnyRecord>("/events", {
        eventType,
        startDate: from,
      });
      return jsonResult({ count: items.length, totalItems, truncated, events: items });
    }),
  );

  server.registerTool(
    track("pinch_cashflow_summary"),
    {
      title: "Cashflow summary",
      description:
        "One-call merchant cashflow snapshot — answers 'how am I doing?'. Over the last N days (default 7, max 90): " +
        "money collected, money lost to dishonours (with per-payment plain-English reasons), plus forward-looking " +
        "scheduled collections for the next 7 and 30 days and the top 5 payers by amount collected. Output shape is " +
        "stable and UI-ready: integer *Cents fields plus formatted '$x.yy' *Aud strings.",
      inputSchema: {
        days: z
          .number()
          .int()
          .min(1)
          .max(90)
          .optional()
          .describe("Lookback window in days for collected/dishonoured figures (default 7, max 90)"),
      },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ days }) => {
      const summary = await computeCashflowSummary(getClient(), days ?? 7);
      return jsonResult(summary);
    }),
  );

  server.registerTool(
    track("pinch_payer_statement"),
    {
      title: "Payer statement of account",
      description:
        "Build a statement of account for one payer: every processed payment in the lookback window (default 90 " +
        "days, max 365) plus all upcoming scheduled payments, in chronological order with dishonour reasons in " +
        "plain English. Includes totals (collected, failed, upcoming, net position) and a ready-to-email " +
        "plain-text `statementText` block. Identify the payer by payerId or payerEmail (looked up, must exist).",
      inputSchema: {
        payerId: z.string().optional().describe("Payer id, e.g. pyr_XXXXXXXXXXXXXXXX"),
        payerEmail: z
          .string()
          .email()
          .optional()
          .describe("Payer email — must match an existing payer (no payer is created)"),
        days: z
          .number()
          .int()
          .min(1)
          .max(365)
          .optional()
          .describe("Lookback window in days for processed payments (default 90, max 365)"),
      },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ payerId, payerEmail, days }) => {
      if (!payerId && !payerEmail) {
        return errorResult("Provide payerId or payerEmail to identify the payer.");
      }
      const client = getClient();
      const periodDays = days ?? 90;

      // Resolve the payer (statement never creates one).
      let payer: AnyRecord | undefined;
      if (payerId) {
        payer = await client.get<AnyRecord>(`/payers/${encodeURIComponent(payerId)}`);
      } else if (payerEmail) {
        const { items } = await client.getAllPages<AnyRecord>("/payers", { filter: payerEmail });
        payer = items.find((p) => (p.emailAddress ?? "").toLowerCase() === payerEmail.toLowerCase());
        if (!payer) {
          return errorResult(`No payer found with email ${payerEmail}. Use pinch_list_payers to search.`);
        }
      }
      const resolvedId: string = payer!.id;
      const payerOut = {
        id: resolvedId,
        name:
          payer!.fullName ??
          ([payer!.firstName, payer!.lastName].filter(Boolean).join(" ") || "(unnamed payer)"),
        email: payer!.emailAddress ?? null,
      };

      // All payments for this payer (processed + scheduled live in one list).
      const { items: payments, truncated } = await client.getAllPages<AnyRecord>(
        `/payments/payer/${encodeURIComponent(resolvedId)}`,
      );

      const cutoff = todayPlus(-periodDays);
      const today = todayPlus(0);
      const dateOf = (p: AnyRecord): string => pinchDate(p.transactionDate);
      const cents = (p: AnyRecord): number => (typeof p.amount === "number" ? p.amount : 0);

      // Lines: past payments inside the window + every upcoming scheduled one.
      const inScope = payments.filter((p) => {
        const d = dateOf(p);
        return d >= cutoff || (p.status === "scheduled" && d >= today);
      });
      inScope.sort((a, b) => dateOf(a).localeCompare(dateOf(b)));

      // Dishonour typing: flat dishonourType on list items when present,
      // detail-fetch fallback (≤10 per call) otherwise.
      const detailBudget = newDetailBudget();
      const lines: AnyRecord[] = [];
      for (const p of inScope) {
        const diagnosis =
          p.status === "dishonoured"
            ? diagnoseDishonour((await resolveDishonour(client, p, detailBudget))?.type)
            : undefined;
        lines.push({
          date: dateOf(p),
          description: p.description ?? "(no description)",
          amountAud: formatAud(cents(p)),
          amountCents: cents(p),
          status: String(p.status ?? "unknown"),
          ...(diagnosis ? { dishonourReason: `${diagnosis.code} — ${diagnosis.plainEnglish}` } : {}),
        });
      }

      // Totals over the same scope.
      let collectedCents = 0;
      let failedCents = 0;
      let upcomingScheduledCents = 0;
      for (const p of inScope) {
        if (SUCCESS_STATUSES.has(p.status)) collectedCents += cents(p);
        else if (p.status === "dishonoured") failedCents += cents(p);
        else if (p.status === "scheduled" && dateOf(p) >= today) upcomingScheduledCents += cents(p);
      }
      const netCents = collectedCents - failedCents;

      const totals = {
        collectedCents,
        collectedAud: formatAud(collectedCents),
        failedCents,
        failedAud: formatAud(failedCents),
        upcomingScheduledCents,
        upcomingScheduledAud: formatAud(upcomingScheduledCents),
        netPositionCents: netCents,
        netPositionAud: formatAud(netCents),
      };

      const generatedAt = new Date().toISOString();

      // Plain-text statement block, ready to paste into an email.
      const txt: string[] = [];
      txt.push("STATEMENT OF ACCOUNT");
      txt.push(`${payerOut.name}${payerOut.email ? ` <${payerOut.email}>` : ""} (${payerOut.id})`);
      txt.push(`Period: last ${periodDays} days (+ upcoming scheduled) · generated ${generatedAt.slice(0, 10)}`);
      txt.push("");
      txt.push(`${"DATE".padEnd(12)}${"STATUS".padEnd(14)}${"AMOUNT".padStart(10)}  DESCRIPTION`);
      txt.push("-".repeat(72));
      for (const line of lines) {
        txt.push(
          `${line.date.padEnd(12)}${line.status.padEnd(14)}${line.amountAud.padStart(10)}  ${line.description}`,
        );
        if (line.dishonourReason) txt.push(`${" ".repeat(12)}! ${line.dishonourReason}`);
      }
      if (lines.length === 0) txt.push("(no payments in this period)");
      txt.push("-".repeat(72));
      txt.push(`${"Collected:".padEnd(26)}${totals.collectedAud.padStart(10)}`);
      txt.push(`${"Failed (dishonoured):".padEnd(26)}${totals.failedAud.padStart(10)}`);
      txt.push(`${"Upcoming scheduled:".padEnd(26)}${totals.upcomingScheduledAud.padStart(10)}`);
      txt.push(`${"Net position:".padEnd(26)}${totals.netPositionAud.padStart(10)}`);

      return jsonResult({
        payer: payerOut,
        periodDays,
        lines,
        totals,
        truncated,
        truncatedDetails: detailBudget.exhausted,
        statementText: txt.join("\n"),
        generatedAt,
      });
    }),
  );

  server.registerTool(
    track("pinch_get_split_status"),
    {
      title: "Split payment status",
      description:
        "Track a split bill created with pinch_create_split: who has paid, who is outstanding, who failed " +
        "(with plain-English dishonour diagnosis), and the exposure risk of parties carrying cost too long. " +
        "Reconstructs everything from Pinch payment links + payments tagged with the split id — nothing is " +
        "stored outside Pinch. Scans up to 5 pages of links/payments (truncated:true if the split may be older).",
      inputSchema: {
        splitId: z.string().describe("Split id returned by pinch_create_split, e.g. spl_Ab3xY9kQ2m"),
      },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ splitId }) => {
      const client = getClient();

      // 1) Find this split's payment links (list items include metadata —
      //    verified empirically against the sandbox; the docs omit the field).
      const linksResult = await client.getAllPages<AnyRecord>("/payment-links");
      const splitLinks = linksResult.items.filter(
        (l) => typeof l.metadata === "string" && l.metadata.includes(splitId),
      );

      // 2) Processed payments carry the link's metadata after completion —
      //    both the confirmation source and the fallback if links age out.
      const paymentsResult = await client.getAllPages<AnyRecord>("/payments/processed", {
        startDate: todayPlus(-180),
      });
      const splitPayments = paymentsResult.items.filter(
        (p) => typeof p.metadata === "string" && p.metadata.includes(splitId),
      );

      const truncated = linksResult.truncated || paymentsResult.truncated;
      if (splitLinks.length === 0 && splitPayments.length === 0) {
        return errorResult(
          `No payment links or payments found for split ${splitId}` +
            (truncated ? " within the scanned pages (5-page cap — the split may be older)." : "."),
          { splitId, truncated },
        );
      }

      // Build one party record per link (or per orphan payment as fallback).
      const today = todayPlus(0);
      const daysBetween = (fromDate: string, toDate: string): number =>
        Math.max(0, Math.round((Date.parse(toDate) - Date.parse(fromDate)) / 86_400_000));

      interface Party {
        part: string;
        name: string;
        email: string | null;
        payerId: string | null;
        amountCents: number;
        amountAud: string;
        status: "paid" | "pending" | "failed";
        paidAt: string | null;
        daysOutstanding: number | null;
        linkId: string | null;
        linkUrl: string | null;
        dishonour?: { code: string; plainEnglish: string; recommendedAction: string };
      }

      let description = "";
      let totalCents = 0;
      let dueDate: string | null = null;
      const detailBudget = newDetailBudget();

      const parties: Party[] = [];
      for (const link of splitLinks) {
        const meta = parseSplitMeta(link.metadata) ?? {};
        if (meta.description && !description) description = meta.description;
        if (typeof meta.totalCents === "number") totalCents = meta.totalCents;
        if (meta.dueDate) dueDate = meta.dueDate;

        const amountCents: number =
          typeof link.amountInCents === "number" ? link.amountInCents : (meta.amountCents ?? 0);
        const payerId: string | null = link.payer?.id ?? null;
        const name: string =
          link.payer?.fullName ??
          ([link.payer?.firstName, link.payer?.lastName].filter(Boolean).join(" ") || "(unknown)");

        // Payments for this party: nested on the link object, plus any
        // processed payment carrying the split metadata for the same payer.
        const nested: AnyRecord[] = Array.isArray(link.payments) ? link.payments : [];
        const matched = splitPayments.filter(
          (p) => extractPayerId(p) === payerId && centsOf(p) === amountCents,
        );
        const all = [...nested, ...matched];

        const success = all.find((p) => SUCCESS_STATUSES.has(p.status));
        const dishonoured = all.find((p) => p.status === "dishonoured");

        let status: Party["status"] = "pending";
        let paidAt: string | null = null;
        let dishonourOut: Party["dishonour"];
        if (success) {
          status = "paid";
          paidAt = pinchDate(success.transactionDate) || null;
        } else if (dishonoured) {
          status = "failed";
          const diagnosis = diagnoseDishonour(
            (await resolveDishonour(client, dishonoured, detailBudget))?.type,
          );
          dishonourOut = {
            code: diagnosis.code,
            plainEnglish: diagnosis.plainEnglish,
            recommendedAction: diagnosis.recommendedAction,
          };
        }

        // Outstanding age: from the createdAt we stamped into metadata,
        // falling back to dueDate (link objects expose no creation date).
        const anchor = meta.createdAt ?? meta.dueDate ?? null;
        const daysOutstanding = status !== "paid" && anchor ? daysBetween(anchor, today) : null;

        parties.push({
          part: meta.part ?? "?",
          name,
          email: link.payer?.emailAddress ?? meta.email ?? null,
          payerId,
          amountCents,
          amountAud: formatAud(amountCents),
          status,
          paidAt,
          daysOutstanding,
          linkId: link.id ?? null,
          linkUrl: link.url ?? null,
          ...(dishonourOut ? { dishonour: dishonourOut } : {}),
        });
      }

      // (party email lives in the split metadata — link list items omit
      // payer.emailAddress, verified empirically)

      // Fallback: payments tagged with the split whose link no longer appears
      // in the scanned pages (deleted or aged out) still count as parties.
      const coveredPayers = new Set(parties.map((p) => p.payerId));
      for (const p of splitPayments) {
        const payerId = extractPayerId(p) ?? null;
        if (coveredPayers.has(payerId)) continue;
        coveredPayers.add(payerId);
        const meta = parseSplitMeta(p.metadata) ?? {};
        if (typeof meta.totalCents === "number") totalCents = totalCents || meta.totalCents;
        const ok = SUCCESS_STATUSES.has(p.status);
        const diagnosis = ok
          ? undefined
          : diagnoseDishonour((await resolveDishonour(client, p, detailBudget))?.type);
        parties.push({
          part: meta.part ?? "?",
          name:
            p.payer?.fullName ??
            ([p.payer?.firstName, p.payer?.lastName].filter(Boolean).join(" ") || "(unknown)"),
          email: p.payer?.emailAddress ?? null,
          payerId,
          amountCents: centsOf(p),
          amountAud: formatAud(centsOf(p)),
          status: ok ? "paid" : "failed",
          paidAt: ok ? pinchDate(p.transactionDate) || null : null,
          daysOutstanding: null,
          linkId: null,
          linkUrl: null,
          ...(diagnosis
            ? {
                dishonour: {
                  code: diagnosis.code,
                  plainEnglish: diagnosis.plainEnglish,
                  recommendedAction: diagnosis.recommendedAction,
                },
              }
            : {}),
        });
      }

      parties.sort((a, b) => a.part.localeCompare(b.part, undefined, { numeric: true }));

      const collectedCents = parties
        .filter((p) => p.status === "paid")
        .reduce((s, p) => s + p.amountCents, 0);
      const partsSumCents = parties.reduce((s, p) => s + p.amountCents, 0);
      if (!totalCents) totalCents = partsSumCents;
      const outstandingCents = totalCents - collectedCents;

      // Exposure: who is carrying the cost, and for how long?
      const outstanding = parties.filter((p) => p.status !== "paid");
      const largest = outstanding.reduce<Party | null>(
        (best, p) => (best === null || p.amountCents > best.amountCents ? p : best),
        null,
      );
      let riskNote: string;
      if (outstanding.length === 0) {
        riskNote = "Fully collected — no outstanding exposure on this split.";
      } else if (largest) {
        const ageText =
          largest.daysOutstanding !== null ? ` for ${largest.daysOutstanding} days` : "";
        riskNote =
          largest.daysOutstanding !== null && largest.daysOutstanding >= 14
            ? `${largest.name} has owed ${largest.amountAud}${ageText} — consider escalating.`
            : `${largest.name} still owes ${largest.amountAud}${ageText} — ${formatAud(outstandingCents)} of the bill is being carried by whoever fronted it.`;
      } else {
        riskNote = `${formatAud(outstandingCents)} outstanding across ${outstanding.length} parties.`;
      }

      const suggestedActions = outstanding.map((p) =>
        p.status === "failed" && p.dishonour
          ? `Payment from ${p.name} FAILED (${p.dishonour.code}) — ${p.dishonour.recommendedAction}`
          : `Chase ${p.name}${p.email ? ` (${p.email})` : ""} for ${p.amountAud}` +
            (p.linkUrl ? ` — resend their link: ${p.linkUrl}` : ""),
      );

      return jsonResult({
        splitId,
        description: description || "(unknown — created outside pinch_create_split?)",
        dueDate,
        totalCents,
        totalAud: formatAud(totalCents),
        collectedCents,
        collectedAud: formatAud(collectedCents),
        outstandingCents,
        outstandingAud: formatAud(outstandingCents),
        parties,
        exposure: {
          settledParties: parties.length - outstanding.length,
          outstandingParties: outstanding.length,
          largestOutstanding: largest
            ? { name: largest.name, amountAud: largest.amountAud, daysOutstanding: largest.daysOutstanding }
            : null,
          riskNote,
        },
        suggestedActions,
        truncated,
        truncatedDetails: detailBudget.exhausted,
        generatedAt: new Date().toISOString(),
      });
    }),
  );

  // =========================================================================
  // WRITE TOOLS — all guarded behind confirm:true
  // =========================================================================

  const confirmParam = z
    .boolean()
    .optional()
    .describe(
      "Must be exactly true to execute. Anything else returns a preview of what WOULD happen, for human approval.",
    );

  server.registerTool(
    track("pinch_create_payment_link"),
    {
      title: "Create payment link (guarded)",
      description:
        "Create a Pinch hosted payment link (checkout page) for a payer — the standard way to (re-)collect payment " +
        "or capture new card/bank details after a hard dishonour. Identify the payer by payerEmail (looked up, or " +
        "created if new) or payerId. The API REQUIRES allowedPaymentMethods (defaulted to both). After payment the " +
        "customer is redirected to returnUrl with ?paymentLinkId=&paymentId= appended. Optional metadata is passed " +
        "through to the resulting Payment object — useful for correlating the payment back to your records. " +
        "GUARDED: without confirm:true this only returns a preview and calls no API.",
      inputSchema: {
        amountCents: z.number().int().positive().describe("Amount in integer cents (AUD), e.g. 5900 = $59.00"),
        description: z.string().min(1).max(999).describe("Description shown to the payer on the checkout page"),
        payerEmail: z
          .string()
          .email()
          .optional()
          .describe("Payer email — existing payer is matched by email, otherwise a new payer is created"),
        payerId: z.string().optional().describe("Existing payer id (pyr_...) — skips the email lookup"),
        allowedPaymentMethods: z
          .array(z.enum(["credit-card", "bank-account"]))
          .min(1)
          .optional()
          .describe(
            'Payment methods offered on the checkout page. REQUIRED by the Pinch API — defaults to ["credit-card","bank-account"].',
          ),
        metadata: z
          .string()
          .optional()
          .describe(
            "Free text (JSON preferred) passed through to the resulting Payment object — use for correlation ids",
          ),
        confirm: confirmParam,
      },
    },
    safe(async ({ amountCents, description, payerEmail, payerId, allowedPaymentMethods, metadata, confirm }) => {
      if (!payerEmail && !payerId) {
        return errorResult("Provide payerEmail or payerId — Pinch payment links are always tied to a payer.");
      }
      const methods = allowedPaymentMethods ?? ["credit-card", "bank-account"];

      if (confirm !== true) {
        return previewResult(
          `Create a Pinch hosted payment link for ${formatAud(amountCents)} (“${description}”) addressed to ` +
            `${payerId ?? payerEmail}, accepting ${methods.join(" + ")}. If the email doesn't match an existing ` +
            `payer, a new payer record will be created.`,
          {
            amountCents,
            amount: formatAud(amountCents),
            description,
            payerEmail,
            payerId,
            allowedPaymentMethods: methods,
            metadata: metadata ?? null,
          },
        );
      }

      const client = getClient();

      // Resolve (or create) the payer.
      let resolvedPayerId = payerId;
      let payerCreated = false;
      if (!resolvedPayerId && payerEmail) {
        const { items } = await client.getAllPages<AnyRecord>("/payers", { filter: payerEmail });
        const match = items.find(
          (p) => (p.emailAddress ?? "").toLowerCase() === payerEmail.toLowerCase(),
        );
        if (match) {
          resolvedPayerId = match.id;
        } else {
          const created = await client.post<AnyRecord>("/payers", {
            firstName: payerEmail.split("@")[0] || "Customer",
            emailAddress: payerEmail,
          });
          resolvedPayerId = created.id;
          payerCreated = true;
        }
      }

      const link = await client.post<AnyRecord>("/payment-links", {
        payerId: resolvedPayerId,
        amount: amountCents,
        description,
        // REQUIRED by the API (empirically returns 400 without it).
        allowedPaymentMethods: methods,
        // returnUrl is required by the API; Pinch appends ?paymentLinkId=&paymentId= on redirect.
        returnUrl: process.env.PINCH_RETURN_URL ?? "https://getpinch.com.au",
        ...(metadata !== undefined ? { metadata } : {}),
      });

      return jsonResult({
        created: true,
        paymentLinkId: link.id,
        url: link.url,
        amountCents,
        amount: formatAud(amountCents),
        payerId: resolvedPayerId,
        payerCreated,
        allowedPaymentMethods: methods,
        metadata: metadata ?? null,
        note:
          "Send this URL to the customer — paying it also stores their new payment method. On completion they are " +
          "redirected to returnUrl with ?paymentLinkId=&paymentId= appended; any metadata is copied onto the Payment.",
      });
    }),
  );

  server.registerTool(
    track("pinch_retry_payment"),
    {
      title: "Retry a dishonoured payment (guarded)",
      description:
        "Retry a FAILED payment by creating a new scheduled payment cloned from the dishonoured original (Pinch's " +
        "documented retry pattern — the original keeps status 'dishonoured' as the audit trail). Defaults to " +
        "retrying 3 days out. Refuses non-dishonoured payments, and warns when the dishonour is a HARD failure " +
        "(retrying unchanged details cannot succeed — send a payment link instead). GUARDED: without confirm:true " +
        "this only returns a preview and creates nothing.",
      inputSchema: {
        paymentId: z.string().describe("The dishonoured payment id to retry, e.g. pmt_XXXXXXXXXXXXXXXX"),
        transactionDate: isoDate
          .optional()
          .describe("Date to run the retry (YYYY-MM-DD). Default: 3 days from today."),
        confirm: confirmParam,
      },
    },
    safe(async ({ paymentId, transactionDate, confirm }) => {
      const client = getClient();

      // Fetch + validate the original regardless of confirm — the preview
      // should reflect reality (GETs are safe).
      const original = await client.get<AnyRecord>(`/payments/${encodeURIComponent(paymentId)}`);
      if (original.status !== "dishonoured") {
        return errorResult(
          `Payment ${paymentId} has status "${original.status}" — only dishonoured payments can be retried.`,
        );
      }

      const dishonour = extractDishonour(original);
      const diagnosis = diagnoseDishonour(dishonour?.type);
      const retryDate = transactionDate ?? todayPlus(3);
      const payerIdOfOriginal = extractPayerId(original);

      // In the sandbox, failure-simulation markers (#insufficient-funds etc.)
      // live in the description — strip them from the clone so the retry can
      // succeed. Live descriptions are left untouched.
      let description: string = original.description ?? "Payment retry";
      if (client.env === "test") description = description.replace(/#[a-z-]+/gi, "").trim();
      description = `${description || "Payment retry"} (retry of ${paymentId})`.slice(0, 999);

      const hardWarning =
        diagnosis.retryable === "hard"
          ? `WARNING: "${diagnosis.code}" is a HARD failure — ${diagnosis.recommendedAction}`
          : undefined;

      if (confirm !== true) {
        return previewResult(
          `Create a new scheduled payment of ${formatAud(original.amount)} for payer ${payerIdOfOriginal} on ` +
            `${retryDate}, cloned from dishonoured payment ${paymentId} (${diagnosis.code}).` +
            (hardWarning ? ` ${hardWarning}` : ""),
          {
            originalPaymentId: paymentId,
            payerId: payerIdOfOriginal,
            amountCents: original.amount,
            amount: formatAud(original.amount),
            transactionDate: retryDate,
            description,
            dishonour: { ...dishonour, diagnosis },
            warning: hardWarning ?? null,
          },
        );
      }

      const retry = await client.post<AnyRecord>("/payments", {
        payerId: payerIdOfOriginal,
        amount: original.amount,
        transactionDate: retryDate,
        description,
        // Idempotency: one retry per original payment per retry date.
        nonce: `pinch-mcp-retry-${paymentId}-${retryDate}`,
      });

      return jsonResult({
        created: true,
        retryPaymentId: retry.id,
        originalPaymentId: paymentId,
        amountCents: retry.amount ?? original.amount,
        amount: formatAud(retry.amount ?? original.amount),
        transactionDate: retry.transactionDate ?? retryDate,
        status: retry.status,
        warning: hardWarning ?? null,
      });
    }),
  );

  server.registerTool(
    track("pinch_create_refund"),
    {
      title: "Create refund (guarded, capped)",
      description:
        "Refund a Pinch payment, fully (omit amountCents) or partially. Hard-capped by the PINCH_MAX_REFUND_CENTS " +
        `environment guard (currently ${formatAud(maxRefundCents)}) — larger refunds are rejected outright and must ` +
        "be done by a human in the Pinch portal. Refunds are only possible within 180 days of the original payment. " +
        "GUARDED: without confirm:true this only returns a preview and refunds nothing.",
      inputSchema: {
        paymentId: z.string().describe("The payment to refund, e.g. pmt_XXXXXXXXXXXXXXXX"),
        amountCents: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Refund amount in integer cents. Omit for a full refund of the original amount."),
        reason: z.string().optional().describe("Reason recorded against the refund"),
        confirm: confirmParam,
      },
    },
    safe(async ({ paymentId, amountCents, reason, confirm }) => {
      // Resolve the refund amount (full refund = original payment amount).
      // The client is only constructed when we actually need the API — an
      // explicit-amount preview works even before credentials are configured.
      let refundCents = amountCents;
      if (refundCents === undefined) {
        const original = await getClient().get<AnyRecord>(
          `/payments/${encodeURIComponent(paymentId)}`,
        );
        if (typeof original.amount !== "number") {
          return errorResult(`Could not determine the original amount of ${paymentId} for a full refund.`);
        }
        refundCents = original.amount;
      }

      // Safety cap — applies to previews AND executions, no override via MCP.
      if (refundCents > maxRefundCents) {
        return errorResult(
          `Refund of ${formatAud(refundCents)} exceeds the PINCH_MAX_REFUND_CENTS cap of ${formatAud(maxRefundCents)}. ` +
            "Raise the cap via environment config or process this refund manually in the Pinch portal.",
          { requestedCents: refundCents, maxRefundCents },
        );
      }

      const refundReason = reason ?? "Refund requested via pinch-mcp (human approved)";

      if (confirm !== true) {
        return previewResult(
          `Refund ${formatAud(refundCents)} of payment ${paymentId}` +
            (amountCents === undefined ? " (full refund)" : " (partial refund)") +
            `. Cap check passed (${formatAud(refundCents)} ≤ ${formatAud(maxRefundCents)}).`,
          {
            paymentId,
            amountCents: refundCents,
            amount: formatAud(refundCents),
            fullRefund: amountCents === undefined,
            reason: refundReason,
          },
        );
      }

      const refund = await getClient().post<AnyRecord>("/refunds", {
        paymentId,
        amount: refundCents,
        reason: refundReason,
        nonce: `pinch-mcp-refund-${paymentId}-${refundCents}`,
      });

      return jsonResult({
        created: true,
        refundId: refund.id,
        paymentId,
        amountCents: refundCents,
        amount: formatAud(refundCents),
        status: refund.status,
        note: "Refund fees are not returned by default; processing may take several business days.",
      });
    }),
  );

  server.registerTool(
    track("pinch_create_subscription"),
    {
      title: "Create subscription (guarded)",
      description:
        "Set up recurring billing: resolves (or creates) the payer, finds or creates a structurally matching Pinch " +
        "Plan, then creates a Subscription binding them. Intervals: weekly | fortnightly | monthly. Supports coach " +
        "revenue models: TERM billing via termPayments (stop after N collections, e.g. a 10-week season) or endDate " +
        "(stop by a date); a DEPOSIT via depositCents/depositDate collected before the recurring run starts (same " +
        "plan, fixedPayments); and metadata stamped on the plan — Pinch copies plan metadata onto every generated " +
        "payment, ideal for instructor/venue attribution. NOTE: Pinch requires the payer to have a stored payment " +
        "source before a subscription can exist — if they don't, this tool returns pendingSetup:true with a " +
        "setupLink that collects the first charge AND stores their method; re-call after it's paid. GUARDED: " +
        "without confirm:true nothing is written; the preview shows the full schedule (deposit, N payments, end " +
        "date, term total).",
      inputSchema: {
        payerEmail: z
          .string()
          .email()
          .optional()
          .describe("Payer email — existing payer matched by email, otherwise a new payer is created"),
        payerId: z.string().optional().describe("Existing payer id (pyr_...) — skips the email lookup"),
        payerName: z
          .string()
          .optional()
          .describe("Payer name, used only when a new payer is created (e.g. 'Sarah Miller')"),
        amountCents: z
          .number()
          .int()
          .positive()
          .describe("Recurring amount per interval, in integer cents (AUD), e.g. 5900 = $59.00"),
        interval: z
          .enum(["weekly", "fortnightly", "monthly"])
          .describe("Billing cadence: weekly (every 7 days), fortnightly (every 14 days), or monthly"),
        description: z.string().min(1).max(180).describe("What the subscription is for — shown on payments and the plan"),
        startDate: isoDate
          .optional()
          .describe("First RECURRING billing date (YYYY-MM-DD). Default: tomorrow."),
        termPayments: z
          .number()
          .int()
          .min(2)
          .max(104)
          .optional()
          .describe(
            "End the subscription after exactly N recurring collections (e.g. 10 for a 10-week term). Mutually exclusive with endDate.",
          ),
        endDate: isoDate
          .optional()
          .describe("End the subscription by this date (YYYY-MM-DD, must be after startDate). Mutually exclusive with termPayments."),
        depositCents: z
          .number()
          .int()
          .min(100)
          .optional()
          .describe("Optional upfront deposit in integer cents (min 100 = $1.00), collected before the recurring run"),
        depositDate: isoDate
          .optional()
          .describe("When to collect the deposit (YYYY-MM-DD). Default: today. Must be on/before startDate. Requires depositCents."),
        metadata: z
          .string()
          .optional()
          .describe(
            "Free text (JSON preferred) stored on the Plan — Pinch adds it to EVERY payment generated from the plan. " +
              'Use for attribution, e.g. {"instructorId":"coach_42"}. Different metadata ⇒ a separate plan.',
          ),
        confirm: confirmParam,
      },
    },
    safe(async (args) => {
      const {
        payerEmail, payerId, payerName, amountCents, interval, description,
        startDate, termPayments, endDate, depositCents, depositDate, metadata, confirm,
      } = args;
      if (!payerEmail && !payerId) {
        return errorResult("Provide payerEmail or payerId — a subscription is always tied to a payer.");
      }
      if (termPayments !== undefined && endDate !== undefined) {
        return errorResult("termPayments and endDate are mutually exclusive — pick one way to end the term.");
      }
      if (depositDate !== undefined && depositCents === undefined) {
        return errorResult("depositDate requires depositCents.");
      }

      const client = getClient();
      const start = startDate ?? todayPlus(1); // first recurring payment
      const freq = INTERVAL_MAP[interval];

      if (endDate !== undefined && daysFromTo(start, endDate) <= 0) {
        return errorResult(`endDate (${endDate}) must be after the first billing date (${start}).`);
      }
      const depDate = depositCents !== undefined ? (depositDate ?? todayPlus(0)) : undefined;
      if (depDate !== undefined && daysFromTo(depDate, start) < 0) {
        return errorResult(`depositDate (${depDate}) must be on or before the first recurring date (${start}).`);
      }

      // --- Build the schedule + the exact plan spec -------------------------
      // Subscription start anchors ALL plan offsets. With a deposit, the
      // subscription starts on the deposit date (deposit at offset 0, recurring
      // shifted by startDateOffset); otherwise it starts on the recurring date.
      const subStart = depDate ?? start;
      const recurringOffsetDays = daysFromTo(subStart, start);

      // Payments count + end date (exact for termPayments; derived for endDate).
      let paymentsCount: number | null = null;
      let lastPaymentDate: string | null = null;
      let endRule = "ongoing until cancelled";
      if (termPayments !== undefined) {
        paymentsCount = termPayments;
        lastPaymentDate = addIntervals(start, interval, termPayments - 1);
        endRule = `ends after ${termPayments} payments (last on ${lastPaymentDate})`;
      } else if (endDate !== undefined) {
        let n = 1;
        while (daysFromTo(addIntervals(start, interval, n), endDate) >= 0) n++;
        paymentsCount = n;
        lastPaymentDate = addIntervals(start, interval, n - 1);
        endRule = `ends by ${endDate} (${n} payments, last on ${lastPaymentDate})`;
      }
      const termTotalCents =
        paymentsCount !== null ? (depositCents ?? 0) + paymentsCount * amountCents : null;

      const schedule = {
        deposit:
          depositCents !== undefined
            ? { amountCents: depositCents, amountAud: formatAud(depositCents), date: depDate! }
            : null,
        recurring: {
          amountCents,
          amountAud: formatAud(amountCents),
          interval,
          firstPaymentDate: start,
          payments: paymentsCount ?? ("ongoing" as const),
          lastPaymentDate,
          endRule,
        },
        termTotalCents,
        termTotalAud: termTotalCents !== null ? formatAud(termTotalCents) : null,
      };

      // Informative plan name; identity is enforced structurally by the spec.
      const planName =
        `${description} (${interval} ${formatAud(amountCents)}` +
        (termPayments !== undefined ? `, ${termPayments} payments` : "") +
        (endDate !== undefined ? `, until ${endDate}` : "") +
        (depositCents !== undefined ? `, ${formatAud(depositCents)} deposit` : "") +
        `)`;
      const planSpec: PlanSpec = {
        name: planName.slice(0, 200),
        ...(metadata !== undefined ? { metadata } : {}),
        recurringPayment: {
          amountInCents: amountCents,
          description,
          ...(recurringOffsetDays > 0
            ? { startDateOffset: recurringOffsetDays, startDateInterval: "days" as const }
            : {}),
          frequencyOffset: freq.frequencyOffset,
          frequencyInterval: freq.frequencyInterval,
          // endType enum per ref-save-plan.md: never | end-date | total-amount |
          // number-of-payments | subscription-fully-paid.
          endType:
            termPayments !== undefined ? "number-of-payments" : endDate !== undefined ? "end-date" : "never",
          ...(termPayments !== undefined ? { endAfterNumberOfPayments: termPayments } : {}),
          ...(endDate !== undefined
            ? { endDateOffset: daysFromTo(subStart, endDate), endDateInterval: "days" as const }
            : {}),
          cancelPlanOnFailure: false,
        },
        ...(depositCents !== undefined
          ? {
              fixedPayments: [
                {
                  amountInCents: depositCents,
                  description: `${description} — deposit`,
                  scheduledDateOffset: 0,
                  scheduledDateInterval: "days" as const,
                  cancelPlanOnFailure: false,
                },
              ],
            }
          : {}),
      };

      // --- Resolve existing payer & plan (GETs only — safe in preview) ------
      let existingPayer: AnyRecord | undefined;
      if (payerId) {
        existingPayer = await client.get<AnyRecord>(`/payers/${encodeURIComponent(payerId)}`);
      } else if (payerEmail) {
        const { items } = await client.getAllPages<AnyRecord>("/payers", { filter: payerEmail });
        existingPayer = items.find(
          (p) => (p.emailAddress ?? "").toLowerCase() === payerEmail.toLowerCase(),
        );
      }

      const { items: plans } = await client.getAllPages<AnyRecord>("/plans");
      const existingPlan = plans.find((p) => planMatchesSpec(p, planSpec));

      const payerSummary = existingPayer
        ? {
            id: existingPayer.id,
            name:
              existingPayer.fullName ??
              [existingPayer.firstName, existingPayer.lastName].filter(Boolean).join(" "),
            email: existingPayer.emailAddress,
          }
        : ("would create" as const);
      const planSummary = existingPlan
        ? { id: existingPlan.id, name: existingPlan.name }
        : ("would create" as const);

      if (confirm !== true) {
        const scheduleWords =
          (schedule.deposit ? `${schedule.deposit.amountAud} deposit on ${schedule.deposit.date}, then ` : "") +
          `${paymentsCount ?? "ongoing"} ${interval} payment${paymentsCount === 1 ? "" : "s"} of ` +
          `${formatAud(amountCents)} starting ${start}` +
          (lastPaymentDate ? `, last on ${lastPaymentDate}` : ", until cancelled") +
          (termTotalCents !== null ? ` — ${formatAud(termTotalCents)} total over the term` : "");
        return jsonResult({
          preview: true,
          wouldDo:
            `Create a subscription (“${description}”) for ` +
            `${existingPayer ? `existing payer ${existingPayer.id}` : `new payer ${payerEmail}`}: ${scheduleWords}. ` +
            `Uses ${existingPlan ? `existing plan ${existingPlan.id}` : `a new plan “${planSpec.name}”`}. ` +
            `If the payer has no stored payment method, a setup payment link will also be created.`,
          resolvedPayer: payerSummary,
          plan: planSummary,
          schedule,
          params: {
            payerEmail,
            payerId,
            payerName,
            amountCents,
            amount: formatAud(amountCents),
            interval,
            description,
            startDate: start,
            subscriptionStartDate: subStart,
            termPayments: termPayments ?? null,
            endDate: endDate ?? null,
            depositCents: depositCents ?? null,
            depositDate: depDate ?? null,
            metadata: metadata ?? null,
            planName: planSpec.name,
          },
          note: "Re-call with confirm:true after human approval",
        });
      }

      // --- Execute: payer → plan → subscription (→ setup link if needed) ----
      let resolvedPayer = existingPayer;
      let payerCreated = false;
      if (!resolvedPayer) {
        const nameParts = (payerName ?? "").trim().split(/\s+/).filter(Boolean);
        resolvedPayer = await client.post<AnyRecord>("/payers", {
          firstName: nameParts[0] || payerEmail!.split("@")[0] || "Customer",
          lastName: nameParts.slice(1).join(" ") || undefined,
          emailAddress: payerEmail,
        });
        payerCreated = true;
      }

      let plan = existingPlan;
      let planCreated = false;
      if (!plan) {
        // The spec IS the request body — field names verified against the
        // ref-save-plan.md OpenAPI schema (endType, endAfterNumberOfPayments,
        // endDateOffset/Interval, startDateOffset, fixedPayments, metadata).
        plan = await client.post<AnyRecord>("/plans", planSpec);
        planCreated = true;
      }

      // EMPIRICAL: POST /subscriptions returns 400 ("Payer does not have any
      // valid payment sources") for a source-less payer — despite the docs
      // implying sourceId is optional/auto-selected. So check sources FIRST;
      // when absent, degrade to: plan (reusable) + a setup payment link that
      // collects the first charge AND stores the payment method — then this
      // tool can be re-called to actually create the subscription.
      // (Re-fetch the payer detail — list results don't include sources.)
      const payerDetail = await client.get<AnyRecord>(
        `/payers/${encodeURIComponent(resolvedPayer.id)}`,
      );
      const sources: AnyRecord[] = Array.isArray(payerDetail.sources)
        ? payerDetail.sources
        : payerDetail.source && typeof payerDetail.source === "object"
          ? [payerDetail.source]
          : [];

      if (sources.length === 0) {
        const firstChargeCents = depositCents ?? amountCents;
        const firstChargeLabel = depositCents !== undefined ? "deposit" : `first ${interval} payment`;
        const link = await client.post<AnyRecord>("/payment-links", {
          payerId: resolvedPayer.id,
          amount: firstChargeCents,
          description: `${description} — ${firstChargeLabel} & payment method setup`,
          allowedPaymentMethods: ["credit-card", "bank-account"],
          returnUrl: process.env.PINCH_RETURN_URL ?? "https://getpinch.com.au",
        });
        return jsonResult({
          created: false,
          pendingSetup: true,
          subscriptionId: null,
          schedule,
          payer: { id: resolvedPayer.id, created: payerCreated },
          plan: { id: plan.id, name: plan.name ?? planSpec.name, created: planCreated },
          setupLink: { id: link.id, url: link.url },
          note:
            "SUBSCRIPTION NOT CREATED YET — Pinch requires the payer to have a stored payment source before a " +
            `subscription can be created (verified API behaviour). Send the customer the setupLink: paying it ` +
            `collects the ${firstChargeLabel} (${formatAud(firstChargeCents)}) AND stores their payment method. ` +
            "Then re-call pinch_create_subscription with confirm:true — the plan is already in place and will be " +
            "reused. If the setup link collected the deposit/first payment, shift startDate/depositDate so the " +
            "subscription doesn't double-charge it.",
        });
      }

      const subscription = await client.post<AnyRecord>("/subscriptions", {
        planId: plan.id,
        payerId: resolvedPayer.id,
        // With a deposit, the subscription starts on the deposit date (deposit
        // at offset 0; recurring shifted by startDateOffset in the plan).
        startDate: subStart,
      });

      return jsonResult({
        created: true,
        subscriptionId: subscription.id,
        status: subscription.status,
        startDate: subscription.startDate ?? subStart,
        interval,
        amountCents,
        amount: formatAud(amountCents),
        schedule,
        payer: { id: resolvedPayer.id, created: payerCreated },
        plan: { id: plan.id, name: plan.name ?? planSpec.name, created: planCreated },
        setupLink: null,
        note: "Payer has a stored payment method — Pinch will collect the schedule automatically.",
      });
    }),
  );

  server.registerTool(
    track("pinch_cancel_subscription"),
    {
      title: "Cancel subscription (guarded)",
      description:
        "Cancel a Pinch subscription (DELETE /subscriptions/{id}). Per the Pinch docs: payments already in " +
        "processing complete as normal; all future scheduled payments are deleted. The payer's stored payment " +
        "sources are NOT removed and remain usable for other payments/subscriptions. Cancellation is permanent — " +
        "to resume billing, create a new subscription. GUARDED: without confirm:true this only returns a preview " +
        "of the subscription that would be cancelled, and calls no write API.",
      inputSchema: {
        subscriptionId: z.string().describe("Subscription id to cancel, e.g. sub_XXXXXXXXXXXXXXXX"),
        confirm: confirmParam,
      },
    },
    safe(async ({ subscriptionId, confirm }) => {
      const client = getClient();

      // Fetch first (safe GET) — the preview must reflect the real record,
      // and we refuse to "cancel" something that is already terminal.
      const sub = await client.get<AnyRecord>(
        `/subscriptions/${encodeURIComponent(subscriptionId)}`,
      );
      if (sub.status === "cancelled" || sub.status === "complete") {
        return errorResult(
          `Subscription ${subscriptionId} is already "${sub.status}" — nothing to cancel.`,
          { subscriptionId, status: sub.status },
        );
      }

      const recurringCents: number | undefined =
        typeof sub.recurringPayment?.amount === "number"
          ? sub.recurringPayment.amount
          : typeof sub.recurringPayment?.amountInCents === "number"
            ? sub.recurringPayment.amountInCents
            : undefined;

      const subSummary = {
        id: sub.id,
        status: sub.status,
        planName: sub.planName ?? undefined,
        payerId: sub.payer?.id ?? sub.payerId,
        amount: recurringCents !== undefined ? formatAud(recurringCents) : undefined,
      };

      if (confirm !== true) {
        return jsonResult({
          preview: true,
          wouldDo:
            `Cancel subscription ${subscriptionId}` +
            (subSummary.planName ? ` (“${subSummary.planName}”` : " (") +
            (subSummary.amount ? `${subSummary.planName ? ", " : ""}${subSummary.amount} recurring` : "") +
            `) for payer ${subSummary.payerId}. In-flight payments complete; all future scheduled payments are ` +
            `deleted. This cannot be undone — resuming requires a new subscription.`,
          subscription: subSummary,
          note: "Re-call with confirm:true after human approval",
        });
      }

      // DELETE /subscriptions/{id} returns 200 with no body — re-fetch for the
      // authoritative post-cancel status.
      await client.request("DELETE", `/subscriptions/${encodeURIComponent(subscriptionId)}`);
      let finalStatus = "cancelled";
      try {
        const after = await client.get<AnyRecord>(
          `/subscriptions/${encodeURIComponent(subscriptionId)}`,
        );
        finalStatus = after.status ?? finalStatus;
      } catch {
        // Some APIs 404 deleted resources — treat as cancelled.
      }

      return jsonResult({
        cancelled: true,
        subscriptionId,
        status: finalStatus,
        note:
          "Future scheduled payments have been deleted; any payment already in processing will still complete. " +
          "The payer's stored payment method was not removed.",
      });
    }),
  );

  server.registerTool(
    track("pinch_create_split"),
    {
      title: "Create split payment (guarded)",
      description:
        "Split a shared bill (trainers splitting studio rent, coaches sharing a venue hire, clubs co-funding a " +
        "tournament) across 2–10 parties: each " +
        "party gets their own Pinch hosted payment link for their share, tagged with a common split id so " +
        "pinch_get_split_status can track who's paid and quantify exposure. Shares are given either as explicit " +
        "amountCents per party, or as sharePercent (requires totalCents; cents are allocated largest-remainder so " +
        "they always sum exactly). GUARDED: without confirm:true this returns the allocation table only — zero writes.",
      inputSchema: {
        description: z.string().min(1).max(160).describe("What the shared bill is for, e.g. 'August studio rent + utilities'"),
        totalCents: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Total bill in integer cents. Required with sharePercent parts; optional (validated) with explicit amounts."),
        parts: z
          .array(
            z.object({
              email: z.string().email().describe("Party's email — payer is matched or created"),
              name: z.string().optional().describe("Party's name (used if a new payer is created)"),
              amountCents: z.number().int().positive().optional().describe("This party's share in integer cents"),
              sharePercent: z.number().positive().max(100).optional().describe("This party's share as a percentage (e.g. 50)"),
            }),
          )
          .min(2)
          .max(10)
          .describe("2–10 parties. ALL parts must use amountCents, or ALL must use sharePercent — no mixing."),
        dueDate: isoDate.optional().describe("Optional due date (YYYY-MM-DD) — used for exposure/ageing in status reports"),
        allowedPaymentMethods: z
          .array(z.enum(["credit-card", "bank-account"]))
          .min(1)
          .optional()
          .describe('Payment methods offered on each link (default ["credit-card","bank-account"])'),
        confirm: confirmParam,
      },
    },
    safe(async ({ description, totalCents, parts, dueDate, allowedPaymentMethods, confirm }) => {
      // ---- Validate share specification ----------------------------------
      const withAmount = parts.filter((p) => p.amountCents !== undefined);
      const withPercent = parts.filter((p) => p.sharePercent !== undefined);
      const missing = parts.filter((p) => p.amountCents === undefined && p.sharePercent === undefined);
      if (missing.length > 0) {
        return errorResult("Every part needs amountCents or sharePercent.", {
          partsMissingShare: missing.map((p) => p.email),
        });
      }
      if (withAmount.length > 0 && withPercent.length > 0) {
        return errorResult(
          "Mixed share modes: use amountCents for ALL parts or sharePercent for ALL parts, not a mixture.",
        );
      }

      let allocatedCents: number[];
      let resolvedTotal: number;
      if (withPercent.length === parts.length) {
        const pctSum = parts.reduce((s, p) => s + (p.sharePercent ?? 0), 0);
        if (Math.abs(pctSum - 100) > 0.01) {
          return errorResult(`sharePercent values must sum to 100 (±0.01); got ${pctSum}.`);
        }
        if (totalCents === undefined) {
          return errorResult("totalCents is required when shares are given as percentages.");
        }
        resolvedTotal = totalCents;
        allocatedCents = allocateByPercent(totalCents, parts.map((p) => p.sharePercent!));
      } else {
        const sum = parts.reduce((s, p) => s + (p.amountCents ?? 0), 0);
        if (totalCents !== undefined && totalCents !== sum) {
          return errorResult(
            `Explicit amounts sum to ${formatAud(sum)} but totalCents says ${formatAud(totalCents)} — they must match (or omit totalCents).`,
            { sumCents: sum, totalCents },
          );
        }
        resolvedTotal = sum;
        allocatedCents = parts.map((p) => p.amountCents!);
      }

      const methods = allowedPaymentMethods ?? ["credit-card", "bank-account"];
      const allocation = parts.map((p, i) => ({
        part: `${i + 1}/${parts.length}`,
        email: p.email,
        name: p.name ?? p.email.split("@")[0],
        sharePercent: p.sharePercent ?? Number(((allocatedCents[i] / resolvedTotal) * 100).toFixed(2)),
        amountCents: allocatedCents[i],
        amountAud: formatAud(allocatedCents[i]),
      }));

      if (confirm !== true) {
        return jsonResult({
          preview: true,
          splitId: "(will be generated)",
          wouldDo:
            `Split “${description}” (${formatAud(resolvedTotal)} total) across ${parts.length} parties: create ` +
            `one hosted payment link per party (amounts below, summing exactly to ${formatAud(resolvedTotal)}), ` +
            `each tagged with the split id for status tracking. Payers are matched by email or created.`,
          totalCents: resolvedTotal,
          totalAud: formatAud(resolvedTotal),
          allocation,
          dueDate: dueDate ?? null,
          allowedPaymentMethods: methods,
          note: "Re-call with confirm:true after human approval",
        });
      }

      // ---- Execute: payer + tagged payment link per party -----------------
      const client = getClient();
      const splitId = newSplitId();
      const createdAtDate = todayPlus(0);
      const outParts: AnyRecord[] = [];
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        const { payer } = await ensurePayer(client, part.email, part.name);
        // Metadata must be valid JSON per the Pinch metadata guide — we store
        // the split envelope here; it passes through to the Payment on payment.
        const meta: SplitMeta = {
          split: splitId,
          part: `${i + 1}/${parts.length}`,
          totalCents: resolvedTotal,
          amountCents: allocatedCents[i],
          description,
          email: part.email,
          createdAt: createdAtDate,
          dueDate: dueDate ?? null,
        };
        const link = await client.post<AnyRecord>("/payment-links", {
          payerId: payer.id,
          amount: allocatedCents[i],
          description: `${description} — split share`,
          allowedPaymentMethods: methods,
          returnUrl: process.env.PINCH_RETURN_URL ?? "https://getpinch.com.au",
          metadata: JSON.stringify(meta),
        });
        outParts.push({
          part: meta.part,
          payerId: payer.id,
          name: allocation[i].name,
          email: part.email,
          amountCents: allocatedCents[i],
          amountAud: formatAud(allocatedCents[i]),
          linkId: link.id,
          linkUrl: link.url,
        });
      }

      return jsonResult({
        splitId,
        description,
        totalCents: resolvedTotal,
        totalAud: formatAud(resolvedTotal),
        dueDate: dueDate ?? null,
        parts: outParts,
        createdAt: new Date().toISOString(),
        note:
          `Share each party their own link. Track collection anytime with pinch_get_split_status {splitId: "${splitId}"} — ` +
          "paid links pass the split metadata through to the resulting Payment automatically.",
      });
    }),
  );

  // Kept ≤280 chars — downstream aiToolSchema hard-caps descriptions at 300
  // and silently breaks template instantiation beyond it.
  const DESIGN_BILLING_DESC =
    "Deterministic billing-blueprint compiler: maps structured components (membership, term, package, " +
    "per_session, one_off, split) to Pinch primitives with schedules, indicative fees, a timeline and review " +
    "flags. No writes without confirm:true; then provisions only the ready subset.";
  if (DESIGN_BILLING_DESC.length > 280) {
    throw new Error(`pinch_design_billing description is ${DESIGN_BILLING_DESC.length} chars (max 280).`);
  }

  server.registerTool(
    track("pinch_design_billing"),
    {
      title: "Design billing blueprint (guarded)",
      description: DESIGN_BILLING_DESC,
      inputSchema: {
        businessName: z.string().max(120).optional().describe("Merchant/business name for the blueprint header"),
        components: z
          .array(
            z.object({
              kind: z.enum(["membership", "term", "package", "per_session", "one_off", "split"]),
              name: z.string().min(1).max(120).describe("Component name, e.g. 'Adult membership'"),
              amountCents: z.number().int().positive().describe("Charge amount in integer cents (per interval / per session / total for one_off & split)"),
              interval: z.enum(["weekly", "fortnightly", "monthly"]).optional().describe("Billing cadence (membership/term; package instalments)"),
              termPayments: z.number().int().min(2).max(104).optional().describe("Number of collections for term/package instalments"),
              depositCents: z.number().int().min(100).optional().describe("Upfront deposit in cents (term/package)"),
              parties: z
                .array(
                  z.object({
                    email: z.string().email(),
                    name: z.string().optional(),
                    amountCents: z.number().int().positive().optional(),
                    sharePercent: z.number().positive().max(100).optional(),
                  }),
                )
                .max(10)
                .optional()
                .describe("Split parties (≥2 to provision; omit for event-driven splits)"),
              payerEmail: z.string().email().optional().describe("Known customer email — makes the component provisionable now"),
              notes: z.string().max(300).optional(),
            }),
          )
          .min(1)
          .max(8)
          .describe("1–8 billing components extracted from the merchant's model"),
        platformFeePercent: z.number().min(0).max(30).optional().describe("Platform's retained fee % — flagged for review, never auto-provisioned"),
        retryPolicy: z.object({ softRetryDays: z.number().int().min(1).max(30).optional() }).optional(),
        pausePolicy: z.object({ pausesPerYear: z.number().int().min(0).max(12).optional() }).optional(),
        startDate: isoDate.optional().describe("Blueprint anchor date (YYYY-MM-DD). Default: tomorrow."),
        metadata: z.string().optional().describe("Attribution metadata (JSON preferred) applied to provisioned plans"),
        confirm: confirmParam,
      },
    },
    safe(async ({ businessName, components, platformFeePercent, retryPolicy, pausePolicy, startDate, metadata, confirm }) => {
      // ---- Deterministic validation ---------------------------------------
      const errors = components
        .map((c) => validateDesignComponent(c as DesignComponentInput))
        .filter((e): e is string => e !== null);
      if (errors.length > 0) return errorResult("Blueprint validation failed.", { errors });

      const anchor = startDate ?? todayPlus(1);
      const horizon = new Date(Date.parse(`${anchor}T00:00:00Z`) + 30 * 86_400_000)
        .toISOString()
        .slice(0, 10);

      // ---- Compile every component (pure, zero I/O) -----------------------
      const compiled = components.map((c) =>
        compileBillingComponent(c as DesignComponentInput, anchor, horizon, platformFeePercent),
      );

      // Plan-reuse check (GETs only — allowed in blueprint mode) for
      // subscription-shaped components, so the blueprint says reuse vs create.
      try {
        const { items: plans } = await getClient().getAllPages<AnyRecord>("/plans");
        for (let i = 0; i < components.length; i++) {
          const c = components[i] as DesignComponentInput;
          if ((c.kind === "membership" || c.kind === "term" || (c.kind === "package" && c.termPayments)) && c.interval) {
            const hit = plans.find(
              (p) =>
                p.recurringPayment?.amountInCents === c.amountCents &&
                p.recurringPayment?.frequencyOffset === INTERVAL_MAP[c.interval!].frequencyOffset &&
                p.recurringPayment?.frequencyInterval === INTERVAL_MAP[c.interval!].frequencyInterval,
            );
            if (hit) compiled[i].component.flags.push(`similar existing plan found (${hit.id} “${hit.name}”) — structural match decides reuse at provision time`);
          }
        }
      } catch {
        /* no credentials / API unreachable — blueprint still compiles */
      }

      // ---- Timeline + totals ----------------------------------------------
      const allEvents = compiled
        .flatMap((cc) => cc.events)
        .sort((a, b) => a.date.localeCompare(b.date));
      const timeline = allEvents.slice(0, 10).map((e) => ({
        date: e.date,
        componentName: e.componentName,
        description: e.description,
        amountAud: e.amountAud,
      }));

      const grossFirstMonth = allEvents.reduce((s, e) => s + e.amountCents, 0);
      const feesFirstMonth = allEvents.reduce((s, e) => s + estFeeCents(e.amountCents), 0);
      const platformFirstMonth =
        platformFeePercent !== undefined
          ? allEvents.reduce((s, e) => s + Math.round((e.amountCents * platformFeePercent) / 100), 0)
          : 0;
      const netFirstMonth = grossFirstMonth - feesFirstMonth - platformFirstMonth;

      const perIntervalMap = new Map<string, { components: number; grossCents: number }>();
      for (const c of components as DesignComponentInput[]) {
        if ((c.kind === "membership" || c.kind === "term") && c.interval) {
          const entry = perIntervalMap.get(c.interval) ?? { components: 0, grossCents: 0 };
          entry.components++;
          entry.grossCents += c.amountCents;
          perIntervalMap.set(c.interval, entry);
        }
      }
      const totals = {
        perInterval: [...perIntervalMap.entries()].map(([interval, v]) => ({
          interval,
          components: v.components,
          grossCents: v.grossCents,
          grossAud: formatAud(v.grossCents),
        })),
        firstMonthGrossCents: grossFirstMonth,
        firstMonthGrossAud: formatAud(grossFirstMonth),
        estFirstMonthNetCents: netFirstMonth,
        estFirstMonthNetAud: formatAud(netFirstMonth),
        feeBasis: FEE_BASIS,
      };

      // ---- Policies + review flags ----------------------------------------
      const softDays = retryPolicy?.softRetryDays ?? 3;
      const policyNotes: string[] = [
        `Soft-failure retry after ${softDays} days — matches the insufficient-funds playbook (retry ~3 days, ` +
          `friendly nudge, pause after 3 consecutive failures). Hard failures are never blind-retried: send a ` +
          `payment link to update details instead.`,
      ];
      if (pausePolicy?.pausesPerYear !== undefined) {
        policyNotes.push(
          `Pause maps to cancel + re-subscribe (no native pause in Pinch): pinch_cancel_subscription on pause, ` +
            `pinch_create_subscription on resume. The ${pausePolicy.pausesPerYear} pauses/year limit is a business ` +
            `rule the host must enforce.`,
        );
      }
      const needsReview: string[] = [];
      if (platformFeePercent !== undefined) {
        needsReview.push(
          `Platform fee retention (${platformFeePercent}%) requires Pinch Managed Merchants / application fees — ` +
            `flagged for Pinch review; not auto-provisioned. Estimates above show the deduction for planning only.`,
        );
      }
      const unsupported: string[] = [];

      // ---- Human-readable blueprint text ----------------------------------
      const txt: string[] = [];
      txt.push(`BILLING BLUEPRINT${businessName ? ` — ${businessName}` : ""}`);
      txt.push(`Anchor date: ${anchor} · fee estimates are ${FEE_BASIS} — not official pricing`);
      compiled.forEach((cc, i) => {
        const comp = cc.component;
        txt.push("");
        txt.push(`${i + 1}. ${comp.name} [${comp.kind}] → ${comp.mapsTo}`);
        txt.push(`   ${comp.schedule.summary}`);
        const m = comp.money;
        txt.push(
          `   per charge: gross ${m.gross.aud} · est Pinch fee ${m.estPinchFee.aud}` +
            (m.platformFee ? ` · platform fee ${m.platformFee.aud}` : "") +
            ` · est net ${m.estNet.aud}`,
        );
        txt.push(`   provisioning: ${comp.provisioning}${comp.flags.length ? ` · flags: ${comp.flags.join("; ")}` : ""}`);
      });
      if (timeline.length > 0) {
        txt.push("");
        txt.push("TIMELINE (first events)");
        for (const e of timeline) txt.push(`   ${e.date}  ${e.amountAud.padStart(9)}  ${e.componentName} — ${e.description}`);
      }
      txt.push("");
      txt.push(
        `FIRST 30 DAYS: gross ${totals.firstMonthGrossAud} · est net ${totals.estFirstMonthNetAud}` +
          (totals.perInterval.length
            ? ` · recurring: ${totals.perInterval.map((p) => `${p.grossAud}/${p.interval}`).join(", ")}`
            : ""),
      );
      for (const p of policyNotes) txt.push(`POLICY: ${p}`);
      for (const r of needsReview) txt.push(`NEEDS REVIEW: ${r}`);

      const blueprint = {
        businessName: businessName ?? null,
        components: compiled.map((cc) => cc.component),
        timeline,
        totals,
        policyNotes,
        needsReview,
        unsupported,
      };

      if (confirm !== true) {
        return jsonResult({
          blueprint,
          blueprintText: txt.join("\n"),
          note:
            "Blueprint only — nothing was created. Re-call with confirm:true to provision the provisionable-now " +
            "components (event-driven ones always stay manual; see each component's exampleCall).",
        });
      }

      // ---- confirm:true — provision ONLY the provisionable-now subset -----
      const client = getClient();
      const provisioned: AnyRecord[] = [];
      for (let i = 0; i < components.length; i++) {
        const c = components[i] as DesignComponentInput;
        const comp = compiled[i].component;
        if (comp.provisioning !== "provisionable-now") {
          provisioned.push({ name: c.name, action: "skipped", reason: `${comp.provisioning} — see exampleCall/flags` });
          continue;
        }
        try {
          if (c.kind === "split") {
            // Same mechanics as pinch_create_split (shared helpers).
            const parts = c.parties!;
            const usePct = parts.every((p) => p.sharePercent !== undefined);
            const alloc = usePct
              ? allocateByPercent(c.amountCents, parts.map((p) => p.sharePercent!))
              : parts.map((p) => p.amountCents!);
            const splitId = newSplitId();
            const links: AnyRecord[] = [];
            for (let j = 0; j < parts.length; j++) {
              const { payer } = await ensurePayer(client, parts[j].email, parts[j].name);
              const meta: SplitMeta = {
                split: splitId, part: `${j + 1}/${parts.length}`, totalCents: c.amountCents,
                amountCents: alloc[j], description: c.name, email: parts[j].email,
                createdAt: todayPlus(0), dueDate: null,
              };
              const link = await client.post<AnyRecord>("/payment-links", {
                payerId: payer.id, amount: alloc[j], description: `${c.name} — split share`,
                allowedPaymentMethods: ["credit-card", "bank-account"],
                returnUrl: process.env.PINCH_RETURN_URL ?? "https://getpinch.com.au",
                metadata: JSON.stringify(meta),
              });
              links.push({ email: parts[j].email, amountAud: formatAud(alloc[j]), linkUrl: link.url });
            }
            provisioned.push({ name: c.name, action: "created", splitId, links });
          } else if (c.kind === "one_off" || (c.kind === "package" && c.termPayments === undefined)) {
            const { payer } = await ensurePayer(client, c.payerEmail!);
            const link = await client.post<AnyRecord>("/payment-links", {
              payerId: payer.id, amount: c.amountCents, description: c.name,
              allowedPaymentMethods: ["credit-card", "bank-account"],
              returnUrl: process.env.PINCH_RETURN_URL ?? "https://getpinch.com.au",
              ...(metadata !== undefined ? { metadata } : {}),
            });
            provisioned.push({ name: c.name, action: "created", linkId: link.id, linkUrl: link.url });
          } else {
            // membership / term / package-with-instalments → plan + subscription,
            // same source-requirement flow as pinch_create_subscription.
            const isTermLike = c.termPayments !== undefined;
            const dep = c.depositCents;
            const firstRecurring = dep !== undefined ? addIntervals(anchor, c.interval!, 1) : anchor;
            const subStart = dep !== undefined ? anchor : firstRecurring;
            const freq = INTERVAL_MAP[c.interval!];
            const spec: PlanSpec = {
              name: `${c.name} (${c.interval} ${formatAud(c.amountCents)}${isTermLike ? `, ${c.termPayments} payments` : ""}${dep !== undefined ? `, ${formatAud(dep)} deposit` : ""})`.slice(0, 200),
              ...(metadata !== undefined ? { metadata } : {}),
              recurringPayment: {
                amountInCents: c.amountCents, description: c.name,
                ...(dep !== undefined ? { startDateOffset: daysFromTo(subStart, firstRecurring), startDateInterval: "days" as const } : {}),
                frequencyOffset: freq.frequencyOffset, frequencyInterval: freq.frequencyInterval,
                endType: isTermLike ? "number-of-payments" : "never",
                ...(isTermLike ? { endAfterNumberOfPayments: c.termPayments } : {}),
                cancelPlanOnFailure: false,
              },
              ...(dep !== undefined
                ? { fixedPayments: [{ amountInCents: dep, description: `${c.name} — deposit`, scheduledDateOffset: 0, scheduledDateInterval: "days" as const, cancelPlanOnFailure: false }] }
                : {}),
            };
            const { payer } = await ensurePayer(client, c.payerEmail!);
            const { items: plans } = await client.getAllPages<AnyRecord>("/plans");
            const plan = plans.find((p) => planMatchesSpec(p, spec)) ?? (await client.post<AnyRecord>("/plans", spec));
            const detail = await client.get<AnyRecord>(`/payers/${encodeURIComponent(payer.id)}`);
            const sources = Array.isArray(detail.sources) ? detail.sources : [];
            if (sources.length === 0) {
              const firstCharge = dep ?? c.amountCents;
              const link = await client.post<AnyRecord>("/payment-links", {
                payerId: payer.id, amount: firstCharge,
                description: `${c.name} — first payment & payment method setup`,
                allowedPaymentMethods: ["credit-card", "bank-account"],
                returnUrl: process.env.PINCH_RETURN_URL ?? "https://getpinch.com.au",
              });
              provisioned.push({
                name: c.name, action: "pendingSetup", planId: plan.id, setupLinkUrl: link.url,
                reason: "payer has no stored payment source (Pinch requirement) — subscription will be created after setup link is paid; re-run to complete",
              });
            } else {
              const sub = await client.post<AnyRecord>("/subscriptions", { planId: plan.id, payerId: payer.id, startDate: subStart });
              provisioned.push({ name: c.name, action: "created", subscriptionId: sub.id, planId: plan.id, status: sub.status });
            }
          }
        } catch (err) {
          provisioned.push({
            name: c.name, action: "skipped",
            reason: err instanceof PinchApiError ? err.message : String(err),
          });
        }
      }

      return jsonResult({
        blueprint,
        blueprintText: txt.join("\n"),
        provisioned,
        note: "Provisioned the provisionable-now subset only; event-driven components stay manual (see exampleCall).",
      });
    }),
  );

  return names;
}

// Re-exported for consumers that want the raw taxonomy (e.g. agent prompts).
export { DISHONOUR_MAP, diagnoseDishonour, centsToAud };
