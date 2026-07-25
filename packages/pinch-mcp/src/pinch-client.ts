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

import { createHash } from "node:crypto";

const AUTH_URL = "https://auth.getpinch.com.au/connect/token";
const API_ROOT = "https://api.getpinch.com.au";
const PINCH_VERSION = "2020.1";

/** Refresh the cached token after 55 minutes (tokens last 60). */
const TOKEN_REFRESH_MS = 55 * 60 * 1000;

/** Max pages the pagination helper will follow — keeps tool responses bounded. */
const MAX_PAGES = 5;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

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
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): PinchConfig {
  const merchantId = env.PINCH_MERCHANT_ID;
  const secretKey = env.PINCH_SECRET_KEY;
  if (!merchantId || !secretKey) {
    throw new Error(
      "Missing Pinch credentials: set PINCH_MERCHANT_ID and PINCH_SECRET_KEY " +
        "(from https://web.getpinch.com.au/api-keys).",
    );
  }
  const rawEnv = (env.PINCH_ENV ?? "test").toLowerCase();
  if (rawEnv !== "test" && rawEnv !== "live") {
    throw new Error(`PINCH_ENV must be "test" or "live", got "${rawEnv}".`);
  }
  return {
    merchantId,
    secretKey,
    env: rawEnv,
    currentMerchant: env.PINCH_CURRENT_MERCHANT || undefined,
    timeTravel: env.PINCH_TIME_TRAVEL || undefined,
  };
}

/** True when both credential env vars are present (used by smoke test / health). */
export function hasCredentials(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.PINCH_MERCHANT_ID && env.PINCH_SECRET_KEY);
}

// ---------------------------------------------------------------------------
// Money helpers — Pinch amounts are ALWAYS integer cents (AUD)
// ---------------------------------------------------------------------------

/** 1234 → 12.34 (dollars as a number). */
export function centsToAud(cents: number): number {
  return Math.round(cents) / 100;
}

/** 12.34 → 1234 (integer cents, safely rounded). */
export function audToCents(aud: number): number {
  return Math.round(aud * 100);
}

