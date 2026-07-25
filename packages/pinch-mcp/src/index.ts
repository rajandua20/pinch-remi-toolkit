#!/usr/bin/env node
/**
 * pinch-mcp — MCP server for the Pinch Payments API (Australia).
 *
 * Transports:
 *   - stdio (default): for Claude Desktop, Cursor, and other local MCP hosts.
 *   - Streamable HTTP (additionally) with `--http <port>`: for platform
 *     integrations (e.g. an MCP connector calling tools/call over HTTP).
 *     Runs STATELESS — a fresh server+transport pair per request, so any
 *     load-balanced client works without session affinity.
 *
 * Flags:
 *   --http <port>          also serve Streamable HTTP on POST /mcp (and /)
 *   --cors                 answer OPTIONS preflights + send CORS headers (off by default)
 *   --cors-origin <o>      CORS allow-origin value (default "*", implies --cors)
 *   --bind <addr>          listen address (default 0.0.0.0; use 127.0.0.1 for local-only)
 *   --allow-live           permit x-pinch-env: live on header credentials (NEVER on a public playground)
 *   --selftest             construct the server, print registered tool names, exit 0
 *
 * Multi-tenant HTTP: requests carrying x-pinch-merchant-id + x-pinch-secret-key
 * (+ optional x-pinch-env, default test) run with those credentials instead of
 * the process env — one hosted endpoint serves many merchants. Secrets from
 * headers are never logged. GET /meta reports {name, version, toolCount, env,
 * corsEnabled} without secrets; GET /healthz is a liveness probe.
 *
 * Environment: see README / .env.example (PINCH_MERCHANT_ID, PINCH_SECRET_KEY,
 * PINCH_ENV, PINCH_CURRENT_MERCHANT, PINCH_TIME_TRAVEL, PINCH_MAX_REFUND_CENTS).
 */

import http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { PinchClient, configFromEnv, type PinchConfig } from "./pinch-client.js";
import { registerPinchTools } from "./tools.js";

const SERVER_INFO = { name: "pinch-mcp", version: "0.1.0" };

/** HTTP-mode options parsed from argv. */
interface HttpOptions {
  cors: boolean;
  corsOrigin: string;
  allowLive: boolean;
  /** Listen address. Default 0.0.0.0 (container platforms need it); use
   *  --bind 127.0.0.1 for a local-only server on a shared/untrusted network. */
  bind: string;
}

/** Refund cap from env (integer cents), default $200.00. */
function maxRefundCentsFromEnv(): number {
  const raw = process.env.PINCH_MAX_REFUND_CENTS;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 20000;
}

/**
 * Build a fully-wired McpServer. The Pinch client is created lazily on first
 * tool call so the server can start (and list tools) without credentials.
 * A new instance is built per HTTP request (stateless mode) and once for stdio.
 * `configOverride` lets HTTP mode inject per-request credentials (multi-tenant
 * hosting: each merchant brings their own keys via headers).
 */
export function buildServer(configOverride?: PinchConfig): {
  server: McpServer;
  toolNames: string[];
  toolsHash: string;
} {
  let client: PinchClient | null = null;
  const getClient = () => (client ??= new PinchClient(configOverride ?? configFromEnv()));

  const server = new McpServer(SERVER_INFO, {
    instructions:
      "Tools for the Pinch Payments API (Australian payments: direct debit, cards, payment links, subscriptions). " +
      "All amounts are integer cents (AUD). Read tools are safe. Write tools (create_payment_link, retry_payment, " +
      "create_refund) require confirm:true — call them WITHOUT confirm first to get a preview, show it to the " +
      "human, and only re-call with confirm:true after explicit approval.",
  });

  const { names: toolNames, toolsHash } = registerPinchTools(server, {
    getClient,
    maxRefundCents: maxRefundCentsFromEnv(),
  });

  return { server, toolNames, toolsHash };
}

// ---------------------------------------------------------------------------
// Streamable HTTP (stateless): fresh server + transport per request
// ---------------------------------------------------------------------------

/** First value of a possibly-repeated header. */
function headerValue(req: http.IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name];
  return Array.isArray(raw) ? raw[0] : raw;
}

/**
 * Per-request credential override: when x-pinch-merchant-id + x-pinch-secret-key
 * are present, that request runs with THOSE credentials instead of the process
 * env — one hosted endpoint can serve many merchants. x-pinch-env defaults to
 * "test"; "live" is refused unless the server was started with --allow-live.
 * The secret header value is never logged.
 */
function credentialsFromHeaders(
  req: http.IncomingMessage,
  allowLive: boolean,
): { config?: PinchConfig; error?: string } {
  const merchantId = headerValue(req, "x-pinch-merchant-id");
  const secretKey = headerValue(req, "x-pinch-secret-key");
  if (!merchantId || !secretKey) return {}; // fall back to env credentials
  const envRaw = (headerValue(req, "x-pinch-env") ?? "test").toLowerCase();
  if (envRaw !== "test" && envRaw !== "live") {
    return { error: `x-pinch-env must be "test" or "live" (got "${envRaw}")` };
  }
  if (envRaw === "live" && !allowLive) {
    return { error: "x-pinch-env: live refused — this server was not started with --allow-live" };
  }
  return { config: { merchantId, secretKey, env: envRaw } };
}

