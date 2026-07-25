#!/usr/bin/env node
/**
 * Standalone smoke test for the deployed pinch-mcp endpoint.
 * No dependencies — uses Node 18+ global fetch.
 *
 *   PINCH_MCP_URL=https://<url>/mcp \
 *   PINCH_MERCHANT_ID=app_test_... PINCH_SECRET_KEY=sk_test_... \
 *   node demo/test-mcp.mjs
 *
 * Checks: /healthz 200, /meta toolCount === 23 + toolsHash, then (if keys are
 * set) pinch_health, and confirm:false previews of create_subscription and
 * create_payment_qr — so nothing moves money. Exit code 0 = all passed.
 */

const MCP_URL = (process.env.PINCH_MCP_URL || "").trim();
const MERCHANT = process.env.PINCH_MERCHANT_ID || "";
const SECRET = process.env.PINCH_SECRET_KEY || "";
const ENV = (process.env.PINCH_ENV || "test").toLowerCase();
const EXPECT_TOOLS = 23;

if (!MCP_URL) {
  console.error("Set PINCH_MCP_URL to the deployed endpoint (…/mcp).");
  process.exit(2);
}
const BASE = MCP_URL.replace(/\/mcp\/?$/, "");

let pass = 0, fail = 0;
const ok = (m) => { console.log("  ✓", m); pass++; };
const bad = (m) => { console.log("  ✗", m); fail++; };

function headers() {
  const h = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (MERCHANT) h["x-pinch-merchant-id"] = MERCHANT;
  if (SECRET) h["x-pinch-secret-key"] = SECRET;
  h["x-pinch-env"] = ENV === "live" ? "live" : "test";
  return h;
}

function parseBody(text, ct) {
  if (!text) return [];
  if ((ct || "").includes("text/event-stream")) {
    const out = [];
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const p = t.slice(5).trim();
      if (!p || p === "[DONE]") continue;
      try { out.push(JSON.parse(p)); } catch { /* skip */ }
    }
    return out;
  }
  try { const j = JSON.parse(text); return Array.isArray(j) ? j : [j]; } catch { return []; }
}

async function post(url, body) {
  const r = await fetch(url, { method: "POST", headers: headers(), body: JSON.stringify(body) });
  const ct = r.headers.get("content-type") || "";
  const text = await r.text();
  return { status: r.status, msgs: parseBody(text, ct), text };
}

let RPC = 0;
async function callTool(name, args) {
  const initId = ++RPC;
  const init = await post(MCP_URL, {
    jsonrpc: "2.0", id: initId, method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test-mcp", version: "1.0.0" } },
  });
  if (init.msgs.find((m) => m.id === initId)?.error) throw new Error("initialize failed");
  await post(MCP_URL, { jsonrpc: "2.0", method: "notifications/initialized" }).catch(() => {});
  const callId = ++RPC;
  const res = await post(MCP_URL, { jsonrpc: "2.0", id: callId, method: "tools/call", params: { name, arguments: args } });
  const resp = res.msgs.find((m) => m.id === callId);
  if (!resp) throw new Error("no tools/call response (status " + res.status + ")");
  if (resp.error) throw new Error("tool error: " + (resp.error.message || JSON.stringify(resp.error)));
  const content = resp.result?.content || [];
  const textBlock = content.filter((c) => c?.type === "text").map((c) => c.text).join("\n");
  let data = null; try { data = JSON.parse(textBlock); } catch { /* non-JSON */ }
  return { data, isError: !!resp.result?.isError, hasImage: content.some((c) => c?.type === "image") };
}

function summary() {
  console.log("\n" + pass + " passed, " + fail + " failed.");
  process.exit(fail ? 1 : 0);
}

(async () => {
  console.log("pinch-mcp smoke test →", BASE);

  try {
    const r = await fetch(BASE + "/healthz");
    const j = await r.json().catch(() => ({}));
    (r.ok && j.ok) ? ok("/healthz 200 {ok:true}") : bad("/healthz " + r.status + " " + JSON.stringify(j));
  } catch (e) { bad("/healthz unreachable: " + e.message + "  (redeploy — see SETUP §3)"); }

  try {
    const r = await fetch(BASE + "/meta");
    const j = await r.json();
    j.toolCount === EXPECT_TOOLS ? ok("/meta toolCount=" + j.toolCount) : bad("/meta toolCount=" + j.toolCount + " (expected " + EXPECT_TOOLS + " — redeploy)");
    j.toolsHash ? ok("toolsHash present (" + String(j.toolsHash).slice(0, 12) + "…)") : bad("no toolsHash");
  } catch (e) { bad("/meta failed: " + e.message); }

  if (!MERCHANT || !SECRET) {
    console.log("\n(No PINCH_MERCHANT_ID / PINCH_SECRET_KEY set — skipping authenticated tool calls.)");
    return summary();
  }

  try {
    const r = await callTool("pinch_health", {});
    r.isError ? bad("pinch_health error: " + JSON.stringify(r.data)) : ok("pinch_health ok (env " + (r.data?.env ?? "?") + ")");
  } catch (e) { bad("pinch_health: " + e.message); }

  try {
    const r = await callTool("pinch_create_subscription", {
      amountCents: 5900, interval: "weekly", description: "Swim term (test)",
      termPayments: 10, depositCents: 10000,
      payerEmail: "demo.payer+swim@example.com", payerName: "Demo Swim", confirm: false,
    });
    r.data?.preview ? ok("create_subscription preview (no money moved)") : bad("create_subscription: no preview — " + JSON.stringify(r.data));
  } catch (e) { bad("create_subscription: " + e.message); }

  try {
    const r = await callTool("pinch_create_payment_qr", {
      amountCents: 5900, description: "QR test", payerEmail: "demo.payer+qr@example.com", confirm: false,
    });
    r.data?.preview ? ok("create_payment_qr preview") : bad("create_payment_qr: no preview — " + JSON.stringify(r.data));
  } catch (e) { bad("create_payment_qr: " + e.message); }

  summary();
})();
