#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { randomUUID } from "crypto";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { sendDesktop } from "./channels/desktop.js";
import { sendTelegram } from "./channels/telegram.js";
import { sendWhatsApp } from "./channels/whatsapp.js";
import { sendSms } from "./channels/sms.js";
import { sendEmail } from "./channels/email.js";

const config = loadConfig();

// ── Telegram listener ─────────────────────────────────────────────────────────

const pendingAsks = new Map<string, { resolve: (v: string) => void; timer: NodeJS.Timeout }>();
const inboxQueue: Array<{ text: string; ts: string }> = [];
let tgPollOffset = -1;

async function initTgOffset(token: string): Promise<number> {
  const r = await fetch(`https://api.telegram.org/bot${token}/getUpdates?offset=-1&timeout=0`);
  const json = await r.json() as any;
  const results: any[] = json.result ?? [];
  return results.length > 0 ? results[results.length - 1].update_id + 1 : 0;
}

async function startTelegramListener() {
  while (true) {
    try {
      const cfg = loadConfig();
      const { token, chatId } = cfg.telegram ?? {};
      if (!token || !chatId || !cfg.telegram?.enabled) {
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }
      if (tgPollOffset < 0) {
        tgPollOffset = await initTgOffset(token);
      }
      const r = await fetch(
        `https://api.telegram.org/bot${token}/getUpdates?offset=${tgPollOffset}&timeout=10`
      );
      const json = await r.json() as any;
      for (const update of json.result ?? []) {
        tgPollOffset = update.update_id + 1;
        const msg = update.message;
        if (msg?.chat?.id?.toString() === chatId && msg.text) {
          const first = [...pendingAsks.entries()][0];
          if (first) {
            const [id, pending] = first;
            clearTimeout(pending.timer);
            pendingAsks.delete(id);
            pending.resolve(msg.text);
          } else {
            inboxQueue.push({ text: msg.text, ts: new Date().toISOString() });
          }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("terminated") && !msg.includes("aborted")) {
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  }
}

startTelegramListener();

// ── MCP server ────────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "omni-notify-mcp",
  version: "1.0.0",
});

server.tool(
  "notify",
  "Send a notification through configured channels (desktop, Telegram, WhatsApp, SMS, email). " +
    "Priority: low=email only; normal=desktop+telegram+email; high=all channels. " +
    "Use for: task milestones, questions needing user input, catastrophic findings, long task completion.",
  {
    message: z.string().max(500).describe("Notification message, max 500 chars"),
    priority: z
      .enum(["low", "normal", "high"])
      .default("normal")
      .describe("low=email only; normal=desktop+telegram+email; high=desktop+telegram+whatsapp+sms+email"),
  },
  async ({ message, priority }: { message: string; priority: "low" | "normal" | "high" }) => {
    const results: string[] = [];
    const errors: string[] = [];

    const send = async (name: string, fn: () => Promise<void>) => {
      try { await fn(); results.push(name); }
      catch (err) { errors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`); }
    };

    if (priority === "normal" || priority === "high") {
      await send("desktop", () => sendDesktop(config.desktop, message));
      await send("telegram", () => sendTelegram(config.telegram, message));
    }
    if (priority === "high") {
      await send("whatsapp", () => sendWhatsApp(config.whatsapp, message));
      await send("sms", () => sendSms(config.sms, message));
    }
    await send("email", () => sendEmail(config.email, message));

    const summary = [
      results.length > 0 ? `Sent via: ${results.join(", ")}` : null,
      errors.length > 0 ? `Errors: ${errors.join("; ")}` : null,
    ].filter(Boolean).join(" | ");

    return { content: [{ type: "text", text: summary || "No channels delivered" }] };
  }
);

server.tool(
  "ask",
  "Send a question to the user via Telegram and wait for their reply. " +
    "Use when a decision is needed before continuing — e.g. 'Should I delete these files?'",
  {
    question: z.string().max(500).describe("The question to ask the user"),
    timeout_seconds: z.number().min(30).max(3600).default(300)
      .describe("How long to wait for a reply in seconds (default 5 min)"),
  },
  async ({ question, timeout_seconds = 300 }: { question: string; timeout_seconds?: number }) => {
    const cfg = loadConfig();
    if (!cfg.telegram?.enabled || !cfg.telegram.token || !cfg.telegram.chatId) {
      return { content: [{ type: "text", text: "Error: Telegram not configured. Enable it in ~/.notify-mcp/config.json" }] };
    }

    await fetch(`https://api.telegram.org/bot${cfg.telegram.token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: cfg.telegram.chatId,
        text: `❓ ${question}\n\nReply to this message with your answer.`,
      }),
    });

    const token = randomUUID();
    const reply = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingAsks.delete(token);
        reject(new Error(`No reply received within ${timeout_seconds}s`));
      }, timeout_seconds * 1000);
      pendingAsks.set(token, { resolve, timer });
    });

    return { content: [{ type: "text", text: reply }] };
  }
);

server.tool(
  "poll",
  "Check for unsolicited messages the user sent on Telegram (not in response to an ask). " +
    "Returns queued messages and clears the queue. Returns 'inbox:empty' if nothing pending. " +
    "Call this at the start of each work cycle.",
  {},
  async () => {
    if (inboxQueue.length === 0) {
      return { content: [{ type: "text", text: "inbox:empty" }] };
    }
    const messages = inboxQueue.splice(0);
    return {
      content: [{
        type: "text",
        text: messages.map(m => `[${m.ts}] ${m.text}`).join("\n"),
      }],
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