// ---------------------------------------------------------------------------
// HTTP abuse controls (the hosted endpoint is an open relay with caller creds)
// ---------------------------------------------------------------------------

/** Max accepted request body — MCP tool calls are small; 256 KB is generous. */
const MAX_BODY_BYTES = 256 * 1024;

/** Per-IP token bucket: PINCH_MCP_RATE_LIMIT requests/min (default 60). */
const RATE_LIMIT_PER_MIN = (() => {
  const n = Number.parseInt(process.env.PINCH_MCP_RATE_LIMIT ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : 60;
})();
const RATE_BUCKET_CAP = 10_000; // max tracked IPs before idle-eviction

const rateBuckets = new Map<string, { tokens: number; last: number }>();

/** Client key: first X-Forwarded-For hop (Cloud Run appends the real client). */
function rateLimitKey(req: http.IncomingMessage): string {
  const xff = headerValue(req, "x-forwarded-for");
  if (xff) return xff.split(",")[0].trim() || "unknown";
  return req.socket.remoteAddress ?? "unknown";
}

function checkRateLimit(key: string): { ok: boolean; retryAfterSec: number } {
  const now = Date.now();
  if (rateBuckets.size > RATE_BUCKET_CAP) {
    for (const [k, b] of rateBuckets) if (now - b.last > 120_000) rateBuckets.delete(k);
    if (rateBuckets.size > RATE_BUCKET_CAP) rateBuckets.clear(); // last resort
  }
  let bucket = rateBuckets.get(key);
  if (!bucket) {
    bucket = { tokens: RATE_LIMIT_PER_MIN, last: now };
    rateBuckets.set(key, bucket);
  }
  bucket.tokens = Math.min(
    RATE_LIMIT_PER_MIN,
    bucket.tokens + ((now - bucket.last) / 60_000) * RATE_LIMIT_PER_MIN,
  );
  bucket.last = now;
  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return { ok: true, retryAfterSec: 0 };
  }
  return { ok: false, retryAfterSec: Math.max(1, Math.ceil(((1 - bucket.tokens) * 60) / RATE_LIMIT_PER_MIN)) };
}

/**
 * Read + parse the JSON body with a hard byte cap (covers chunked bodies that
 * carry no Content-Length — the stream is destroyed the moment it exceeds the
 * cap). The parsed body is handed to the transport, which accepts pre-parsed
 * bodies, so nothing is read twice.
 */
function readJsonBody(
  req: http.IncomingMessage,
): Promise<{ ok: true; body: unknown } | { ok: false; status: number; message: string }> {
  return new Promise((resolve) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      // Pause (don't hard-destroy) so the 413 response can still be written;
      // the caller closes the connection after responding.
      req.pause();
      resolve({ ok: false, status: 413, message: `Request body exceeds ${MAX_BODY_BYTES} bytes` });
      return;
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const settle = (r: { ok: true; body: unknown } | { ok: false; status: number; message: string }) => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };
    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        req.pause(); // stop consuming; caller responds 413 then closes the socket
        settle({ ok: false, status: 413, message: `Request body exceeds ${MAX_BODY_BYTES} bytes` });
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        settle({ ok: true, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
      } catch {
        settle({ ok: false, status: 400, message: "Body must be valid JSON" });
      }
    });
    req.on("error", () => settle({ ok: false, status: 400, message: "Request stream error" }));
  });
}

function jsonError(res: http.ServerResponse, status: number, message: string, extraHeaders?: Record<string, string>): void {
  res.writeHead(status, { "Content-Type": "application/json", ...extraHeaders });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
}

function applyCorsHeaders(res: http.ServerResponse, opts: HttpOptions): void {
  if (!opts.cors) return;
  res.setHeader("Access-Control-Allow-Origin", opts.corsOrigin);
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "content-type, authorization, mcp-protocol-version, mcp-session-id, last-event-id, " +
      "x-pinch-merchant-id, x-pinch-secret-key, x-pinch-env",
  );
  res.setHeader("Access-Control-Expose-Headers", "mcp-session-id, mcp-protocol-version");
  res.setHeader("Access-Control-Max-Age", "86400");
}

