import { randomUUID } from "crypto";
import express from "express";
import { google } from "googleapis";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { homedir, networkInterfaces } from "os";
import { join } from "path";
import { fileURLToPath } from "url";
import { spawnSync, spawn } from "child_process";
import open from "open";
import notifier from "node-notifier";
import nodemailer from "nodemailer";
import twilio from "twilio";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3737;
const REDIRECT_URI = `http://localhost:${PORT}/auth/google/callback`;

// Public dir: two levels up from dist/ui/ → project root → ui/public/
const PUBLIC_DIR = join(fileURLToPath(new URL("../../ui/public", import.meta.url)));

const CONFIG_DIR = join(homedir(), ".notify-mcp");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");
const ADC_PATH = join(homedir(), ".config", "gcloud", "application_default_credentials.json");

function defaultConfig() {
  return {
    desktop: { enabled: false },
    telegram: { enabled: false, token: "", chatId: "" },
    whatsapp: { enabled: false, instanceId: "", apiToken: "", phone: "" },
    sms: { enabled: false, accountSid: "", authToken: "", from: "", to: "" },
    email: { enabled: false, to: "" },
  };
}

function loadConfig(): Record<string, any> {
  if (!existsSync(CONFIG_PATH)) return defaultConfig();
  return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
}

function saveConfig(config: Record<string, any>): void {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

const MASKED = "••••••••";

function maskSecrets(config: Record<string, any>): Record<string, any> {
  const c = JSON.parse(JSON.stringify(config));
  if (c.email?.pass) c.email.pass = MASKED;
  if (c.email?.clientSecret) c.email.clientSecret = MASKED;
  if (c.email?.refreshToken) c.email.refreshToken = MASKED;
  if (c.email?.accessToken) c.email.accessToken = MASKED;
  if (c.sms?.authToken) c.sms.authToken = MASKED;
  if (c.telegram?.token) c.telegram.token = MASKED;
  if (c.whatsapp?.apiToken) c.whatsapp.apiToken = MASKED;
  return c;
}

function mergePreservingSecrets(
  existing: Record<string, any>,
  update: Record<string, any>
): Record<string, any> {
  const merged: Record<string, any> = { ...defaultConfig(), ...existing };
  for (const section of ["desktop", "telegram", "whatsapp", "sms", "email"] as const) {
    merged[section] = { ...(merged[section] || {}), ...(update[section] || {}) };
  }
  // Don't overwrite real values with masked placeholders
  const guard = (path: [string, string]) => {
    const [sec, field] = path;
    if (update[sec]?.[field] === MASKED) {
      merged[sec][field] = existing[sec]?.[field] ?? "";
    }
  };
  guard(["email", "pass"]);
  guard(["email", "clientSecret"]);
  guard(["email", "refreshToken"]);
  guard(["email", "accessToken"]);
  guard(["sms", "authToken"]);
  guard(["telegram", "token"]);
  guard(["whatsapp", "apiToken"]);
  return merged;
}

const app = express();
app.use(express.json());
app.use(express.static(PUBLIC_DIR));

// ── Config API ────────────────────────────────────────────────────────────────

app.get("/api/config", (_req, res) => {
  res.json(maskSecrets(loadConfig()));
});

app.post("/api/config", (req, res) => {
  try {
    const merged = mergePreservingSecrets(loadConfig(), req.body);
    saveConfig(merged);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── Test routes ───────────────────────────────────────────────────────────────

app.post("/api/test/desktop", (_req, res) => {
  const time = new Date().toLocaleTimeString();
  notifier.notify(
    { title: "Claude Notify", message: `Desktop is working! (${time})`, sound: true },
    (err) => {
      if (err) res.status(500).json({ error: String(err) });
      else res.json({ ok: true, message: "Desktop notification sent!" });
    }
  );
});

app.post("/api/test/telegram", async (_req, res) => {
  const config = loadConfig();
  const { token, chatId } = config.telegram ?? {};
  if (!token || !chatId) {
    res.status(400).json({ error: "Token and Chat ID are required." });
    return;
  }
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: "Test from Claude Notify — Telegram is working!" }),
    });
    if (!r.ok) throw new Error(`Telegram ${r.status}: ${await r.text()}`);
    res.json({ ok: true, message: "Telegram message sent!" });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get("/api/telegram/chatid", async (req, res) => {
  const token = (req.query.token as string) ?? loadConfig().telegram?.token;
  if (!token || token === "••••••••") {
    res.status(400).json({ error: "Token required" });
    return;
  }
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/getUpdates`);
    const json = await r.json() as any;
    const chatId = json.result?.[0]?.message?.chat?.id?.toString();
    if (!chatId) {
      res.status(404).json({ error: "No messages yet — send any message to your bot first" });
      return;
    }
    res.json({ chatId });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post("/api/test/whatsapp", async (_req, res) => {
  const config = loadConfig();
  const { instanceId, apiToken, phone } = config.whatsapp ?? {};
  if (!instanceId || !apiToken || !phone) {
    res.status(400).json({ error: "Instance ID, API token and phone are required." });
    return;
  }
  try {
    const r = await fetch(
      `https://api.green-api.com/waInstance${instanceId}/sendMessage/${apiToken}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chatId: `${phone}@c.us`, message: "Test from Claude Notify — WhatsApp is working!" }),
      }
    );
    if (!r.ok) throw new Error(`Green API ${r.status}: ${await r.text()}`);
    res.json({ ok: true, message: "WhatsApp message sent!" });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post("/api/test/sms", async (_req, res) => {
  const config = loadConfig();
  const { accountSid, authToken, from, to } = config.sms ?? {};
  if (!accountSid || !authToken || !from || !to) {
    res.status(400).json({ error: "All SMS fields are required." });
    return;
  }
  try {
    const client = twilio(accountSid, authToken);
    await client.messages.create({ body: "Test from Claude Notify — SMS is working!", from, to });
    res.json({ ok: true, message: `SMS sent to ${to}` });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post("/api/test/email", async (_req, res) => {
  const config = loadConfig();
  const email = config.email ?? {};
  if (!email.to) {
    res.status(400).json({ error: "No recipient address configured." });
    return;
  }
  try {
    let transport;
    if (email.refreshToken && email.clientId && email.clientSecret) {
      transport = nodemailer.createTransport({
        service: "gmail",
        auth: {
          type: "OAuth2",
          user: email.connectedEmail ?? email.to,
          clientId: email.clientId,
          clientSecret: email.clientSecret,
          refreshToken: email.refreshToken,
          accessToken: email.accessToken,
        },
      });
    } else if (email.host && email.user && email.pass) {
      transport = nodemailer.createTransport({
        host: email.host,
        port: email.port ?? 587,
        secure: email.secure ?? false,
        auth: { user: email.user, pass: email.pass },
      });
    } else {
      res.status(400).json({ error: "Email not fully configured. Connect Gmail or set SMTP." });
      return;
    }
    await transport.sendMail({
      from: email.connectedEmail ?? email.user ?? email.to,
      to: email.to,
      subject: "Claude Notify — test email",
      text: "Test from Claude Notify — email is working!",
    });
    res.json({ ok: true, message: `Email sent to ${email.to}` });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── Google ADC auto-setup ─────────────────────────────────────────────────────

async function adcEmail(): Promise<string | null> {
  if (!existsSync(ADC_PATH)) return null;
  try {
    const adc = JSON.parse(readFileSync(ADC_PATH, "utf-8"));
    if (!adc.refresh_token || !adc.client_id || !adc.client_secret) return null;
    const oauth2Client = new google.auth.OAuth2(adc.client_id, adc.client_secret);
    oauth2Client.setCredentials({ refresh_token: adc.refresh_token });
    const oauth2 = google.oauth2({ version: "v2", auth: oauth2Client });
    const { data } = await oauth2.userinfo.get();
    return data.email ?? null;
  } catch {
    return null;
  }
}

app.get("/api/google/open-apppasswords", (_req, res) => {
  open("https://myaccount.google.com/apppasswords").catch(() => {});
  res.json({ ok: true });
});

app.post("/api/google/apppassword", async (req, res) => {
  const { gmailAddress, appPassword } = req.body as { gmailAddress: string; appPassword: string };
  if (!gmailAddress || !appPassword) {
    res.status(400).json({ error: "Gmail address and app password required" });
    return;
  }
  try {
    const transport = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 587,
      secure: false,
      auth: { user: gmailAddress, pass: appPassword },
    });
    await transport.verify();
    const cfg = loadConfig();
    cfg.email = {
      ...cfg.email,
      host: "smtp.gmail.com",
      port: 587,
      secure: false,
      user: gmailAddress,
      pass: appPassword,
      connectedEmail: gmailAddress,
      to: cfg.email?.to || gmailAddress,
      enabled: true,
    };
    saveConfig(cfg);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── gcloud auth ───────────────────────────────────────────────────────────────

function gcloudStatus(): { installed: boolean; authenticated: boolean; account?: string } {
  const check = spawnSync("gcloud", ["--version"], { encoding: "utf-8" });
  if (check.status !== 0) return { installed: false, authenticated: false };

  const list = spawnSync(
    "gcloud",
    ["auth", "list", "--filter=status:ACTIVE", "--format=value(account)"],
    { encoding: "utf-8" }
  );
  const account = list.stdout.trim().split("\n")[0];
  return { installed: true, authenticated: !!account, account: account || undefined };
}

app.get("/api/gcloud/status", (_req, res) => {
  res.json(gcloudStatus());
});

app.get("/api/gcloud/login", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const send = (type: string, msg: string) =>
    res.write(`data: ${JSON.stringify({ type, msg })}\n\n`);

  const status = gcloudStatus();
  if (!status.installed) {
    send("error", "gcloud not found. Install: brew install --cask google-cloud-sdk");
    res.end();
    return;
  }
  if (status.authenticated) {
    send("already_authed", status.account!);
    res.end();
    return;
  }

  send("info", "Opening browser for Google login…");

  const child = spawn("gcloud", ["auth", "login", "--brief"], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.on("data", (d: Buffer) => {
    for (const line of d.toString().split("\n").filter(Boolean))
      send("log", line);
  });

  child.stderr.on("data", (d: Buffer) => {
    for (const line of d.toString().split("\n").filter(Boolean)) {
      if (line.includes("Go to the following link"))
        send("open_browser", line.replace("Go to the following link in your browser:", "").trim());
      else
        send("log", line);
    }
  });

  child.on("close", (code) => {
    if (code === 0) {
      const after = gcloudStatus();
      send("done", after.account ?? "Logged in");
    } else {
      send("error", `gcloud auth login exited with code ${code}`);
    }
    res.end();
  });

  req.on("close", () => child.kill());
});

// ── Google OAuth ──────────────────────────────────────────────────────────────

app.get("/auth/google/start", (req, res) => {
  const config = loadConfig();
  const { clientId, clientSecret } = config.email ?? {};
  if (!clientId || !clientSecret) {
    res.redirect("/?error=missing_credentials");
    return;
  }
  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);
  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [
      "https://mail.google.com/",
      "https://www.googleapis.com/auth/userinfo.email",
    ],
  });
  res.redirect(url);
});

app.get("/auth/google/callback", async (req, res) => {
  const { code, error } = req.query as Record<string, string>;
  if (error) {
    res.redirect(`/?error=${encodeURIComponent(error)}`);
    return;
  }
  const config = loadConfig();
  const { clientId, clientSecret } = config.email ?? {};
  try {
    const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    const oauth2 = google.oauth2({ version: "v2", auth: oauth2Client });
    const { data } = await oauth2.userinfo.get();

    config.email.refreshToken = tokens.refresh_token ?? config.email.refreshToken;
    config.email.accessToken = tokens.access_token;
    config.email.connectedEmail = data.email;
    config.email.enabled = true;
    saveConfig(config);

    res.redirect("/?success=gmail_connected");
  } catch (err) {
    res.redirect(`/?error=${encodeURIComponent(String(err))}`);
  }
});

app.delete("/auth/google", (_req, res) => {
  const config = loadConfig();
  delete config.email.refreshToken;
  delete config.email.accessToken;
  delete config.email.connectedEmail;
  config.email.enabled = false;
  saveConfig(config);
  res.json({ ok: true });
});

// ── MCP over SSE ──────────────────────────────────────────────────────────────

async function sendNotification(message: string, priority: "low" | "normal" | "high") {
  const cfg = loadConfig();
  const results: string[] = [];
  const errors: string[] = [];

  const send = async (name: string, fn: () => Promise<void>) => {
    try { await fn(); results.push(name); }
    catch (err) { errors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`); }
  };

  if (priority !== "low") {
    if (cfg.desktop?.enabled) {
      await send("desktop", () => new Promise<void>((res, rej) =>
        notifier.notify({ title: "Claude Notify", message, sound: true },
          (err) => err ? rej(err) : res())));
    }
    if (cfg.telegram?.enabled && cfg.telegram.token && cfg.telegram.chatId) {
      await send("telegram", async () => {
        const r = await fetch(`https://api.telegram.org/bot${cfg.telegram.token}/sendMessage`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: cfg.telegram.chatId, text: message }),
        });
        if (!r.ok) throw new Error(await r.text());
      });
    }
  }

  if (priority === "high") {
    const sms = cfg.sms ?? {};
    if (sms.enabled && sms.accountSid && sms.authToken && sms.from && sms.to) {
      await send("sms", async () => {
        const client = twilio(sms.accountSid, sms.authToken);
        await client.messages.create({ body: message, from: sms.from, to: sms.to });
      });
    }
  }

  const email = cfg.email ?? {};
  if (email.enabled && email.to) {
    await send("email", async () => {
      let transport;
      if (email.refreshToken && email.clientId && email.clientSecret) {
        transport = nodemailer.createTransport({
          service: "gmail", auth: { type: "OAuth2", user: email.connectedEmail ?? email.to,
            clientId: email.clientId, clientSecret: email.clientSecret,
            refreshToken: email.refreshToken, accessToken: email.accessToken },
        });
      } else if (email.host && email.user && email.pass) {
        transport = nodemailer.createTransport({
          host: email.host, port: email.port ?? 587, secure: email.secure ?? false,
          auth: { user: email.user, pass: email.pass },
        });
      } else return;
      await transport.sendMail({ from: email.connectedEmail ?? email.user ?? email.to,
        to: email.to, subject: "Claude Notify", text: message });
    });
  }

  return [
    results.length ? `Sent via: ${results.join(", ")}` : null,
    errors.length ? `Errors: ${errors.join("; ")}` : null,
  ].filter(Boolean).join(" | ") || "No channels delivered";
}

function getLocalIp() {
  for (const nets of Object.values(networkInterfaces())) {
    for (const net of nets ?? []) {
      if (net.family === "IPv4" && !net.internal) return net.address;
    }
  }
  return "localhost";
}

// ── Ask / reply system ────────────────────────────────────────────────────────

const pendingAsks = new Map<string, { resolve: (v: string) => void; timer: NodeJS.Timeout }>();
let tgPollOffset = 0;
let tgPollActive = false;

async function pollTelegram() {
  if (tgPollActive) return;
  tgPollActive = true;
  while (pendingAsks.size > 0) {
    try {
      const cfg = loadConfig();
      const { token, chatId } = cfg.telegram ?? {};
      if (!token || !chatId) break;
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
          }
        }
      }
    } catch {
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  tgPollActive = false;
}

app.get("/reply/:token", (req, res) => {
  const pending = pendingAsks.get(req.params.token);
  res.send(`<!DOCTYPE html><html><head><title>Reply to Claude</title>
<style>body{font-family:sans-serif;background:#0a0a0b;color:#f0f0f0;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.box{background:#111113;border:1px solid #222226;border-radius:9px;padding:24px;max-width:500px;width:90%}
h2{color:#7c6dfa;margin:0 0 16px}textarea{width:100%;background:#0d0d10;border:1px solid #222226;border-radius:7px;color:#f0f0f0;padding:8px;font-size:14px;resize:vertical;min-height:80px;box-sizing:border-box}
button{background:#7c6dfa;color:white;border:none;border-radius:7px;padding:8px 20px;font-size:14px;cursor:pointer;margin-top:10px}
.ok{color:#10b981;margin-top:12px}.err{color:#ef4444}</style></head>
<body><div class="box">${pending
    ? `<h2>Reply to Claude</h2><textarea id="r" placeholder="Type your response…"></textarea>
       <button onclick="send()">Send</button><div id="s"></div>
       <script>async function send(){const r=document.getElementById('r').value.trim();if(!r)return;
       const res=await fetch('/reply/${req.params.token}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({response:r})});
       const el=document.getElementById('s');el.textContent=res.ok?'✓ Sent!':'Error';el.className=res.ok?'ok':'err';}</script>`
    : `<h2>Expired</h2><p class="err">This link has already been used or timed out.</p>`
  }</div></body></html>`);
});

app.post("/reply/:token", (req, res) => {
  const pending = pendingAsks.get(req.params.token);
  if (!pending) { res.status(404).json({ error: "Expired" }); return; }
  clearTimeout(pending.timer);
  pendingAsks.delete(req.params.token);
  pending.resolve(req.body.response as string);
  res.json({ ok: true });
});

function createMcpServer() {
  const server = new McpServer({ name: "notify-mcp", version: "1.0.0" });
  server.tool(
    "notify",
    "Send a notification through configured channels (desktop, Telegram, SMS, email). " +
      "Use for: task milestones, questions needing input, catastrophic findings, long task completion.",
    {
      message: z.string().max(500).describe("Notification message, max 500 chars"),
      priority: z.enum(["low", "normal", "high"]).default("normal")
        .describe("low=email only; normal=desktop+telegram+email; high=all channels"),
    },
    async ({ message, priority }: { message: string; priority: "low" | "normal" | "high" }) => {
      const summary = await sendNotification(message, priority);
      return { content: [{ type: "text" as const, text: summary }] };
    }
  );

  server.tool(
    "ask",
    "Send a question and wait for the user's reply via Telegram or email. " +
      "Use when Claude needs a decision before continuing — e.g. 'Should I delete these files?'",
    {
      question: z.string().max(500).describe("The question to ask the user"),
      timeout_seconds: z.number().min(30).max(3600).default(300)
        .describe("How long to wait for a reply in seconds (default 5 min)"),
    },
    async ({ question, timeout_seconds = 300 }: { question: string; timeout_seconds?: number }) => {
      const token = randomUUID();
      const ip = getLocalIp();
      const replyUrl = `http://${ip}:${PORT}/reply/${token}`;
      const cfg = loadConfig();

      // Send via Telegram
      if (cfg.telegram?.enabled && cfg.telegram.token && cfg.telegram.chatId) {
        await fetch(`https://api.telegram.org/bot${cfg.telegram.token}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: cfg.telegram.chatId,
            text: `❓ ${question}\n\nReply to this message with your answer.`,
          }),
        }).catch(() => {});
      }

      // Send via email with reply link
      const email = cfg.email ?? {};
      if (email.enabled && email.to) {
        try {
          let transport;
          if (email.refreshToken && email.clientId && email.clientSecret) {
            transport = nodemailer.createTransport({
              service: "gmail", auth: { type: "OAuth2", user: email.connectedEmail ?? email.to,
                clientId: email.clientId, clientSecret: email.clientSecret,
                refreshToken: email.refreshToken, accessToken: email.accessToken },
            });
          } else if (email.host && email.user && email.pass) {
            transport = nodemailer.createTransport({
              host: email.host, port: email.port ?? 587, secure: email.secure ?? false,
              auth: { user: email.user, pass: email.pass },
            });
          }
          if (transport) {
            await transport.sendMail({
              from: email.connectedEmail ?? email.user ?? email.to,
              to: email.to,
              subject: `Claude asks: ${question.slice(0, 60)}`,
              html: `<p style="font-size:16px">${question}</p>
                     <p><a href="${replyUrl}" style="background:#7c6dfa;color:white;padding:10px 20px;border-radius:6px;text-decoration:none;display:inline-block;margin-top:8px">Reply to Claude</a></p>`,
            });
          }
        } catch { /* best effort */ }
      }

      // Wait for reply
      const reply = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingAsks.delete(token);
          reject(new Error(`No reply received within ${timeout_seconds}s`));
        }, timeout_seconds * 1000);
        pendingAsks.set(token, { resolve, timer });
        pollTelegram();
      });

      return { content: [{ type: "text" as const, text: reply }] };
    }
  );

  return server;
}

const httpTransports: Record<string, StreamableHTTPServerTransport> = {};

app.all("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  if (sessionId && httpTransports[sessionId]) {
    await httpTransports[sessionId].handleRequest(req, res, req.body);
    return;
  }

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
  transport.onclose = () => {
    if (transport.sessionId) delete httpTransports[transport.sessionId];
  };
  await createMcpServer().connect(transport);
  await transport.handleRequest(req, res, req.body);
  if (transport.sessionId) httpTransports[transport.sessionId] = transport;
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, "0.0.0.0", () => {
  const ip = getLocalIp();
  console.log(`\n  Claude Notify config UI  → http://localhost:${PORT}`);
  console.log(`  MCP endpoint (remote)    → http://${ip}:${PORT}/mcp\n`);
  open(`http://localhost:${PORT}`).catch(() => {});
});
