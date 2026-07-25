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
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PinchClient, centsToAud } from "./pinch-client.js";
import { diagnoseDishonour, DISHONOUR_MAP } from "./dishonour-map.js";
type AnyRecord = Record<string, any>;
/** Budget for per-call payment-detail lookups (keeps request volume bounded). */
interface DetailBudget {
    remaining: number;
    exhausted: boolean;
}
export declare function newDetailBudget(max?: number): DetailBudget;
/**
 * Annotate a dishonoured payment with the diagnosis table entry. Exported so
 * the smoke script (and downstream consumers) reuse identical semantics.
 * Pass a pre-resolved dishonour (from resolveDishonour) to avoid re-extraction.
 */
export declare function annotateDishonouredPayment(payment: AnyRecord, resolved?: {
    type?: string;
    reason?: string;
}): AnyRecord;
/**
 * Stable output shape for pinch_cashflow_summary — rendered directly in UI
 * cards downstream, so: *Cents fields are integers, *Aud fields are "$x.yy"
 * strings, and the key set never varies between calls.
 */
export interface CashflowSummary {
    periodDays: number;
    collected: {
        count: number;
        totalCents: number;
        totalAud: string;
    };
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
    scheduledNext7Days: {
        count: number;
        totalCents: number;
        totalAud: string;
    };
    scheduledNext30Days: {
        count: number;
        totalCents: number;
        totalAud: string;
    };
    topPayers: Array<{
        payerId: string;
        name: string;
        totalAud: string;
        totalCents: number;
    }>;
    generatedAt: string;
}
/** Compute the merchant cashflow summary over processed + scheduled payments. */
export declare function computeCashflowSummary(client: PinchClient, days: number): Promise<CashflowSummary>;
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
/** What registerPinchTools reports back to the caller. */
export interface RegisteredTools {
    /** Registered tool names, in registration order. */
    names: string[];
    /**
     * SHA-256 over the canonical JSON of every tool's {name, title, description}.
     * A tool-manifest integrity hash: any change to the tool set or any tool
     * description changes this value, so clients/operators can pin it and detect
     * "rug pull" tool mutations (OWASP GenAI secure-MCP guide §2; SlowMist
     * tool-integrity checklist). Exposed on GET /meta and logged at startup.
     */
    toolsHash: string;
}
/** Register every pinch tool on the given McpServer. Returns names + manifest hash. */
export declare function registerPinchTools(server: McpServer, options: RegisterOptions): RegisteredTools;
export { DISHONOUR_MAP, diagnoseDishonour, centsToAud };
