/**
 * pinch-client.ts — minimal, dependency-free REST client for the Pinch Payments API.
 *
 * Verified API facts (docs.getpinch.com.au, July 2026):
 *  - Auth: OAuth2 client-credentials. POST https://auth.getpinch.com.au/connect/token
 *    with HTTP Basic (MerchantId:SecretKey) and a FORM-ENCODED body
 *    `grant_type=client_credentials&scope=api1`. JSON bodies are rejected.
 *    Tokens last 3600s; we refresh proactively at 55 minutes.
 *  - Base URL: https://api.getpinch.com.au/{test|live}/ — the path segment selects
 *    the environment; the same credentials work in both.
 *  - Every call needs `Authorization: Bearer <token>` AND `pinch-version: 2020.1`.
 *  - Managed merchants: add `Current-Merchant: mch_...` to act on behalf of a sub-merchant.
 *  - Sandbox `Time-Travel: <ISO>` header fast-forwards overnight direct-debit processing
 *    (test env only; ignored in live — we never send it in live regardless).
 *  - Money is integer cents, AUD. Pagination: {page,pageSize,totalPages,totalItems,data[]}.
 *  - Rate limits are undocumented → retry 429/5xx twice with jittered backoff.
 *  - Response casing is inconsistent across docs (camelCase API bodies vs PascalCase
 *    event payloads) → normalizeKeys() deep-converts everything to camelCase.
 */
export interface PinchConfig {
    merchantId: string;
    secretKey: string;
    /** "test" (default) or "live" — selects the base-URL path segment. */
    env: "test" | "live";
    /** Optional mch_... header value for managed-merchant (on-behalf-of) calls. */
    currentMerchant?: string;
    /** Optional ISO timestamp for the sandbox Time-Travel header (test env only). */
    timeTravel?: string;
}
/** Build config from environment variables. Throws if credentials are missing. */
export declare function configFromEnv(env?: NodeJS.ProcessEnv): PinchConfig;
/** True when both credential env vars are present (used by smoke test / health). */
export declare function hasCredentials(env?: NodeJS.ProcessEnv): boolean;
/** 1234 → 12.34 (dollars as a number). */
export declare function centsToAud(cents: number): number;
/** 12.34 → 1234 (integer cents, safely rounded). */
export declare function audToCents(aud: number): number;
/** 1234 → "$12.34" for human-readable summaries. */
export declare function formatAud(cents: number): string;
/**
 * Deep-convert every object key from PascalCase to camelCase ("EventDate" →
 * "eventDate"). Keys already in camelCase pass through untouched, so mixed
 * payloads (a documented Pinch quirk) normalise to one predictable shape.
 */
export declare function normalizeKeys<T = unknown>(value: unknown): T;
export declare class PinchApiError extends Error {
    readonly status: number;
    readonly body: unknown;
    readonly path: string;
    constructor(message: string, status: number, body: unknown, path: string);
}
export interface PagedResponse<T = Record<string, unknown>> {
    page: number;
    pageSize: number;
    totalPages: number;
    totalItems: number;
    data: T[];
}
export interface RequestOptions {
    /** Query-string parameters; undefined values are skipped. */
    query?: Record<string, string | number | boolean | undefined>;
    /** JSON body for POST/PUT. */
    body?: unknown;
}
export declare class PinchClient {
    private readonly config;
    constructor(config: PinchConfig);
    private get cacheKey();
    get env(): "test" | "live";
    /**
     * Non-reversible tenant tag for audit logs: "<env>:<sha256(merchantId)[:12]>".
     * Lets operators correlate a tenant's calls across log lines without ever
     * writing the merchantId (or anything derived from the secret) to logs.
     */
    get auditTag(): string;
    get baseUrl(): string;
    private getToken;
    /** Drop the cached token (used after a 403 to force one re-auth). */
    private invalidateToken;
    /**
     * Perform an API request. Retries 429/5xx (and network errors) up to twice
     * with jittered exponential backoff; retries a 403 once after re-auth
     * (Pinch signals expired tokens with 403). All responses are deep-normalised
     * to camelCase.
     */
    request<T = unknown>(method: "GET" | "POST" | "DELETE", path: string, options?: RequestOptions): Promise<T>;
    get<T = unknown>(path: string, query?: RequestOptions["query"]): Promise<T>;
    post<T = unknown>(path: string, body: unknown): Promise<T>;
    /**
     * Follow a Pinch paged list ({page,pageSize,totalPages,totalItems,data[]}),
     * concatenating `data` across pages. Capped at MAX_PAGES (5) to keep MCP
     * tool responses (and sandbox request volume) bounded.
     */
    getAllPages<T = Record<string, unknown>>(path: string, query?: RequestOptions["query"], pageSize?: number): Promise<{
        items: T[];
        totalItems: number;
        truncated: boolean;
    }>;
    /** Cheap credential/connectivity check: fetch a token then GET /payers?pageSize=1. */
    health(): Promise<{
        ok: boolean;
        env: string;
        baseUrl: string;
        totalPayers?: number;
    }>;
}