function startHttp(port: number, opts: HttpOptions): void {
  // Tool count + manifest hash for /meta — build a throwaway (credential-free)
  // server once. The hash covers every tool's name/title/description, so a
  // client can pin it and detect any tool-set mutation ("rug pull" defence).
  const { toolNames: metaToolNames, toolsHash } = buildServer();
  const toolCount = metaToolNames.length;

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    applyCorsHeaders(res, opts);

    // CORS preflight (browser playgrounds) — only when --cors is enabled.
    if (req.method === "OPTIONS") {
      res.writeHead(opts.cors ? 204 : 405);
      res.end();
      return;
    }

    // Simple liveness probe for platform health checks (never rate-limited —
    // Cloud Run health checks must not be starved by other traffic).
    if (req.method === "GET" && url.pathname === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, server: SERVER_INFO.name }));
      return;
    }

    // Per-IP rate limit on everything else.
    const limit = checkRateLimit(rateLimitKey(req));
    if (!limit.ok) {
      jsonError(res, 429, "Rate limit exceeded — slow down", {
        "Retry-After": String(limit.retryAfterSec),
      });
      return;
    }

    // Introspection — never includes secrets.
    if (req.method === "GET" && url.pathname === "/meta") {
      const usingHeaders = Boolean(
        headerValue(req, "x-pinch-merchant-id") && headerValue(req, "x-pinch-secret-key"),
      );
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          name: SERVER_INFO.name,
          version: SERVER_INFO.version,
          toolCount,
          toolsHash,
          env: usingHeaders ? "per-request" : "env",
          corsEnabled: opts.cors,
        }),
      );
      return;
    }

    if (url.pathname !== "/mcp" && url.pathname !== "/") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found. MCP endpoint is POST /mcp" }));
      return;
    }

    // MCP endpoint is POST-only (stateless mode has no SSE stream / sessions).
    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json", Allow: "POST, OPTIONS" });
      res.end(JSON.stringify({ error: "Method not allowed. MCP endpoint is POST /mcp" }));
      return;
    }

    // Multi-tenant: header credentials (if present) override env for this
    // request only. Invalid header combos are rejected before any API work.
    const creds = credentialsFromHeaders(req, opts.allowLive);
    if (creds.error) {
      jsonError(res, 403, creds.error);
      return;
    }

    // Body cap BEFORE any processing (also defeats unbounded chunked bodies).
    const body = await readJsonBody(req);
    if (!body.ok) {
      // Close the connection once the error response is flushed — the client
      // may still be mid-upload and we will not consume the rest.
      res.setHeader("Connection", "close");
      res.once("finish", () => req.destroy());
      jsonError(res, body.status, body.message);
      return;
    }

    try {
      // Stateless mode: sessionIdGenerator undefined ⇒ no session tracking.
      // A fresh pair per request avoids cross-request request-id collisions.
      const { server } = buildServer(creds.config);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body.body);
    } catch (err) {
      // Log message only — never full objects (no headers/bodies in logs).
      console.error("[pinch-mcp] HTTP request error:", err instanceof Error ? err.message : String(err));
      if (!res.headersSent) {
        jsonError(res, 500, "Internal server error");
      }
    }
  });

  // Slowloris / stuck-socket posture: cap header wait, whole-request time,
  // and idle keep-alive so open sockets can't be held indefinitely.
  httpServer.headersTimeout = 10_000;
  httpServer.requestTimeout = 30_000;
  httpServer.keepAliveTimeout = 5_000;

  httpServer.listen(port, opts.bind, () => {
    // Logs go to stderr: stdout belongs to the stdio MCP transport.
    console.error(
      `[pinch-mcp] Streamable HTTP listening on http://${opts.bind}:${port}/mcp (stateless` +
        `${opts.cors ? `, CORS: ${opts.corsOrigin}` : ""}${opts.allowLive ? ", LIVE ALLOWED" : ""})`,
    );
    console.error(`[pinch-mcp] tool manifest hash (pin this): ${toolsHash}`);
  });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  // --selftest: prove the server constructs and every tool registers.
  if (argv.includes("--selftest")) {
    const { toolNames } = buildServer();
    console.log(`pinch-mcp selftest OK — ${toolNames.length} registered tools:`);
    for (const name of toolNames) console.log(`  ${name}`);
    process.exit(0);
  }

  const httpFlag = argv.indexOf("--http");
  if (httpFlag !== -1) {
    const port = Number.parseInt(argv[httpFlag + 1] ?? "", 10);
    if (!Number.isFinite(port) || port <= 0 || port > 65535) {
      console.error(
        "Usage: pinch-mcp --http <port> [--cors] [--cors-origin <origin>] [--bind <addr>] [--allow-live]",
      );
      process.exit(1);
    }
    const corsOriginFlag = argv.indexOf("--cors-origin");
    const bindFlag = argv.indexOf("--bind");
    startHttp(port, {
      cors: argv.includes("--cors") || corsOriginFlag !== -1,
      corsOrigin: corsOriginFlag !== -1 ? (argv[corsOriginFlag + 1] ?? "*") : "*",
      allowLive: argv.includes("--allow-live"),
      bind: bindFlag !== -1 ? (argv[bindFlag + 1] ?? "0.0.0.0") : "0.0.0.0",
    });
  }

  // stdio is always on (Claude Desktop & friends). Runs alongside HTTP.
  const { server } = buildServer();
  const stdio = new StdioServerTransport();
  await server.connect(stdio);
  console.error(
    `[pinch-mcp] stdio transport connected (env: ${process.env.PINCH_ENV ?? "test"}${
      process.env.PINCH_MERCHANT_ID ? "" : ", NO CREDENTIALS — tools will error until set"
    })`,
  );
}

main().catch((err) => {
  // Message only — never dump objects that could carry request context.
  console.error("[pinch-mcp] fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
