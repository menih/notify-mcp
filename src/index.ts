#!/usr/bin/env node
/**
 * Stdio bridge for notify-mcp.
 *
 * This is the Claude Code / Cursor / Codex stdio entrypoint. It is a *thin*
 * foreground process — all state (config, inbox, pending asks, Telegram
 * listener) lives in the long-running HTTP server (`ui/server.js`, default
 * port 3737). The bridge:
 *
 *   1. Ensures the HTTP server is running (auto-spawns it detached if not).
 *   2. Subscribes to /api/inbox/stream via SSE and re-emits each unsolicited
 *      user message as a `notifications/claude/channel` notification to the
 *      attached client. Claude Code (v2.1.80+) surfaces those as synthetic
 *      user turns, which is the only push path that reliably crosses the
 *      client boundary — regular MCP notifications are dropped by most
 *      clients (modelcontextprotocol/modelcontextprotocol#1192).
 *   3. Exposes the full tool surface (`notify`, `ask`, `poll`, `wait_for_inbox`,
 *      `get_idle_seconds`, `get_idle_config`, `get_dnd_status`, `reply`) and
 *      proxies every call to the HTTP /mcp endpoint so multi-session routing,
 *      DND, idle gating, etc. all work identically to the HTTP transport.
 *
 * The net effect: users can `claude --channels notify-mcp@<registry>` (or
 * run `npx omni-notify-mcp` as a plain stdio MCP server) and get push-to-agent
 * delivery without ever touching a .mcp.json or a port number.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { spawn } from "child_process";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { z } from "zod";

const PORT = process.env.NOTIFY_MCP_PORT ? parseInt(process.env.NOTIFY_MCP_PORT) : 3737;
const BASE = `http://localhost:${PORT}`;
const SESSION_TAG = (process.env.NOTIFY_MCP_TAG ?? "").toLowerCase().replace(/[^a-z0-9_-]/g, "") || undefined;
const CLIENT_NAME = "claude-channel-bridge";

// ── 1. Ensure the HTTP server is up ───────────────────────────────────────────

async function serverIsUp(): Promise<boolean> {
  try {
    const r = await fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} }),
      signal: AbortSignal.timeout(1500),
    });
    // Any HTTP response (including 400/406 from malformed init) means the
    // server is alive and speaking HTTP. Real "down" surfaces as a throw.
    return r.status > 0;
  } catch {
    return false;
  }
}

function spawnUiServerIfNeeded(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/ layout: src/index.ts → dist/index.js; ui → dist/ui/server.js
  const candidates = [
    join(here, "ui", "server.js"),
    join(here, "..", "ui", "server.js"),
    join(here, "..", "dist", "ui", "server.js"),
  ];
  const uiPath = candidates.find(p => existsSync(p));
  if (!uiPath) {
    stderr(`[bridge] could not locate ui/server.js near ${here} — skipping auto-spawn`);
    return;
  }
  stderr(`[bridge] auto-spawning UI server: ${uiPath}`);
  const child = spawn(process.execPath, [uiPath], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, PORT: String(PORT) },
  });
  child.unref();
}

async function waitForServer(maxMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (await serverIsUp()) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

function stderr(line: string) {
  // stdio transport uses stdout for JSON-RPC — all logging MUST go to stderr.
  try { process.stderr.write(`${line}\n`); } catch { /* ignore */ }
}

// ── 2. HTTP /mcp session — the bridge itself is an MCP client of the server ──
// We run a single persistent MCP-over-HTTP session per bridge process and
// forward every local stdio tool call through it. Using one shared session
// (not per-tool-call) keeps the tag-based routing, waiter parking, and inbox
// draining all consistent with what the HTTP server sees.

let httpSessionId: string | undefined;
let httpRpcId = 1;

