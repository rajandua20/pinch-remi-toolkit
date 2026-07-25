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
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type PinchConfig } from "./pinch-client.js";
/**
 * Build a fully-wired McpServer. The Pinch client is created lazily on first
 * tool call so the server can start (and list tools) without credentials.
 * A new instance is built per HTTP request (stateless mode) and once for stdio.
 * `configOverride` lets HTTP mode inject per-request credentials (multi-tenant
 * hosting: each merchant brings their own keys via headers).
 */
export declare function buildServer(configOverride?: PinchConfig): {
    server: McpServer;
    toolNames: string[];
    toolsHash: string;
};
