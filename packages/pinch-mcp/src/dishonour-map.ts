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

export const DISHONOUR_MAP: Record<string, DishonourInfo> = {
  "insufficient-funds": {
    plainEnglish:
      "The customer's account didn't have enough money to cover the payment (a soft decline — the account itself is fine).",
    ownership: "customer",
    recommendedAction:
      "Retry the payment in ~3 days (often after payday) and send the customer a friendly heads-up so the retry doesn't surprise them. Pause after 3 consecutive failures.",
    retryable: "soft",
  },
  "invalid-card": {
    plainEnglish:
      "The stored card details are invalid — the card number no longer works (cancelled, reported lost/stolen, or mis-entered).",
    ownership: "customer",
    recommendedAction:
      "Don't retry the same card — it will always fail. Send the customer a payment link so they can pay and store a new, valid card.",
    retryable: "hard",
  },
  "expired-card": {
    plainEnglish: "The customer's card has passed its expiry date.",
    ownership: "customer",
    recommendedAction:
      "Don't retry the expired card. Send the customer a payment link to update their card details (they may have a reissued card with the same number but a new expiry).",
    retryable: "hard",
  },
  "blocked-by-bank": {
    plainEnglish:
      "The customer's bank actively blocked this payment (fraud rules, gambling/merchant-category blocks, or account restrictions). Only their bank can say why.",
    ownership: "customer",
    recommendedAction:
      "Ask the customer to contact their bank to authorise payments to this merchant, then retry once the bank confirms the block is lifted. Do not blind-retry — repeated blocked attempts can worsen the block.",
    retryable: "hard",
  },
  "payment-stopped": {
    plainEnglish:
      "The customer instructed their bank to stop this payment (a stop order on the debit).",
    ownership: "customer",
    recommendedAction:
      "Do not retry — the customer deliberately stopped it. Contact the customer to understand why (billing dispute? cancellation intent?) and resolve before collecting again.",
    retryable: "hard",
  },
  "payment-stopped-by-customer": {
    plainEnglish:
      "The customer instructed their bank to stop this payment (a stop order on the debit).",
    ownership: "customer",
    recommendedAction:
      "Do not retry — the customer deliberately stopped it. Contact the customer to understand why (billing dispute? cancellation intent?) and resolve before collecting again.",
    retryable: "hard",
  },
  "account-closed": {
    plainEnglish: "The customer's bank account has been closed — it can never be debited again.",
    ownership: "customer",
    recommendedAction:
      "Don't retry this account. Send the customer a payment link to provide a new bank account or card for future collections.",
    retryable: "hard",
  },
  "invalid-account": {
    plainEnglish:
      "The bank account details on file don't match a real account (wrong BSB/account number, or the account can't accept direct debits).",
    ownership: "customer",
    recommendedAction:
      "Don't retry the same details. Send the customer a payment link to re-enter correct bank details (or pay by card instead).",
    retryable: "hard",
  },
  "authority-cancelled": {
    plainEnglish:
      "The customer (or their bank) cancelled the direct-debit authority (mandate) that allowed debits from this account.",
    ownership: "customer",
    recommendedAction:
      "Don't retry — there is no longer permission to debit. Send the customer a payment link to re-authorise the direct debit (or switch to card).",
    retryable: "hard",
  },
  "refer-to-customer": {
    plainEnglish:
      "The customer's bank declined the payment and says only the account holder can find out why (a catch-all bank-side refusal, often funds- or restriction-related).",
    ownership: "customer",
    recommendedAction:
      "Ask the customer to contact their bank about the declined payment, then retry once they confirm it's resolved.",
    retryable: "hard",
  },
  "temporary-problem": {
    plainEnglish:
      "A temporary problem at the bank or network stopped the payment — nothing is wrong with the customer's details.",
    ownership: "platform",
    recommendedAction: "Retry after at least an hour (or the next business day). If it keeps failing, escalate to Pinch support.",
    retryable: "soft",
  },
  "unsupported-card": {
    plainEnglish:
      "The card type isn't supported for this merchant (Visa and Mastercard are always safe; others depend on merchant setup).",
    ownership: "merchant-config",
    recommendedAction:
      "Don't retry the same card. Either enable this card scheme on the merchant account, or send the customer a payment link asking for a Visa/Mastercard or bank account.",
    retryable: "hard",
  },
  "technical-error": {
    plainEnglish: "A technical error occurred during processing on the payments-network side.",
    ownership: "platform",
    recommendedAction: "Retry once; if it fails again, escalate to Pinch support (integrations@getpinch.com.au).",
    retryable: "soft",
  },
  deceased: {
    plainEnglish: "The bank reports the account holder is deceased.",
    ownership: "customer",
    recommendedAction:
      "Do not retry and do not send automated payment reminders. Flag the account for sensitive manual handling (estate/next-of-kin process).",
    retryable: "hard",
  },
};

/** Fallback for unknown / future dishonour codes (the set is open-ended). */
export const DEFAULT_DISHONOUR_INFO: DishonourInfo = {
  plainEnglish: "The payment was dishonoured for a reason we don't have a specific playbook for.",
  ownership: "platform",
  recommendedAction:
    "Escalate to Pinch support (integrations@getpinch.com.au) with the payment ID and dishonour code before retrying.",
  retryable: "hard",
};

/**
 * Look up the diagnosis for a dishonour type code. Case-insensitive; unknown or
 * missing codes get the platform-escalation fallback.
 */
export function diagnoseDishonour(type: string | undefined | null): DishonourInfo & { code: string } {
  const code = (type ?? "unknown").toLowerCase();
  const info = DISHONOUR_MAP[code] ?? DEFAULT_DISHONOUR_INFO;
  return { code, ...info };
}
