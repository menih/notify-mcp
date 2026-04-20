// End-to-end smoke tests for notify-mcp.
//
// These tests spawn a real UI server on a random port, drive it via HTTP,
// and exercise the stdio bridge as a subprocess. No mocks — everything is
// wire-level, so a regression in the transport or bridge surfaces here.
//
// The server is launched with NOTIFY_MCP_TEST_ENDPOINTS=1 so we can inject
// fake inbox messages without depending on a real Telegram bot.
//
// Run: npm test  (or: node --test tests/smoke.test.mjs)

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { once } from "node:events";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const UI_SERVER = join(ROOT, "dist", "ui", "server.js");
const STDIO_BRIDGE = join(ROOT, "dist", "index.js");

// Allocate a random free port each run so tests can run in parallel with a
// user's normal `:3737` server — and so two test runs don't collide.
async function pickPort() {
  const { createServer } = await import("node:net");
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}

async function waitForHttp(port, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://localhost:${port}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} }),
        signal: AbortSignal.timeout(1000),
      });
      if (r.status > 0) return true;
    } catch { /* keep retrying */ }
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}

function startServer(port) {
  const child = spawn(process.execPath, [UI_SERVER], {
    env: {
      ...process.env,
      PORT: String(port),
      NOTIFY_MCP_TEST_ENDPOINTS: "1",
      // Suppress noise from the auto-open browser call in tests.
      BROWSER: "none",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Drain output so the OS pipe doesn't fill up and block the child.
  child.stdout.on("data", () => {});
  child.stderr.on("data", () => {});
  return child;
}

// Minimal MCP-over-HTTP client. Returns parsed JSON-RPC response (or undefined
// for notifications).
function createHttpClient(port) {
  let sid;
  let nextId = 1;
  return {
    async rpc(method, params, { notify = false } = {}) {
      const isNotif = notify || method.startsWith("notifications/");
      const body = { jsonrpc: "2.0", method, params: params ?? {} };
      if (!isNotif) body.id = nextId++;
      const headers = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
      };
      if (sid) headers["mcp-session-id"] = sid;
      const r = await fetch(`http://localhost:${port}/mcp`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(65_000),
      });
      const newSid = r.headers.get("mcp-session-id");
      if (newSid && !sid) sid = newSid;
      if (isNotif) return undefined;
      const ctype = r.headers.get("content-type") ?? "";
      const raw = await r.text();
      if (ctype.includes("application/json")) return { status: r.status, body: JSON.parse(raw) };
      for (const line of raw.split(/\r?\n/)) {
        if (line.startsWith("data:")) {
          const json = line.slice(5).trim();
          if (json) return { status: r.status, body: JSON.parse(json) };
        }
      }
      return { status: r.status, body: raw };
    },
    get sessionId() { return sid; },
    reset() { sid = undefined; },
  };
}

// Shared server instance across all tests in this file — startup is slow
// enough (~1-2s) that restarting per test would be wasteful, and the tests
// don't share state via the server (each uses its own tag).
let server;
let port;

test.before(async () => {
  port = await pickPort();
  server = startServer(port);
  const up = await waitForHttp(port);
  assert.ok(up, `server did not come up on :${port} within 10s`);
});

test.after(async () => {
  if (server && !server.killed) {
    server.kill("SIGKILL");
    await once(server, "exit").catch(() => {});
  }
});

test("initialize returns protocol + tool capabilities", async () => {
  const c = createHttpClient(port);
  const r = await c.rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test", version: "1.0" },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.result.protocolVersion, "2024-11-05");
  assert.ok(r.body.result.capabilities.tools, "tools capability missing");
  assert.ok(c.sessionId, "mcp-session-id header missing");
});

test("tools/list includes wait_for_inbox + the full core set", async () => {
  const c = createHttpClient(port);
  await c.rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } });
  await c.rpc("notifications/initialized");
  const r = await c.rpc("tools/list");
  const names = r.body.result.tools.map(t => t.name).sort();
  const expected = ["ask", "get_dnd_status", "get_idle_config", "get_idle_seconds", "notify", "poll", "wait_for_inbox"];
  assert.deepEqual(names, expected);
});

test("wait_for_inbox returns inbox:empty after its timeout when no message arrives", async () => {
  const c = createHttpClient(port);
  await c.rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } });
  await c.rpc("notifications/initialized");
  const started = Date.now();
  const r = await c.rpc("tools/call", { name: "wait_for_inbox", arguments: { timeout_seconds: 5 } });
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 4500, `returned too early: ${elapsed}ms`);
  assert.ok(elapsed < 10_000, `returned too late: ${elapsed}ms`);
  assert.equal(r.body.result.content[0].text, "inbox:empty");
});