/** 1234 → "$12.34" for human-readable summaries. */
export function formatAud(cents: number): string {
  return `$${centsToAud(cents).toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// Key normalisation — tolerate camelCase AND PascalCase responses
// ---------------------------------------------------------------------------

/**
 * Deep-convert every object key from PascalCase to camelCase ("EventDate" →
 * "eventDate"). Keys already in camelCase pass through untouched, so mixed
 * payloads (a documented Pinch quirk) normalise to one predictable shape.
 */
export function normalizeKeys<T = unknown>(value: unknown): T {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeKeys(item)) as T;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      const camel = key.length > 0 ? key[0].toLowerCase() + key.slice(1) : key;
      out[camel] = normalizeKeys(val);
    }
    return out as T;
  }
  return value as T;
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export class PinchApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
    public readonly path: string,
  ) {
    super(message);
    this.name = "PinchApiError";
  }
}

// ---------------------------------------------------------------------------
// Paged envelope
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/**
 * Process-wide OAuth token cache. SECURITY: the key is a SHA-256 digest of
 * merchantId + secretKey + env — including the secret in the key means a
 * caller who knows only a victim's merchantId can NEVER get a cache hit on
 * the victim's token (multi-tenant HTTP mode accepts caller-supplied creds).
 * Hashing also keeps raw secrets out of map keys (heap-dump hygiene).
 */
const tokenCache = new Map<string, { token: string; fetchedAt: number }>();

export class PinchClient {
  constructor(private readonly config: PinchConfig) {}

  private get cacheKey(): string {
    return createHash("sha256")
      .update(`${this.config.merchantId}\u0000${this.config.secretKey}\u0000${this.config.env}`)
      .digest("hex");
  }

  get env(): "test" | "live" {
    return this.config.env;
  }

  /** Acting-as sub-merchant (managed merchants), when set. */
  get currentMerchant(): string | undefined {
    return this.config.currentMerchant;
  }

  /**
   * Non-reversible tenant tag for audit logs: "<env>:<sha256(merchantId)[:12]>"
   * plus ":<sha256(currentMerchant)[:8]>" when acting on behalf of a
   * sub-merchant. Lets operators correlate a tenant's (and sub-merchant's)
   * calls across log lines without writing identifiers or secrets to logs.
   */
  get auditTag(): string {
    const digest = createHash("sha256").update(this.config.merchantId).digest("hex");
    const base = `${this.config.env}:${digest.slice(0, 12)}`;
    if (!this.config.currentMerchant) return base;
    const sub = createHash("sha256").update(this.config.currentMerchant).digest("hex");
    return `${base}:${sub.slice(0, 8)}`;
  }

  get baseUrl(): string {
    return `${API_ROOT}/${this.config.env}`;
  }

  // -- OAuth2 client-credentials token, cached & refreshed at 55 min --------

  private async getToken(): Promise<string> {
    const cached = tokenCache.get(this.cacheKey);
    if (cached && Date.now() - cached.fetchedAt < TOKEN_REFRESH_MS) return cached.token;

    const basic = Buffer.from(
      `${this.config.merchantId}:${this.config.secretKey}`,
    ).toString("base64");

    // MUST be form-encoded — the Pinch docs explicitly warn JSON bodies fail here.
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      scope: "api1",
    });

    const res = await fetch(AUTH_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new PinchApiError(
        `Pinch token request failed (HTTP ${res.status}). Check PINCH_MERCHANT_ID / PINCH_SECRET_KEY. ${text}`,
        res.status,
        text,
        "/connect/token",
      );
    }

    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) {
      throw new PinchApiError(
        "Pinch token response missing access_token.",
        res.status,
        json,
        "/connect/token",
      );
    }
    tokenCache.set(this.cacheKey, { token: json.access_token, fetchedAt: Date.now() });
    return json.access_token;
  }

  /** Drop the cached token (used after a 403 to force one re-auth). */
  private invalidateToken(): void {
    tokenCache.delete(this.cacheKey);
  }

  // -- Core request with retry ---------------------------------------------

  /**
   * Perform an API request. Retries 429/5xx (and network errors) up to twice
   * with jittered exponential backoff; retries a 403 once after re-auth
   * (Pinch signals expired tokens with 403). All responses are deep-normalised
   * to camelCase.
   */
  async request<T = unknown>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    options: RequestOptions = {},
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`);
    for (const [key, val] of Object.entries(options.query ?? {})) {
      if (val !== undefined) url.searchParams.set(key, String(val));
    }

    const maxRetries = 2;
    let attempt = 0;
    let reauthed = false;

    // Retry loop: attempt 0 + up to `maxRetries` retries for 429/5xx/network.
    for (;;) {
      let res: Response;
      try {
        const token = await this.getToken();
        const headers: Record<string, string> = {
          Authorization: `Bearer ${token}`,
          "pinch-version": PINCH_VERSION,
          Accept: "application/json",
        };
        if (options.body !== undefined) headers["Content-Type"] = "application/json";
        if (this.config.currentMerchant) headers["Current-Merchant"] = this.config.currentMerchant;
        // Time-Travel only exists in the sandbox; never send it against live.
        if (this.config.timeTravel && this.config.env === "test") {
          headers["Time-Travel"] = this.config.timeTravel;
        }

        res = await fetch(url, {
          method,
          headers,
          body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        });
      } catch (err) {
        // Network-level failure — retry with backoff.
        if (attempt < maxRetries) {
          await backoff(attempt++);
          continue;
        }
        throw err;
      }

      // 403 = auth failure per Pinch docs; the cached token may have expired
      // server-side. Re-auth once, then treat a second 403 as a real error.
      if (res.status === 403 && !reauthed) {
        // NOTE: a nonce replay on POST /payments also returns 403 *with the
        // existing payment object as the body* — surface that instead of retrying.
        const text = await res.text().catch(() => "");
        const parsed = tryParseJson(text);
        if (isObject(parsed) && ("id" in parsed || "Id" in parsed)) {
          return normalizeKeys<T>(parsed);
        }
        reauthed = true;
        this.invalidateToken();
        continue;
      }

      if ((res.status === 429 || res.status >= 500) && attempt < maxRetries) {
        await backoff(attempt++);
        continue;
      }

      const text = await res.text().catch(() => "");
      const parsed = tryParseJson(text);

      if (!res.ok) {
        throw new PinchApiError(
          `Pinch API ${method} ${path} failed (HTTP ${res.status}): ${summariseError(parsed ?? text)}`,
          res.status,
          parsed ?? text,
          path,
        );
      }

      return normalizeKeys<T>(parsed ?? {});
    }
  }

  get<T = unknown>(path: string, query?: RequestOptions["query"]): Promise<T> {
    return this.request<T>("GET", path, { query });
  }

  post<T = unknown>(path: string, body: unknown): Promise<T> {
    return this.request<T>("POST", path, { body });
  }

  // -- Pagination helper ----------------------------------------------------

  /**
   * Follow a Pinch paged list ({page,pageSize,totalPages,totalItems,data[]}),
   * concatenating `data` across pages. Capped at MAX_PAGES (5) to keep MCP
   * tool responses (and sandbox request volume) bounded.
   */
  async getAllPages<T = Record<string, unknown>>(
    path: string,
    query: RequestOptions["query"] = {},
    pageSize = 50,
  ): Promise<{ items: T[]; totalItems: number; truncated: boolean }> {
    const items: T[] = [];
    let totalItems = 0;
    let totalPages = 1;

    for (let page = 1; page <= Math.min(totalPages, MAX_PAGES); page++) {
      const res = await this.get<PagedResponse<T>>(path, { ...query, page, pageSize });
      // Tolerate non-paged responses (defensive: some endpoints may return arrays).
      if (Array.isArray(res)) {
        return { items: res as T[], totalItems: (res as T[]).length, truncated: false };
      }
      items.push(...(res.data ?? []));
      totalItems = res.totalItems ?? items.length;
      totalPages = res.totalPages ?? 1;
    }

    return { items, totalItems, truncated: totalPages > MAX_PAGES };
  }

  // -- Convenience ----------------------------------------------------------

  /** Cheap credential/connectivity check: fetch a token then GET /payers?pageSize=1. */
  async health(): Promise<{ ok: boolean; env: string; baseUrl: string; totalPayers?: number }> {
    const res = await this.get<PagedResponse>("/payers", { page: 1, pageSize: 1 });
    return {
      ok: true,
      env: this.config.env,
      baseUrl: this.baseUrl,
      totalPayers: Array.isArray(res) ? undefined : res.totalItems,
    };
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Jittered exponential backoff: ~0.5s, ~1s (+ up to 250ms jitter). */
function backoff(attempt: number): Promise<void> {
  const ms = 500 * 2 ** attempt + Math.random() * 250;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tryParseJson(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Pinch error bodies come in two documented shapes:
 *   {"errors":[{"message":"...","field":"amount"}]}
 *   [{"propertyName":"PayerId","errorMessage":"Can't find payer..."}]
 * Squash either into a single readable line.
 */
function summariseError(body: unknown): string {
  if (typeof body === "string") return body.slice(0, 500);
  if (Array.isArray(body)) {
    return body
      .map((e) =>
        isObject(e)
          ? `${e.propertyName ?? e.PropertyName ?? ""}: ${e.errorMessage ?? e.ErrorMessage ?? JSON.stringify(e)}`
          : String(e),
      )
      .join("; ")
      .slice(0, 500);
  }
  if (isObject(body)) {
    const errors = body.errors ?? body.Errors;
    if (Array.isArray(errors)) {
      return errors
        .map((e) => (isObject(e) ? `${e.field ?? ""} ${e.message ?? JSON.stringify(e)}`.trim() : String(e)))
        .join("; ")
        .slice(0, 500);
    }
    return JSON.stringify(body).slice(0, 500);
  }
  return "(no error body)";
}
