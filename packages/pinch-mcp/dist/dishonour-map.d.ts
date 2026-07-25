/**
 * dishonour-map.ts — the diagnosis table for failed Pinch payments.
 *
 * Pinch reports a failed payment as `status: "dishonoured"`, with the reason in
 * the attempt's `dishonour` object (`{ type, reason | description }`). This map
 * turns each machine code into something an AI payments agent (or a human) can
 * act on: a plain-English explanation, who owns the fix, the recommended next
 * step, and whether a straight retry can ever succeed.
 *
 * ownership:
 *   - "customer"        → the payer must act (top up funds, update card, re-authorise…)
 *   - "merchant-config" → the merchant's setup is wrong (bad stored details, unsupported scheme)
 *   - "platform"        → neither side can self-serve; escalate to Pinch support
 *
 * retryable:
 *   - "soft" → a retry of the SAME payment method can succeed (e.g. after payday)
 *   - "hard" → retrying as-is will always fail; something must change first
 *
 * The code set is open-ended per the Pinch docs — always fall back to
 * DEFAULT_DISHONOUR_INFO for unknown codes.
 */
export interface DishonourInfo {
    /** One-sentence explanation safe to show a merchant (and adapt for a customer). */
    plainEnglish: string;
    /** Who has to act to fix it. */
    ownership: "customer" | "merchant-config" | "platform";
    /** The concrete next step an agent should take or propose. */
    recommendedAction: string;
    /** soft = retry can work as-is; hard = something must change before retrying. */
    retryable: "soft" | "hard";
}
export declare const DISHONOUR_MAP: Record<string, DishonourInfo>;
/** Fallback for unknown / future dishonour codes (the set is open-ended). */
export declare const DEFAULT_DISHONOUR_INFO: DishonourInfo;
/**
 * Look up the diagnosis for a dishonour type code. Case-insensitive; unknown or
 * missing codes get the platform-escalation fallback.
 */
export declare function diagnoseDishonour(type: string | undefined | null): DishonourInfo & {
    code: string;
};