test("wait_for_inbox wakes up immediately when a matching message is injected", async () => {
  const c = createHttpClient(port);
  await c.rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } });
  await c.rpc("notifications/initialized");

  // Park a long waiter and, after a beat, inject a message. The waiter should
  // resolve in well under a second — not wait out the full 30s timeout.
  const started = Date.now();
  const waitPromise = c.rpc("tools/call", { name: "wait_for_inbox", arguments: { timeout_seconds: 30 } });
  await new Promise(r => setTimeout(r, 500));

  const inject = await fetch(`http://localhost:${port}/__test__/inject-inbox`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "hello from test" }),
  });
  const injectBody = await inject.json();
  assert.equal(injectBody.injected, true);
  assert.equal(injectBody.waiters, 1, "expected exactly one matching waiter");

  const r = await waitPromise;
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 3000, `wake-up too slow: ${elapsed}ms`);
  const text = r.body.result.content[0].text;
  assert.match(text, /USER SENT YOU A MESSAGE/);
  assert.match(text, /hello from test/);
});

test("stale session id on non-initialize request returns 404", async () => {
  const r = await fetch(`http://localhost:${port}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      "mcp-session-id": "00000000-0000-0000-0000-000000000000",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal(r.status, 404);
});

test("stale session id on initialize is adopted (auto-reconnect after restart)", async () => {
  // Simulates the claude-code#27142 flow: the server forgot the session, but
  // the client still has the old id cached. An initialize with that id must
  // succeed and the server must echo the same id back instead of 404-ing.
  const staleId = "deadbeef-dead-beef-dead-beefdeadbeef";
  const r = await fetch(`http://localhost:${port}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      "mcp-session-id": staleId,
    },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "reconnect-test", version: "1" } },
    }),
  });
  assert.equal(r.status, 200, `expected 200 on reinitialize, got ${r.status}`);
  assert.equal(r.headers.get("mcp-session-id"), staleId, "server should echo the stale id back");

  // Follow-up call on that same id should now work — session is live again.
  const followup = await fetch(`http://localhost:${port}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      "mcp-session-id": staleId,
    },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  // notifications return 202 Accepted in the SDK; anything < 300 proves the session is alive.
  assert.ok(followup.status < 300, `followup after adoption failed: ${followup.status}`);
});

test("stdio bridge initializes, advertises claude/channel, lists tools", { timeout: 20_000 }, async () => {
  const child = spawn(process.execPath, [STDIO_BRIDGE], {
    env: { ...process.env, NOTIFY_MCP_PORT: String(port) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  // Drain stderr quietly.
  child.stderr.on("data", () => {});
  let buf = "";
  const lines = [];
  const readerDone = new Promise((resolve) => {
    child.stdout.on("data", (chunk) => {
      buf += chunk.toString();
      let i;
      while ((i = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) lines.push(line);
        if (lines.length >= 2) resolve();
      }
    });
  });

  const send = (obj) => child.stdin.write(JSON.stringify(obj) + "\n");
  // Bridge needs a beat to open its HTTP session to the server before it can
  // respond to stdio calls — tool calls proxy through HTTP. Stall briefly.
  await new Promise(r => setTimeout(r, 800));
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list" });

  await Promise.race([
    readerDone,
    new Promise((_, reject) => setTimeout(() => reject(new Error("bridge did not respond in 15s")), 15_000)),
  ]);

  child.kill("SIGKILL");
  await once(child, "exit").catch(() => {});

  const initResp = lines.map(l => JSON.parse(l)).find(m => m.id === 1);
  assert.ok(initResp, "no initialize response");
  assert.equal(initResp.result.protocolVersion, "2024-11-05");
  assert.ok(
    initResp.result.capabilities?.experimental?.["claude/channel"],
    "claude/channel capability not declared by stdio bridge"
  );

  const toolsResp = lines.map(l => JSON.parse(l)).find(m => m.id === 2);
  assert.ok(toolsResp, "no tools/list response");
  const names = toolsResp.result.tools.map(t => t.name).sort();
  // reply is the stdio-only channels return tool; others match the HTTP set.
  assert.deepEqual(names, ["ask", "get_dnd_status", "get_idle_config", "get_idle_seconds", "notify", "poll", "reply", "wait_for_inbox"]);
});