async function httpRpc(method: string, params?: unknown, isNotification = false): Promise<any> {
  // JSON-RPC notifications (method name starts with `notifications/` or the
  // caller says so) carry no `id` and get no response. Spec-compliant servers
  // return 202 Accepted with empty body.
  const notif = isNotification || method.startsWith("notifications/");
  const body: Record<string, unknown> = { jsonrpc: "2.0", method, params: params ?? {} };
  if (!notif) body.id = httpRpcId++;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
  };
  if (httpSessionId) headers["mcp-session-id"] = httpSessionId;
  const tagQuery = SESSION_TAG ? `?tag=${encodeURIComponent(SESSION_TAG)}` : "";
  const r = await fetch(`${BASE}/mcp${tagQuery}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    // Long-poll tools may block up to ~55s server-side. Give the fetch
    // generous headroom but not infinite, so a wedged server surfaces fast.
    signal: AbortSignal.timeout(120_000),
  });
  // The server returns 404 when our cached session is stale (spec-compliant
  // behavior after a server restart). Clear and retry once with a fresh init.
  if (r.status === 404 && httpSessionId) {
    httpSessionId = undefined;
    await httpInitialize();
    return httpRpc(method, params, isNotification);
  }
  if (r.status >= 500) {
    throw new Error(`HTTP ${r.status} from /mcp: ${await r.text().catch(() => "")}`);
  }
  const sid = r.headers.get("mcp-session-id");
  if (sid && !httpSessionId) httpSessionId = sid;

  if (notif) return undefined;

  const ctype = r.headers.get("content-type") ?? "";
  const raw = await r.text();
  if (ctype.includes("application/json")) {
    return JSON.parse(raw);
  }
  // SSE framing: pull the first data: line as the JSON-RPC response.
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith("data:")) {
      const json = line.slice(5).trim();
      if (json) return JSON.parse(json);
    }
  }
  throw new Error(`unexpected response from /mcp: ${raw.slice(0, 200)}`);
}

async function httpInitialize(): Promise<void> {
  const res = await httpRpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: CLIENT_NAME, version: "1.0" },
  });
  if (res?.error) throw new Error(`initialize failed: ${JSON.stringify(res.error)}`);
  // Follow-up: the spec requires a notifications/initialized after initialize.
  await httpRpc("notifications/initialized").catch(() => {});
}

// Periodically touch our /mcp session so the server's reaper doesn't prune it.
// Without this, the bridge opens a session on startup, proxies tool calls
// infrequently, and after 60s of idle the server wipes the session from its
// sessions[] map — which makes Telegram's "routed to X agents" ack say
// "no agents connected" even though the bridge is still alive and subscribed.
function startSessionKeepalive(): void {
  setInterval(async () => {
    try {
      await httpRpc("tools/list").catch(() => {});
    } catch {
      // best effort; next call will re-initialize via 404 retry path
    }
  }, 30_000);
}

// ── 3. Stdio MCP server — the thing Claude Code / Cursor attaches to ─────────

const server = new McpServer(
  { name: "notify-mcp", version: "1.2.0" },
  {
    // Declare the claude/channel capability so Claude Code knows to surface
    // our notifications/claude/channel events as synthetic user turns. The
    // `reply` tool below is how Claude hands the agent's response back to us.
    // Reference: https://code.claude.com/docs/en/channels-reference
    capabilities: {
      experimental: { "claude/channel": {} },
    },
    instructions:
      "This is the stdio bridge for notify-mcp. It pushes unsolicited user " +
      "messages to the agent via `notifications/claude/channel` when the host " +
      "supports Channels (Claude Code v2.1.80+). Otherwise call `wait_for_inbox` " +
      "as a long-poll to reliably receive user messages as tool results.\n\n" +
      "ALWAYS call `notify` when: (a) a task that took >60s of wall-clock time " +
      "just finished (success or failure), (b) you have a question or need a " +
      "decision, (c) something important happened the user needs to know right " +
      "now. Idle/DND gating is handled server-side — fire notify and let the " +
      "server decide routing. Err on the side of notifying: a wrong-call gets " +
      "silently downgraded by idle gating; a missed notify costs the user hours.\n\n" +
      "ALWAYS echo the COMPLETE, UNTRUNCATED message in your chat output — never " +
      "shorten it with '…' or a summary. NEVER mention delivery channels (Telegram, " +
      "SMS, desktop, etc.) or echo 'Sent via: …' — those are server internals. " +
      "Say 'notif' or 'notification' if you need to refer to the act of notifying.\n\n" +
      "🚨 500-CHAR LIMIT — CHUNK, NEVER TRUNCATE 🚨\n" +
      "The `notify` tool rejects bodies > 500 chars with `MCP error -32602: too_big`. " +
      "When you have more to say than fits in 500 chars, you MUST split into MULTIPLE " +
      "notify calls — do NOT silently shorten the body. Procedure: (1) decide what " +
      "the user MUST see (every fact, file path, line number, recommendation); (2) if " +
      "the body exceeds 500 chars, split into N chunks numbered '(1/N) ...', '(2/N) ...', " +
      "each ≤ 500 chars including the prefix; (3) send all N chunks in order via separate " +
      "notify calls and echo all N IN FULL in chat. NEVER respond to a `too_big` error by " +
      "shortening to a single chunk — that loses information the user explicitly needs.\n\n" +
      "When the user asks you to remember a behavioral rule or change how you should act, " +
      "call `update_instructions` with the full updated rules block. This writes to CLAUDE.md " +
      "so the instructions persist across sessions and context compaction.",
  }
);

// Thin proxy: forward a tool call to the HTTP server and return its content
// block array verbatim. Error shape matches what the SDK expects from tool
// handlers.
async function proxyToolCall(name: string, args: Record<string, unknown>) {
  const res = await httpRpc("tools/call", { name, arguments: args });
  if (res?.error) {
    return { content: [{ type: "text" as const, text: `Error: ${res.error.message ?? JSON.stringify(res.error)}` }], isError: true };
  }
  const result = res?.result;
  if (result?.content && Array.isArray(result.content)) {
    return { content: result.content, isError: !!result.isError };
  }
  return { content: [{ type: "text" as const, text: JSON.stringify(result ?? {}) }] };
}

server.tool(
  "notify",
  "Send a notification to the user. Delivery channels and DND are server-configured. " +
  "MAX 500 CHARS PER MESSAGE. If you have more to say, split into multiple notify " +
  "calls with '(1/N) ...', '(2/N) ...' prefixes — never silently shorten on " +
  "`too_big` error; that loses information the user needs.",
  {
    message: z.string().max(500),
    priority: z.enum(["low", "normal", "high"]).default("normal"),
  },
  async (args) => proxyToolCall("notify", args)
);

server.tool(
  "ask",
  "Send a question to the user and wait for their reply.",
  {
    question: z.string().max(500),
    timeout_seconds: z.number().min(30).max(3600).default(300),
  },
  async (args) => proxyToolCall("ask", args)
);

server.tool(
  "poll",
  "Drain pending unsolicited user messages.",
  {},
  async () => proxyToolCall("poll", {})
);

server.tool(
  "wait_for_inbox",
  "Block until an unsolicited user message arrives or timeout expires. Reliable " +
    "delivery across every MCP client (messages come back as tool results).",
  {
    timeout_seconds: z.number().min(5).max(55).default(50),
  },
  async (args) => proxyToolCall("wait_for_inbox", args)
);

server.tool(
  "get_idle_seconds",
  "Seconds since user's last keyboard/mouse input. Drains inbox as a side-effect.",
  {},
  async () => proxyToolCall("get_idle_seconds", {})
);

server.tool(
  "get_idle_config",
  "Server's idle gating policy. Drains inbox as a side-effect.",
  {},
  async () => proxyToolCall("get_idle_config", {})
);

server.tool(
  "get_dnd_status",
  "Current DND state. Drains inbox as a side-effect.",
  {},
  async () => proxyToolCall("get_dnd_status", {})
);

server.tool(
  "update_instructions",
  "Persist behavioral instructions for this client into CLAUDE.md so they survive " +
    "session restarts and context compaction. Call when the user asks you to remember " +
    "a rule or change how you should behave. Pass the full desired block; it replaces " +
    "the previous one atomically.",
  {
    instructions: z.string().max(4000),
    target: z.enum(["global", "project"]).default("global"),
  },
  async (args) => proxyToolCall("update_instructions", args)
);

// `reply` is the Channels return-path: Claude Code invokes it when the agent
// has produced a response to a channel-delivered user message. We just funnel
// it straight through `notify` so it flows to whatever channel the user is
// actually reading (Telegram, desktop, email, ...).
server.tool(
  "reply",
  "Reply to the user's most recent channel message. Routes through notify so " +
    "the response reaches whichever channel the user is reading.",
  {
    message: z.string().max(2000).describe("The reply text to deliver"),
    priority: z.enum(["low", "normal", "high"]).default("normal"),
  },
  async ({ message, priority }) => {
    const tagPrefix = SESSION_TAG ? `[@${SESSION_TAG}] ` : "";
    return proxyToolCall("notify", { message: `${tagPrefix}${message}`, priority });
  }
);

// ── 4. SSE subscriber — the push channel ─────────────────────────────────────

interface InboxEvent { text: string; ts: string; tag?: string }

async function subscribeInbox(): Promise<void> {
  const tagQuery = SESSION_TAG ? `?tag=${encodeURIComponent(SESSION_TAG)}` : "";
  // Reconnect forever with backoff. We don't care about replay; the
  // file-drop bridge and queue handle the "missed while offline" window.
  let backoff = 1000;
  while (true) {
    try {
      const r = await fetch(`${BASE}/api/inbox/stream${tagQuery}`, {
        headers: { "Accept": "text/event-stream" },
      });
      if (!r.ok || !r.body) throw new Error(`stream HTTP ${r.status}`);
      backoff = 1000; // reset on successful connect
      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          // SSE frame: may include multiple "data:" lines. We emit on each.
          for (const line of frame.split(/\r?\n/)) {
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (!payload) continue;
            try {
              const entry = JSON.parse(payload) as InboxEvent;
              await emitChannelEvent(entry);
            } catch (err) {
              stderr(`[bridge] bad SSE payload: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        }
      }
    } catch (err) {
      stderr(`[bridge] inbox stream closed: ${err instanceof Error ? err.message : String(err)}`);
    }
    await new Promise(r => setTimeout(r, backoff));
    backoff = Math.min(30_000, backoff * 2);
  }
}

