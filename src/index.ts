import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { sendDesktop } from "./channels/desktop.js";
import { sendWhatsApp } from "./channels/whatsapp.js";
import { sendSms } from "./channels/sms.js";
import { sendEmail } from "./channels/email.js";

const config = loadConfig();

const server = new McpServer({
  name: "notify-mcp",
  version: "1.0.0",
});

const notifySchema = {
  message: z.string().max(500).describe("Notification message, max 500 chars"),
  priority: z
    .enum(["low", "normal", "high"])
    .default("normal")
    .describe("low=email only; normal=desktop+email; high=desktop+whatsapp+sms+email"),
} as const;

server.tool(
  "notify",
  "Send a notification through configured channels (desktop, WhatsApp, SMS, email). " +
    "Use for: task milestones, questions needing user input, catastrophic findings, long task completion.",
  notifySchema,
  async ({ message, priority }: { message: string; priority: "low" | "normal" | "high" }) => {
    const results: string[] = [];
    const errors: string[] = [];

    const send = async (name: string, fn: () => Promise<void>) => {
      try {
        await fn();
        results.push(name);
      } catch (err) {
        errors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    };

    if (priority === "normal" || priority === "high") {
      await send("desktop", () => sendDesktop(config.desktop, message));
    }

    if (priority === "high") {
      await send("whatsapp", () => sendWhatsApp(config.whatsapp, message));
      await send("sms", () => sendSms(config.sms, message));
    }

    await send("email", () => sendEmail(config.email, message));

    const summary = [
      results.length > 0 ? `Sent via: ${results.join(", ")}` : null,
      errors.length > 0 ? `Errors: ${errors.join("; ")}` : null,
    ]
      .filter(Boolean)
      .join(" | ");

    return { content: [{ type: "text", text: summary || "No channels delivered" }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
