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
 *   --http <port>   also serve Streamable HTTP on POST /mcp (and /)
 *   --selftest      construct the server, print registered tool names, exit 0
 *
 * Environment: see README / .env.example (PINCH_MERCHANT_ID, PINCH_SECRET_KEY,
 * PINCH_ENV, PINCH_CURRENT_MERCHANT, PINCH_TIME_TRAVEL, PINCH_MAX_REFUND_CENTS).
 */

import http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { PinchClient, configFromEnv } from "./pinch-client.js";
import { registerPinchTools } from "./tools.js";

const SERVER_INFO = { name: "pinch-mcp", version: "0.1.0" };

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
 */
export function buildServer(): { server: McpServer; toolNames: string[] } {
  let client: PinchClient | null = null;
  const getClient = () => (client ??= new PinchClient(configFromEnv()));

  const server = new McpServer(SERVER_INFO, {
    instructions:
      "Tools for the Pinch Payments API (Australian payments: direct debit, cards, payment links, subscriptions). " +
      "All amounts are integer cents (AUD). Read tools are safe. Write tools (create_payment_link, retry_payment, " +
      "create_refund) require confirm:true — call them WITHOUT confirm first to get a preview, show it to the " +
      "human, and only re-call with confirm:true after explicit approval.",
  });

  const toolNames = registerPinchTools(server, {
    getClient,
    maxRefundCents: maxRefundCentsFromEnv(),
  });

  return { server, toolNames };
}

// ---------------------------------------------------------------------------
// Streamable HTTP (stateless): fresh server + transport per request
// ---------------------------------------------------------------------------

function startHttp(port: number): void {
  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    // Simple liveness probe for platform health checks.
    if (req.method === "GET" && url.pathname === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, server: SERVER_INFO.name }));
      return;
    }

    if (url.pathname !== "/mcp" && url.pathname !== "/") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found. MCP endpoint is POST /mcp" }));
      return;
    }

    try {
      // Stateless mode: sessionIdGenerator undefined ⇒ no session tracking.
      // A fresh pair per request avoids cross-request request-id collisions.
      const { server } = buildServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      console.error("[pinch-mcp] HTTP request error:", err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal server error" },
            id: null,
          }),
        );
      }
    }
  });

  httpServer.listen(port, () => {
    // Logs go to stderr: stdout belongs to the stdio MCP transport.
    console.error(`[pinch-mcp] Streamable HTTP listening on http://localhost:${port}/mcp (stateless)`);
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
      console.error("Usage: pinch-mcp --http <port>   (e.g. pinch-mcp --http 8787)");
      process.exit(1);
    }
    startHttp(port);
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
  console.error("[pinch-mcp] fatal:", err);
  process.exit(1);
});