async function emitChannelEvent(entry: InboxEvent): Promise<void> {
  // Emit the new Claude Code Channels notification *and* the generic
  // `notifications/message` as a belt-and-suspenders approach: hosts that
  // ignore `notifications/claude/channel` may still surface the message as
  // a log line. Both are fire-and-forget; a failure just means the peer
  // closed the stdio transport (we'll notice on the next tool call).
  const content = entry.tag ? `[@${entry.tag}] ${entry.text}` : entry.text;
  try {
    await (server.server as any).notification({
      method: "notifications/claude/channel",
      params: {
        content,
        meta: { ts: entry.ts, tag: entry.tag ?? null, source: "notify-mcp" },
      },
    });
  } catch {
    // client doesn't support the experimental capability — that's fine,
    // wait_for_inbox is the universal fallback.
  }
}

// ── 5. Wire it up ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!(await serverIsUp())) {
    spawnUiServerIfNeeded();
    if (!(await waitForServer())) {
      stderr(`[bridge] HTTP server at ${BASE} did not come up within 15s — giving up on push; tool calls will fail.`);
    }
  }

  try { await httpInitialize(); }
  catch (err) { stderr(`[bridge] initial HTTP initialize failed: ${err instanceof Error ? err.message : String(err)}`); }

  // Fire-and-forget: the stdio transport should be usable immediately; the
  // push channel attaches as soon as the SSE handshake completes.
  subscribeInbox().catch(err => stderr(`[bridge] inbox subscriber crashed: ${err instanceof Error ? err.message : String(err)}`));
  startSessionKeepalive();

  const transport = new StdioServerTransport();
  await server.connect(transport);
  stderr(`[bridge] stdio MCP bridge ready (tag=${SESSION_TAG ?? "none"}, port=${PORT})`);
}

main().catch(err => {
  stderr(`[bridge] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
