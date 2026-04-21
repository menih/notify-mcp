#!/usr/bin/env node
import { randomUUID } from "crypto";
import express from "express";
import { google } from "googleapis";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "fs";
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
import { tmpdir } from "os";

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3737;
const REDIRECT_URI = `http://localhost:${PORT}/auth/google/callback`;

const PUBLIC_DIR = join(fileURLToPath(new URL("../../ui/public", import.meta.url)));

const CONFIG_DIR = join(homedir(), ".notify-mcp");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");
const ADC_PATH = join(homedir(), ".config", "gcloud", "application_default_credentials.json");

function defaultConfig() {
  return {
    desktop: { enabled: false, sound: true },
    telegram: { enabled: false, token: "", chatId: "" },
    whatsapp: { enabled: false, instanceId: "", apiToken: "", phone: "" },
    sms: { enabled: false, accountSid: "", authToken: "", from: "", to: "" },
    email: { enabled: false, to: "" },
    ntfy: { enabled: false, topic: "", serverUrl: "https://ntfy.sh", token: "" },
    discord: { enabled: false, webhookUrl: "", username: "Claude Notify" },
    slack: { enabled: false, webhookUrl: "" },
    teams: { enabled: false, webhookUrl: "" },
    dnd: {
      enabled: false,      // manual toggle — when true, suppress all non-priority=high notifs
      schedule: {          // scheduled DND windows — evaluated if dnd.enabled === false
        enabled: false,
        quietStart: "22:00", // HH:mm local time
        quietEnd: "08:00",   // HH:mm local time (wraps past midnight if end < start)
        days: [0, 1, 2, 3, 4, 5, 6], // 0=Sunday..6=Saturday
      },
    },
    idle: {
      enabled: true,         // when true, the server gates non-urgent notifs based on user activity
      thresholdSeconds: 120, // <= this → user considered "active" → suppress remote channels
      alwaysDesktopWhenActive: true, // when active+gated, still play desktop sound+banner so the user knows *something* happened (cheap local signal, doesn't blast the phone)
    },
  };
}

/**
 * Returns true if notifications should be suppressed right now based on DND config.
 * priority=high always bypasses DND (handled by caller, not here).
 */
function isDndActive(cfg: Record<string, any>): boolean {
  const dnd = cfg.dnd ?? {};
  if (dnd.enabled === true) return true;          // manual toggle wins
  const sched = dnd.schedule;
  if (!sched || !sched.enabled) return false;

  const now = new Date();
  const day = now.getDay();
  if (!Array.isArray(sched.days) || !sched.days.includes(day)) return false;

  const [sH, sM] = String(sched.quietStart ?? "22:00").split(":").map((s: string) => parseInt(s, 10) || 0);
  const [eH, eM] = String(sched.quietEnd ?? "08:00").split(":").map((s: string) => parseInt(s, 10) || 0);
  const startMin = sH * 60 + sM;
  const endMin = eH * 60 + eM;
  const nowMin = now.getHours() * 60 + now.getMinutes();

  if (startMin === endMin) return false;
  // Wrap past midnight: e.g. start=22:00, end=08:00 → "in quiet" if nowMin >= start OR nowMin < end
  if (startMin < endMin) {
    return nowMin >= startMin && nowMin < endMin;
  } else {
    return nowMin >= startMin || nowMin < endMin;
  }
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
  if (c.ntfy?.token) c.ntfy.token = MASKED;
  if (c.discord?.webhookUrl) c.discord.webhookUrl = MASKED;
  if (c.slack?.webhookUrl) c.slack.webhookUrl = MASKED;
  if (c.teams?.webhookUrl) c.teams.webhookUrl = MASKED;
  return c;
}

function mergePreservingSecrets(
  existing: Record<string, any>,
  update: Record<string, any>
): Record<string, any> {
  const merged: Record<string, any> = { ...defaultConfig(), ...existing };
  for (const section of ["desktop", "telegram", "whatsapp", "sms", "email", "ntfy", "discord", "slack", "teams", "dnd", "idle"] as const) {
    merged[section] = { ...(merged[section] || {}), ...(update[section] || {}) };
  }
  // Nested schedule inside dnd
  if (update.dnd?.schedule) {
    merged.dnd.schedule = { ...(merged.dnd.schedule || {}), ...update.dnd.schedule };
  }
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
  guard(["ntfy", "token"]);
  guard(["discord", "webhookUrl"]);
  guard(["slack", "webhookUrl"]);
  guard(["teams", "webhookUrl"]);
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

// Sound-only test — fires a system sound regardless of the saved 'sound'
// toggle, so the user can preview the chime. On Windows, SnoreToast's
// notification-sound is often muted per-app by Windows, so we ALSO trigger
// a PowerShell console beep as a guaranteed-audible fallback. On mac/Linux
// node-notifier's `sound: true` works reliably, no fallback needed.
app.post("/api/test/sound", (_req, res) => {
  if (process.platform === "win32") {
    // Use System.Media.SystemSounds.Asterisk — plays through the sound card
    // (Windows notification sound), works on every machine. console::beep
    // uses the PC speaker which modern hardware lacks.
    spawn("powershell", [
      "-NoProfile",
      "-Command",
      "Add-Type -AssemblyName System.Windows.Forms; [System.Media.SystemSounds]::Asterisk.Play(); Start-Sleep -Milliseconds 600",
    ], { windowsHide: true, stdio: "ignore" });
    res.json({ ok: true, message: "Sound played (System.Media)" });
    return;
  }
  notifier.notify(
    { title: "Claude Notify", message: "Sound test", sound: true, wait: false },
    (err) => {
      if (err) res.status(500).json({ error: String(err) });
      else res.json({ ok: true, message: "System sound triggered" });
    }
  );
});

async function speakText(text: string, voice: string): Promise<void> {
  const mod: any = await import("msedge-tts");
  const { MsEdgeTTS, OUTPUT_FORMAT } = mod;
  const tts = new MsEdgeTTS();
  await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
  const { mkdtempSync } = await import("fs");
  const outDir = mkdtempSync(join(tmpdir(), "notify-tts-"));
  const { audioFilePath } = await tts.toFile(outDir, text);
  if (process.platform === "win32") {
    spawn("powershell", [
      "-NoProfile", "-Command",
      `Add-Type -AssemblyName presentationCore; $p = New-Object System.Windows.Media.MediaPlayer; $done = $false; Register-ObjectEvent $p MediaEnded -Action { $script:done = $true } | Out-Null; $p.Open([uri]'${audioFilePath.replace(/\\/g, "\\\\")}'); $p.Play(); while (-not $done) { Start-Sleep -Milliseconds 200 }`,
    ], { windowsHide: true, stdio: "ignore" });
  } else if (process.platform === "darwin") {
    spawn("afplay", [audioFilePath], { stdio: "ignore" });
  } else {
    spawn("aplay", [audioFilePath], { stdio: "ignore" });
  }
}

app.post("/api/test/tts", async (req, res) => {
  try {
    const cfg = loadConfig();
    const voice =
      (typeof req.body?.voice === "string" && req.body.voice) ||
      cfg.desktop?.ttsVoice ||
      "en-US-AndrewMultilingualNeural";
    await speakText("Notification from Claude. This is a voice test.", voice);
    res.json({ ok: true, message: `TTS played (${voice})` });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

let voiceCache: { ts: number; voices: any[] } | null = null;
app.get("/api/voices", async (_req, res) => {
  try {
    if (!voiceCache || Date.now() - voiceCache.ts > 24 * 60 * 60 * 1000) {
      const mod: any = await import("msedge-tts");
      const tts = new mod.MsEdgeTTS();
      const all = await tts.getVoices();
      voiceCache = {
        ts: Date.now(),
        voices: all
          .filter((v: any) => v.Locale.startsWith("en-") && v.ShortName.includes("Neural"))
          .map((v: any) => ({ shortName: v.ShortName, gender: v.Gender, locale: v.Locale })),
      };
    }
    res.json({ voices: voiceCache.voices });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/api/test/desktop", (_req, res) => {
  const time = new Date().toLocaleTimeString();
  const cfg = loadConfig();
  const wantSound = cfg.desktop?.sound !== false;
  if (wantSound && process.platform === "win32") {
    spawn("powershell", [
      "-NoProfile", "-Command",
      "Add-Type -AssemblyName System.Windows.Forms; [System.Media.SystemSounds]::Asterisk.Play(); Start-Sleep -Milliseconds 600",
    ], { windowsHide: true, stdio: "ignore" });
  }
  notifier.notify(
    {
      title: "Claude Notify",
      message: `Desktop is working! (${time})`,
      sound: wantSound && process.platform !== "win32",
    },
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

app.post("/api/test/ntfy", async (_req, res) => {
  const cfg = loadConfig();
  const ntfy = cfg.ntfy ?? {};
  if (!ntfy.topic) { res.status(400).json({ error: "Topic is required." }); return; }
  try {
    const base = (ntfy.serverUrl ?? "https://ntfy.sh").replace(/\/$/, "");
    const headers: Record<string, string> = {
      "Content-Type": "text/plain; charset=utf-8", "Title": encodeURIComponent("Claude Notify - test"), "Priority": "3", "Tags": "white_check_mark",
    };
    if (ntfy.token) headers["Authorization"] = `Bearer ${ntfy.token}`;
    const r = await fetch(`${base}/${encodeURIComponent(ntfy.topic)}`, { method: "POST", headers, body: Buffer.from("Test from Claude Notify - ntfy is working!", "utf8") });
    if (!r.ok) throw new Error(`ntfy ${r.status}: ${await r.text()}`);
    res.json({ ok: true, message: `ntfy notification sent to topic '${ntfy.topic}'` });
  } catch (err) { res.status(500).json({ error: String(err) }); }
});


app.post("/api/test/discord", async (_req, res) => {
  const cfg = loadConfig();
  const dc = cfg.discord ?? {};
  if (!dc.webhookUrl) { res.status(400).json({ error: "Webhook URL is required." }); return; }
  try {
    const r = await fetch(dc.webhookUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: dc.username ?? "Claude Notify", embeds: [{ title: "Claude Notify — test", description: "Test from Claude Notify — Discord is working!", color: 0x7c6dfa, timestamp: new Date().toISOString() }] }) });
    if (!r.ok) throw new Error(`Discord ${r.status}: ${await r.text()}`);
    res.json({ ok: true, message: "Discord message sent!" });
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

app.post("/api/test/slack", async (_req, res) => {
  const cfg = loadConfig();
  const sl = cfg.slack ?? {};
  if (!sl.webhookUrl) { res.status(400).json({ error: "Webhook URL is required." }); return; }
  try {
    const r = await fetch(sl.webhookUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "🔔 *Claude Notify — test*\nTest from Claude Notify — Slack is working!" }) });
    if (!r.ok) throw new Error(`Slack ${r.status}: ${await r.text()}`);
    res.json({ ok: true, message: "Slack message sent!" });
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

app.post("/api/test/teams", async (_req, res) => {
  const cfg = loadConfig();
  const tm = cfg.teams ?? {};
  if (!tm.webhookUrl) { res.status(400).json({ error: "Webhook URL is required." }); return; }
  try {
    const r = await fetch(tm.webhookUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "message", attachments: [{ contentType: "application/vnd.microsoft.card.adaptive", contentUrl: null, content: { $schema: "http://adaptivecards.io/schemas/adaptive-card.json", type: "AdaptiveCard", version: "1.2", body: [{ type: "TextBlock", size: "Medium", weight: "Bolder", text: "Claude Notify — test" }, { type: "TextBlock", text: "Test from Claude Notify — Teams is working!", wrap: true }] } }] }) });
    if (!r.ok) throw new Error(`Teams ${r.status}: ${await r.text()}`);
    res.json({ ok: true, message: "Teams message sent!" });
  } catch (err) { res.status(500).json({ error: String(err) }); }
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

// ── Log buffer + SSE broadcast ────────────────────────────────────────────────

const LOG_BUFFER_SIZE = 500;
const logBuffer: string[] = [];
const logClients = new Set<express.Response>();

function log(direction: "→" | "←" | "·", channel: string, text: string, client?: string) {
  const ts = new Date().toISOString();
  const clientPart = client ? ` [${client}]` : "";
  const entry = `[${ts}]${clientPart} ${direction} [${channel}] ${text}`;
  console.log(entry);
  logBuffer.push(entry);
  if (logBuffer.length > LOG_BUFFER_SIZE) logBuffer.shift();
  for (const res of logClients) {
    try { res.write(`data: ${JSON.stringify(entry)}\n\n`); } catch {}
  }
}

app.get("/api/sessions", (_req, res) => {
  const list = listActiveSessions().map(s => ({
    clientId: s.clientId,
    tag: s.tag,
    clientName: s.clientName,
    clientVersion: s.clientVersion,
    workspaceName: s.workspaceName,
    host: s.host,
    connectedAt: s.connectedAt,
    lastSeen: s.lastSeen,
  }));
  res.json({ sessions: list });
});

app.delete("/api/sessions/:clientId", (req, res) => {
  const { clientId } = req.params;
  const entry = Object.entries(sessions).find(([, m]) => m.clientId === clientId);
  if (!entry) { res.status(404).json({ error: "not found" }); return; }
  const [sessionId] = entry;
  try { httpTransports[sessionId]?.close(); } catch { /* ignore */ }
  delete httpTransports[sessionId];
  delete sessions[sessionId];
  res.json({ ok: true });
});

app.get("/api/logs", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  for (const entry of logBuffer) {
    res.write(`data: ${JSON.stringify(entry)}\n\n`);
  }
  logClients.add(res);
  req.on("close", () => logClients.delete(res));
});

// ── Notification sender ───────────────────────────────────────────────────────

async function sendNotification(message: string, priority: "low" | "normal" | "high", client?: string) {
  const cfg = loadConfig();
  const results: string[] = [];
  const errors: string[] = [];

  // DND check — priority=high always bypasses; anything else gets dropped during quiet hours.
  // Email still goes through on "low" anyway (historical behavior: low=email-only).
  if (priority !== "high" && isDndActive(cfg)) {
    log("·", "dnd", `suppressed ${priority} notif (DND active)`, client);
    return "DND active — notif suppressed (priority=high would still send)";
  }

  // Idle gating — when the user is actively at the keyboard, suppress *remote*
  // channels (Telegram/SMS/email) for non-high priority. By default we still
  // play the desktop sound+banner so the user knows *something* happened —
  // they may have multiple agents running and this is a cheap local signal
  // that doesn't blast their phone. Disable via idle.alwaysDesktopWhenActive=false.
  // priority=high always bypasses idle entirely.
  // Conversation bypass: if the user just messaged us from Telegram (within
  // the TTL), they clearly want a reply over that channel, so skip idle gating.
  const inTelegramConvo = Date.now() - lastTelegramInboundAt < TELEGRAM_CONVO_TTL_MS;
  let desktopOnlyMode = false;

  // If the web UI is open and the user is actively watching it, skip remote channels.
  if (priority !== "high" && isUiActivelyOpen()) {
    if (cfg.idle?.alwaysDesktopWhenActive !== false && cfg.desktop?.enabled) {
      desktopOnlyMode = true;
      log("·", "ui", `UI visible — desktop-only`, client);
    }
  }

  if (!desktopOnlyMode && priority !== "high" && !inTelegramConvo && cfg.idle?.enabled !== false) {
    const idleSecs = getOsIdleSeconds();
    const threshold = cfg.idle?.thresholdSeconds ?? 120;
    const userIsActive = idleSecs >= 0 && idleSecs < threshold;
    if (userIsActive) {
      if (cfg.idle?.alwaysDesktopWhenActive !== false && cfg.desktop?.enabled) {
        desktopOnlyMode = true;
        log("·", "idle", `user active (${idleSecs}s < ${threshold}s) — desktop-only`, client);
      } else {
        log("·", "idle", `user active (${idleSecs}s < ${threshold}s) — suppressed`, client);
        return "Idle gated — user is active, notif suppressed (priority=high would still send)";
      }
    }
  } else if (priority !== "high" && inTelegramConvo) {
    log("·", "idle", `bypassed (telegram convo active)`, client);
  }

  const send = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
      results.push(name);
      log("→", name, message, client);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${name}: ${msg}`);
      log("→", name, `ERROR: ${msg}`, client);
    }
  };

  if (priority !== "low") {
    if (cfg.desktop?.enabled) {
      const wantSound = cfg.desktop?.sound !== false;
      // On Windows, SnoreToast's per-app sound is often muted by the user's
      // Windows notification settings — fire a PowerShell beep alongside the
      // toast so the audible cue is reliable. macOS/Linux: trust the OS.
      if (wantSound && process.platform === "win32") {
        // [console]::beep uses the PC speaker (motherboard buzzer), which
        // modern laptops/desktops don't have — silent on most machines.
        // SystemSounds.Asterisk plays through the actual sound card via
        // the Windows notification sound, audible on every machine.
        spawn("powershell", [
          "-NoProfile", "-Command",
          "Add-Type -AssemblyName System.Windows.Forms; [System.Media.SystemSounds]::Asterisk.Play(); Start-Sleep -Milliseconds 600",
        ], { windowsHide: true, stdio: "ignore" });
      }
      const soundOpt = wantSound && process.platform !== "win32";
      if (cfg.desktop?.tts) {
        const voice = cfg.desktop?.ttsVoice ?? "en-US-AndrewMultilingualNeural";
        speakText(message, voice).catch((err) =>
          log("→", "tts", `ERROR: ${err instanceof Error ? err.message : String(err)}`, client));
      }
      await send("desktop", () => new Promise<void>((res, rej) =>
        notifier.notify({ title: "Claude Notify", message, sound: soundOpt },
          (err) => err ? rej(err) : res())));
    }
    if (!desktopOnlyMode && cfg.telegram?.enabled && cfg.telegram.token && cfg.telegram.chatId) {
      await send("telegram", async () => {
        const body: Record<string, any> = { chat_id: cfg.telegram.chatId, text: message };
        if (lastUserMessageId) body.reply_to_message_id = lastUserMessageId;
        const r = await fetch(`https://api.telegram.org/bot${cfg.telegram.token}/sendMessage`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
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
  if (!desktopOnlyMode && email.enabled && email.to) {
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

  // ntfy
  if (!desktopOnlyMode) {
    const ntfy = cfg.ntfy ?? {};
    if (ntfy.enabled && ntfy.topic) {
      await send("ntfy", async () => {
        const base = (ntfy.serverUrl ?? "https://ntfy.sh").replace(/\/$/, "");
        const priorityMap: Record<string, number> = { low: 2, normal: 3, high: 5 };
        const headers: Record<string, string> = {
          "Content-Type": "text/plain; charset=utf-8",
          "Title": encodeURIComponent("Claude Notify"),
          "Priority": String(priorityMap[priority] ?? 3),
          "Tags": priority === "high" ? "rotating_light" : "bell",
        };
        if (ntfy.token) headers["Authorization"] = `Bearer ${ntfy.token}`;
        const r = await fetch(`${base}/${encodeURIComponent(ntfy.topic)}`, {
          method: "POST", headers, body: Buffer.from(message, "utf8"),
        });
        if (!r.ok) throw new Error(`ntfy ${r.status}: ${await r.text()}`);
      });
    }
  }

  // Discord
  if (!desktopOnlyMode) {
    const dc = cfg.discord ?? {};
    if (dc.enabled && dc.webhookUrl) {
      await send("discord", async () => {
        const colorMap: Record<string, number> = { low: 0x6b7280, normal: 0x7c6dfa, high: 0xef4444 };
        const r = await fetch(dc.webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            username: dc.username ?? "Claude Notify",
            embeds: [{
              title: "Claude Notify",
              description: message,
              color: colorMap[priority] ?? colorMap.normal,
              timestamp: new Date().toISOString(),
            }],
          }),
        });
        if (!r.ok) throw new Error(`Discord ${r.status}: ${await r.text()}`);
      });
    }
  }

  // Slack
  if (!desktopOnlyMode) {
    const sl = cfg.slack ?? {};
    if (sl.enabled && sl.webhookUrl) {
      await send("slack", async () => {
        const emojiMap: Record<string, string> = { low: "ℹ️", normal: "🔔", high: "🚨" };
        const emoji = emojiMap[priority] ?? emojiMap.normal;
        const r = await fetch(sl.webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: `${emoji} *Claude Notify*`,
            blocks: [
              { type: "section", text: { type: "mrkdwn", text: `${emoji} *Claude Notify*\n${message}` } },
              { type: "context", elements: [{ type: "mrkdwn", text: `Priority: ${priority}` }] },
            ],
          }),
        });
        if (!r.ok) throw new Error(`Slack ${r.status}: ${await r.text()}`);
      });
    }
  }

  // Teams
  if (!desktopOnlyMode) {
    const tm = cfg.teams ?? {};
    if (tm.enabled && tm.webhookUrl) {
      await send("teams", async () => {
        const colorMap: Record<string, string> = { low: "Default", normal: "Accent", high: "Attention" };
        const r = await fetch(tm.webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "message",
            attachments: [{
              contentType: "application/vnd.microsoft.card.adaptive",
              contentUrl: null,
              content: {
                $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
                type: "AdaptiveCard", version: "1.2",
                body: [
                  { type: "TextBlock", size: "Medium", weight: "Bolder", text: "Claude Notify", color: colorMap[priority] ?? "Default" },
                  { type: "TextBlock", text: message, wrap: true },
                  { type: "TextBlock", text: `Priority: ${priority}`, isSubtle: true, size: "Small" },
                ],
              },
            }],
          }),
        });
        if (!r.ok) throw new Error(`Teams ${r.status}: ${await r.text()}`);
      });
    }
  }

  return [
    results.length ? `Sent via: ${results.join(", ")}` : null,
    errors.length ? `Errors: ${errors.join("; ")}` : null,
  ].filter(Boolean).join(" | ") || "No channels delivered";
}

// ── OS idle-time (cross-platform) ─────────────────────────────────────────────
// Returns seconds since last keyboard/mouse input. -1 on error/unsupported.
// Clients call the `get_idle_seconds` tool and decide whether to fire a notif.

const IDLE_SCRIPT_PS1 = join(fileURLToPath(new URL("../../scripts/idle-check.ps1", import.meta.url)));

function getOsIdleSeconds(): number {
  try {
    if (process.platform === "win32") {
      // PowerShell + Win32 GetLastInputInfo via bundled script
      const r = spawnSync("powershell", ["-NoProfile", "-File", IDLE_SCRIPT_PS1], {
        encoding: "utf-8", windowsHide: true,
      });
      if (r.status === 0) {
        const n = parseInt((r.stdout || "").trim(), 10);
        return Number.isFinite(n) ? n : -1;
      }
      return -1;
    }
    if (process.platform === "darwin") {
      // macOS: ioreg exposes HIDIdleTime in nanoseconds
      const r = spawnSync("sh", ["-c",
        "ioreg -c IOHIDSystem | awk '/HIDIdleTime/ {print int($NF/1000000000); exit}'"],
        { encoding: "utf-8" });
      if (r.status === 0) {
        const n = parseInt((r.stdout || "").trim(), 10);
        return Number.isFinite(n) ? n : -1;
      }
      return -1;
    }
    // Linux: xprintidle (if installed) returns ms
    const r = spawnSync("xprintidle", [], { encoding: "utf-8" });
    if (r.status === 0) {
      const ms = parseInt((r.stdout || "").trim(), 10);
      return Number.isFinite(ms) ? Math.floor(ms / 1000) : -1;
    }
    return -1;
  } catch {
    return -1;
  }
}

function getLocalIp() {
  for (const nets of Object.values(networkInterfaces())) {
    for (const net of nets ?? []) {
      if (net.family === "IPv4" && !net.internal) return net.address;
    }
  }
  return "localhost";
}

// ── Ask / reply + inbox system ────────────────────────────────────────────────

interface InboxEntry { text: string; ts: string; messageId?: number; tag?: string }

const pendingAsks = new Map<string, { resolve: (v: string) => void; timer: NodeJS.Timeout; tag?: string }>();
const inboxQueue: InboxEntry[] = [];

// Long-poll waiters for `wait_for_inbox`. Keyed by token; filtered by tag the
// same way as `drainInboxFor`. When a new inbox entry arrives, resolve all
// matching waiters immediately with that entry — they get the message as a
// tool *result*, which every MCP client surfaces reliably (unlike server
// notifications, which Claude Code and others frequently drop).
interface InboxWaiter {
  resolve: (entries: InboxEntry[]) => void;
  timer: NodeJS.Timeout;
  tag?: string;
}
const inboxWaiters = new Map<string, InboxWaiter>();

// Match waiters the same way `matchesSession` matches SSE subscribers:
// - untagged entry → every waiter is a match (broadcast)
// - tagged entry   → only waiters with the same tag match
function takeWaitersFor(entryTag: string | undefined): InboxWaiter[] {
  const taken: InboxWaiter[] = [];
  for (const [id, w] of inboxWaiters) {
    const match = entryTag === undefined ? true : w.tag === entryTag;
    if (match) {
      inboxWaiters.delete(id);
      taken.push(w);
    }
  }
  return taken;
}
let tgPollOffset = -1;
let lastUserMessageId: number | undefined;
// When the user pings us from Telegram, bypass idle-gating on outbound
// notifs for a while — clearly they want a Telegram reply back, so we
// shouldn't gate remote channels just because they're at the keyboard
// typing. TTL is short so normal idle-gating resumes once the conversation
// goes quiet.
let lastTelegramInboundAt = 0;
const TELEGRAM_CONVO_TTL_MS = 5 * 60 * 1000;

// Page visibility: the web UI reports when it becomes visible/hidden so the
// server can skip external channels while the user is actively watching the UI.
let uiVisibleAt = 0;   // last time UI reported visible
let uiHiddenAt  = 0;   // last time UI reported hidden (0 = never seen)
const UI_VISIBLE_TTL_MS = 30_000; // if no heartbeat for 30s, treat as unknown

app.post("/api/ui/visibility", (req, res) => {
  const { visible } = req.body ?? {};
  if (visible) { uiVisibleAt = Date.now(); }
  else         { uiHiddenAt  = Date.now(); }
  res.json({ ok: true });
});

function isUiActivelyOpen(): boolean {
  if (uiVisibleAt === 0) return false;  // never reported
  if (uiHiddenAt > uiVisibleAt) return false;  // last report was hidden
  return Date.now() - uiVisibleAt < UI_VISIBLE_TTL_MS;
}

// Session tagging: a session may declare a tag (e.g. "alphawave") when it
// connects to /mcp?tag=alphawave. Telegram messages starting with "@<tag>"
// are routed only to sessions with that exact tag (tag prefix stripped).
// Untagged messages broadcast to every session — backward compatible.
const TAG_RE = /^@([A-Za-z0-9_-]+)\s+/;

function parseTag(text: string): { tag?: string; text: string } {
  const m = text.match(TAG_RE);
  if (!m) return { text };
  return { tag: m[1].toLowerCase(), text: text.slice(m[0].length) };
}

function matchesSession(entry: InboxEntry, sessionTag: string | undefined): boolean {
  if (!entry.tag) return true;            // untagged → everyone
  return entry.tag === sessionTag;        // tagged   → only matching session
}

// ── /btw file-drop bridge ─────────────────────────────────────────────────────
// Claude Code has no API for injecting a prompt into a running session while a
// tool call is executing (anthropics/claude-code#27441, still open). The only
// in-band channel is the `FileChanged` hook: when a watched file changes on
// disk, Claude Code's hook script stdout is injected as additional context on
// the next turn — without the agent having to poll.
//
// We drop every unsolicited user message into ~/.notify-mcp/inbox/<ts>.md, and
// ship a one-liner hook in the README that globs that directory. This is the
// closest thing to a "/btw" we can get until the client exposes a real inject
// endpoint.
const INBOX_DROP_DIR = join(CONFIG_DIR, "inbox");
const INBOX_DROP_TTL_MS = 24 * 60 * 60 * 1000; // 24h — hook should have consumed within seconds

function writeInboxDrop(entry: InboxEntry): void {
  try {
    if (!existsSync(INBOX_DROP_DIR)) mkdirSync(INBOX_DROP_DIR, { recursive: true });
    const safeTs = entry.ts.replace(/[:.]/g, "-");
    const tagPart = entry.tag ? `.${entry.tag}` : "";
    const path = join(INBOX_DROP_DIR, `${safeTs}${tagPart}.md`);
    const header = `# Unsolicited user message\n\n` +
      `- Time: ${entry.ts}\n` +
      (entry.tag ? `- Tag: @${entry.tag}\n` : "") +
      `- Origin: user (out-of-band)\n\n`;
    writeFileSync(path, header + entry.text + "\n");
  } catch (err) {
    log("·", "inbox-drop", `write failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// Reap old drops so the directory doesn't grow forever. Hooks consume within
// seconds, so anything older than a day is a message the agent never saw —
// keep it for forensics but eventually clean up.
setInterval(() => {
  try {
    if (!existsSync(INBOX_DROP_DIR)) return;
    const now = Date.now();
    const files = readdirSync(INBOX_DROP_DIR);
    for (const f of files) {
      const p = join(INBOX_DROP_DIR, f);
      try {
        const st = statSync(p);
        if (now - st.mtimeMs > INBOX_DROP_TTL_MS) unlinkSync(p);
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}, 60 * 60 * 1000);

// SSE stream of new inbox messages (server-push). Each connection may filter
// by tag: /api/inbox/stream?tag=alphawave. Filtering rule mirrors poll/notify:
// untagged messages always delivered; tagged messages only when tags match.
interface SseClient { res: express.Response; tag?: string }
const inboxStreamClients = new Set<SseClient>();

function broadcastInbox(entry: InboxEntry): number {
  const payload = JSON.stringify(entry);
  let delivered = 0;
  for (const c of inboxStreamClients) {
    // Proactively drop subscribers whose socket is gone. Node's req.on("close")
    // isn't reliable on every disconnect path (e.g. VS Code window killed hard,
    // laptop lid shut), so check writability before every write.
    if (c.res.destroyed || c.res.writableEnded || !c.res.writable) {
      inboxStreamClients.delete(c);
      continue;
    }
    if (!matchesSession(entry, c.tag)) continue;
    try {
      c.res.write(`data: ${payload}\n\n`);
      delivered++;
    } catch {
      inboxStreamClients.delete(c);
    }
  }
  return delivered;
}

// Test-only: inject a fake inbox entry exactly as the Telegram listener would.
// Gated behind NOTIFY_MCP_TEST_ENDPOINTS=1 so it's never exposed in a normal
// production run. Used by the test suite to drive wait_for_inbox wake-up and
// SSE broadcast paths without needing a real Telegram bot.
if (process.env.NOTIFY_MCP_TEST_ENDPOINTS === "1") {
  app.post("/__test__/inject-inbox", express.json(), (req, res) => {
    const text = String(req.body?.text ?? "");
    const tag = req.body?.tag ? String(req.body.tag).toLowerCase() : undefined;
    if (!text) { res.status(400).json({ error: "text required" }); return; }
    const entry: InboxEntry = { text, ts: new Date().toISOString(), tag };
    const waiters = takeWaitersFor(tag);
    if (waiters.length > 0) {
      for (const w of waiters) {
        clearTimeout(w.timer);
        w.resolve([entry]);
      }
    } else {
      inboxQueue.push(entry);
    }
    const sse = broadcastInbox(entry);
    writeInboxDrop(entry);
    log("·", "test-inject", `${text} (waiters=${waiters.length}, sse=${sse})`, tag);
    res.json({ injected: true, waiters: waiters.length, sse });
  });
  log("·", "test", "NOTIFY_MCP_TEST_ENDPOINTS=1 — /__test__/inject-inbox enabled");
}

app.get("/api/inbox/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  const tag = typeof req.query.tag === "string" ? req.query.tag.toLowerCase() : undefined;
  // Initial comment so the client knows the stream is alive.
  res.write(`: connected ${new Date().toISOString()}${tag ? ` tag=${tag}` : ""}\n\n`);
  const client: SseClient = { res, tag };
  inboxStreamClients.add(client);
  // Keep-alive ping every 20s so intermediate proxies / curl don't time out
  // and so the client sees the connection is still live.
  const keepAlive = setInterval(() => {
    try { res.write(`: ping ${Date.now()}\n\n`); } catch {}
  }, 20_000);
  req.on("close", () => {
    clearInterval(keepAlive);
    inboxStreamClients.delete(client);
  });
});

async function initTgOffset(token: string): Promise<number> {
  const r = await fetch(`https://api.telegram.org/bot${token}/getUpdates?offset=-1&timeout=0`);
  const json = await r.json() as any;
  const results: any[] = json.result ?? [];
  return results.length > 0 ? results[results.length - 1].update_id + 1 : 0;
}

// Backoff + dedupe state for the long-poll loop. A flaky network or revoked
// token used to spam the activity log with one line every 2s; instead we now
// back off exponentially and collapse repeated identical errors into a count.
let tgConsecutiveErrors = 0;
let tgLastErrorMsg: string | null = null;
let tgLastErrorCount = 0;
let tgLastErrorLoggedAt = 0;

function logTelegramError(msg: string) {
  const now = Date.now();
  if (msg === tgLastErrorMsg) {
    tgLastErrorCount++;
    // Re-emit a rollup line at most once every 30s while errors keep repeating.
    if (now - tgLastErrorLoggedAt > 30_000) {
      log("·", "telegram:error", `${msg} (×${tgLastErrorCount} since last log)`);
      tgLastErrorLoggedAt = now;
      tgLastErrorCount = 0;
    }
  } else {
    log("·", "telegram:error", msg);
    tgLastErrorMsg = msg;
    tgLastErrorCount = 0;
    tgLastErrorLoggedAt = now;
  }
}

async function startTelegramListener() {
  while (true) {
    try {
      const cfg = loadConfig();
      const { token, chatId } = cfg.telegram ?? {};
      if (!token || !chatId) {
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }
      if (tgPollOffset < 0) {
        tgPollOffset = await initTgOffset(token);
        log("·", "telegram", `listener ready, offset=${tgPollOffset}`);
      }
      const r = await fetch(
        `https://api.telegram.org/bot${token}/getUpdates?offset=${tgPollOffset}&timeout=10`,
        { signal: AbortSignal.timeout(15_000) }
      );
      // Reset error state on any successful fetch.
      if (tgConsecutiveErrors > 0) {
        log("·", "telegram", `recovered after ${tgConsecutiveErrors} failed attempt(s)`);
        tgConsecutiveErrors = 0;
        tgLastErrorMsg = null;
        tgLastErrorCount = 0;
      }
      const json = await r.json() as any;
      for (const update of json.result ?? []) {
        tgPollOffset = update.update_id + 1;
        const msg = update.message;
        if (msg?.chat?.id?.toString() === chatId && msg.text) {
          log("←", "telegram", msg.text);
          lastUserMessageId = msg.message_id;
          lastTelegramInboundAt = Date.now();
          const { tag, text } = parseTag(msg.text);
          // Match an outstanding ask first. If the message is tagged, only
          // route to a pending ask from that same session — otherwise fall
          // through to the inbox so the targeted session can pick it up.
          const candidate = [...pendingAsks.entries()].find(([, p]) =>
            tag ? p.tag === tag : true
          );
          if (candidate) {
            const [id, pending] = candidate;
            clearTimeout(pending.timer);
            pendingAsks.delete(id);
            log("←", "ask:reply", text, tag);
            pending.resolve(text);
          } else {
            const entry: InboxEntry = {
              text, ts: new Date().toISOString(), messageId: msg.message_id, tag,
            };
            // Waiters (wait_for_inbox long-poll) get first crack — they were
            // already parked by an agent explicitly asking "wake me up when
            // something arrives." Hand the entry off as a tool *result*, which
            // every MCP client actually surfaces. Only queue if no one was
            // waiting, so the message isn't delivered twice.
            const waiters = takeWaitersFor(tag);
            if (waiters.length > 0) {
              for (const w of waiters) {
                clearTimeout(w.timer);
                w.resolve([entry]);
              }
              log("·", "inbox", `${text} → ${waiters.length} long-poll waiter(s)`, tag);
            } else {
              inboxQueue.push(entry);
            }
            writeInboxDrop(entry);
            const liveSseCount = broadcastInbox(entry);
            log("·", "inbox", `${text} (sse=${liveSseCount}, waiters=${waiters.length})`, tag);
            // Before building the ack, prune sessions whose transport stream
            // is dead or whose heartbeat has lapsed. Without this the ack
            // cheerfully claims "broadcast to 3 sessions" when 2 of them are
            // closed VS Code windows — which is exactly what prompted this fix.
            pruneDeadSessions();
            // Build an ack that names the active sessions the user's message
            // is being routed to. If the user tagged it and no session with
            // that tag is connected, tell them plainly so they don't sit
            // waiting for a reply that can't come.
            const targets = sessionsMatchingTag(tag);
            let ackText: string;
            if (tag && targets.length === 0) {
              ackText = `📭 No session @${tag} connected. Message queued — next @${tag} to connect will pick it up.`;
            } else if (targets.length === 0) {
              ackText = `📭 No agents connected. Message queued — next agent to connect will pick it up.`;
            } else {
              const names = targets.map(sessionDisplay).join(", ");
              ackText = tag
                ? `📬 Routed to ${names}. Waiting for them to reply.`
                : `📬 Broadcast to ${targets.length} session(s): ${names}. Each should reply with its identity — respond to the one you want.`;
            }
            fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                chat_id: chatId,
                text: ackText,
                reply_to_message_id: msg.message_id,
              }),
            }).catch(() => {});
          }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("terminated") && !msg.includes("aborted")) {
        logTelegramError(msg);
      }
      tgConsecutiveErrors++;
      // Exponential backoff: 2s → 5s → 10s → 20s → 40s → cap at 60s.
      const delay = Math.min(60_000, 2000 * Math.pow(2, Math.min(5, tgConsecutiveErrors - 1)));
      await new Promise(r => setTimeout(r, delay));
    }
  }
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
  log("←", "web-reply", req.body.response as string);
  pending.resolve(req.body.response as string);
  res.json({ ok: true });
});

// ── MCP server ────────────────────────────────────────────────────────────────

function drainInboxFor(tag: string | undefined): InboxEntry[] {
  const taken: InboxEntry[] = [];
  for (let i = inboxQueue.length - 1; i >= 0; i--) {
    if (matchesSession(inboxQueue[i], tag)) {
      taken.unshift(inboxQueue[i]);
      inboxQueue.splice(i, 1);
    }
  }
  return taken;
}

// Appends an inbox block to any tool's text payload when messages are pending
// for the given session. Lets cheap read tools (get_idle_seconds, get_dnd_status)
// double as inbox drains, so a busy agent calling them as a keepalive still
// sees user messages even when it hasn't called notify/poll in a while.
function appendInbox(baseText: string, sessionTag: string | undefined, clientId: string | undefined): string {
  const messages = drainInboxFor(sessionTag);
  if (messages.length === 0) return baseText;
  log("·", "poll", `${messages.length} message(s) drained via heartbeat`, clientId);
  const inbox = messages.map(m => `[${m.ts}] ${m.text}`).join("\n");
  return `${baseText}\n\n⚠️ USER SENT YOU A MESSAGE — STOP AND RESPOND BEFORE CONTINUING:\n${inbox}`;
}

const MCP_INSTRUCTIONS = `
This server delivers notifications to the user through whatever channels the
user has configured on the server side. The client never needs to know which
channels are in use — just call 'notify' or 'ask' with a generic message.

BEHAVIORAL RULES for every client that connects:

1. ALWAYS call 'notify' in these three situations — idle or not, DND or not,
   the server decides routing, you decide whether to fire:

   (a) LONG PROCESSING FINISHED. Any single task that took more than ~60
       seconds of wall-clock time (long build, test run, backtest, migration,
       big refactor, multi-step plan) gets a 'notify' the moment it completes
       — success OR failure. Rule of thumb: if the user could have reasonably
       walked away to grab coffee while you ran, they need a ping on the way
       back. Don't try to guess whether they were watching. Just notify.

   (b) YOU HAVE A QUESTION OR NEED A DECISION. Any time you're about to ask
       the user something — "should I delete these?", "which branch?",
       "proceed with plan B?" — fire 'notify' (or 'ask' for blocking
       two-way). Silent questions in the terminal get missed; a notification
       does not.

   (c) SOMETHING IMPORTANT HAPPENED that the user needs to know about right
       now. Examples: a test suddenly failed after being green, a destructive
       operation is about to run, you found a security issue, a deploy
       succeeded, a production service looks degraded, you hit an
       unrecoverable error. When in doubt on importance, ERR ON THE SIDE OF
       NOTIFYING — the server's idle gating will automatically downgrade a
       mis-judged 'normal' to a silent desktop banner if the user is active,
       so the cost of over-notifying is near zero. The cost of missing a
       real event is that the user finds out 4 hours later.

   The SERVER handles all routing (DND, idle threshold, channel selection,
   priority escalation). You do NOT need to pre-flight with
   'get_idle_seconds' before these three triggers — fire 'notify' and let
   the server decide. get_idle_seconds is the HEARTBEAT primitive (rule 6),
   not a gate on legitimate milestones.

2. Use priority correctly:
   - 'low'    = email only — for low-stakes status (background completion).
   - 'normal' = desktop + Telegram + email — the default.
   - 'high'   = all channels including SMS — bypasses DND AND idle gating.
                Use ONLY for catastrophic findings or decisions that block
                progress. Misuse will train the user to ignore your notifs.

3. Echo the COMPLETE, UNTRUNCATED message body in your own chat / conversation
   output as well as sending it through 'notify'. The user may be reading the
   terminal directly; don't rely on them checking their phone / email. Do NOT
   shorten, summarise, or cut off the message with "…" in your chat output —
   show every word exactly as sent.

4. The message body should be channel-agnostic. Never name 'Telegram', 'SMS',
   'email', 'desktop', etc. in your messages or in your chat output — those are
   server delivery details the user has already configured and the client has
   no business surfacing. Do NOT echo "Sent via: <channel list>" or any
   variant of it. Just say 'notif' or 'notification' if you need to refer to
   the act of notifying.

5. When the user sends you an unsolicited message (visible as INBOX items in
   the 'notify' response, via 'poll', via 'wait_for_inbox', via
   'get_idle_seconds' piggy-back, or via the /api/inbox/stream SSE), reply to
   them THROUGH 'notify' so the reply
   actually reaches them — not just in your chat output. Multiple agents may
   be connected simultaneously — the server broadcasts every untagged inbox
   message to all of them, so the user can see who is listening. Your reply
   MUST identify which session you are (start with your own tag or client id,
   e.g. "[@alphawave]" or "[sess-abcd]") and give a brief status so the user
   can pick whom to respond to. If the user tagged their message (@<tag>),
   only the session with that tag should reply. If you are untagged and
   another session with the same project/workdir is already tagged, let the
   tagged one reply.

5a. BUSY-ACK RULE (hard requirement): The moment you notice a user inbox
    message — whether via notify response, heartbeat piggy-back, or poll —
    REPLY IMMEDIATELY via 'notify' with a terse status, EVEN IF YOU CAN'T
    ACT ON THE REQUEST YET. Do not finish the current tool/task first.
    Drop what you're doing long enough to fire one 'notify' call, THEN
    resume. Format: "[<your-session-id>] busy on <current-task>; will
    respond at <milestone>". The user needs to know (a) you heard them,
    (b) you're not the stuck one, (c) when to expect a real answer. An
    inbox message that gets a delayed reply is worse than no reply — it
    wastes the user's time waiting on silence.

6. The 'get_idle_seconds', 'get_idle_config', and 'get_dnd_status' tools are
   informational reads, but they ALSO drain pending inbox messages. Use them
   as a cheap heartbeat during long work: call 'get_idle_seconds' EVERY 15-
   30 SECONDS while a long task runs (loop iteration, backtest, scan, build,
   etc.). If the user sent you a message while you were busy, it comes back
   piggy-backed on the response — you don't need to separately call 'poll'.
   This is a lightweight local read (no network, no DND or channel routing),
   so the cost is near zero. Without this heartbeat pattern, a busy agent is
   deaf to the user until its next 'notify' call — which may be minutes or
   hours away during long work. Treat 'get_idle_seconds' as the "check for
   user input" primitive, not an idle-gate check.

   If your work is naturally idle (waiting for the user, between loop iters),
   prefer 'wait_for_inbox' instead — it blocks up to 50s and returns the
   moment the user types anything, as a tool result. That's the most reliable
   delivery path across every MCP client (notifications over SSE are silently
   dropped by Claude Code, Cursor, and others). Loop pattern:
     while (true) {
       const r = await wait_for_inbox({ timeout_seconds: 50 });
       if (r !== "inbox:empty") handle(r);
     }

7. If your tool call fails with "MCP server not connected" / "transport
   closed" / similar — the SERVER IS ALMOST CERTAINLY FINE. Other clients are
   connected to the same server right now. Only YOUR client's transport
   broke (commonly: stdio child process died, or HTTP client gave up after a
   transient slow response at startup). DO NOT tell the user "notify is down"
   without first probing the server directly.

   Probe before declaring the server dead:
     curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3737/mcp
   - 406 (Not Acceptable) = server is healthy, doing MCP protocol
     negotiation. Your client is the broken party. Use the bypass below.
   - Connection refused / timeout = server is genuinely down. Tell the user.

   HTTP-transport bypass when your MCP client is broken (works from any
   shell that has curl). Three calls, stateful — the session id from step 1
   must be passed in mcp-session-id on every subsequent call:

     # 1) initialize and capture session id from response headers
     SID=$(curl -s -i -X POST http://localhost:3737/mcp \
       -H "Content-Type: application/json" \
       -H "Accept: application/json, text/event-stream" \
       -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"curl-bridge","version":"1.0"}}}' \
       | grep -i "^mcp-session-id:" | awk '{print $2}' | tr -d '\r')

     # 2) ack initialized (no response body, fire-and-forget)
     curl -s -X POST http://localhost:3737/mcp \
       -H "Content-Type: application/json" \
       -H "Accept: application/json, text/event-stream" \
       -H "mcp-session-id: $SID" \
       -d '{"jsonrpc":"2.0","method":"notifications/initialized"}' >/dev/null

     # 3) call any tool — successful response includes "Sent via: <channel>"
     curl -s -X POST http://localhost:3737/mcp \
       -H "Content-Type: application/json" \
       -H "Accept: application/json, text/event-stream" \
       -H "mcp-session-id: $SID" \
       -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"notify","arguments":{"message":"YOUR MESSAGE","priority":"normal"}}}'

   Same pattern works for 'ask', 'poll', 'get_idle_seconds', etc. — change
   the "name" and "arguments" in step 3. Reuse the same $SID for all calls
   in one bypass session.

   Bottom line: rule #1 still applies. If you owe the user a notify and your
   MCP client is broken, you owe them the bypass — not an excuse.
`.trim();

function createMcpServer(clientId: string, sessionTag?: string) {
  const identity = sessionTag ? `@${sessionTag}` : clientId;
  const identityLine = `\nYOUR SESSION IDENTITY: "${identity}" — use this as your prefix in all notify replies (e.g. "[${identity}] done with build").\n`;
  const server = new McpServer(
    { name: "notify-mcp", version: "1.0.0" },
    { instructions: identityLine + MCP_INSTRUCTIONS }
  );

  server.tool(
    "notify",
    "Send a notification to the user. Delivery channels and DND are server-configured. " +
      "Before calling, check get_idle_seconds against get_idle_config.thresholdSeconds; " +
      "skip the call if the user is active (unless priority='high'). " +
      "Use for: task milestones, questions needing input, catastrophic findings, long task completion.",
    {
      message: z.string().max(500).describe("Notification message, max 500 chars"),
      priority: z.enum(["low", "normal", "high"]).default("normal")
        .describe("low=email only; normal=desktop+telegram+email; high=all channels"),
    },
    async ({ message, priority }: { message: string; priority: "low" | "normal" | "high" }) => {
      const outbound = sessionTag ? `[${sessionTag}] ${message}` : message;
      const summary = await sendNotification(outbound, priority, clientId);
      const messages = drainInboxFor(sessionTag);
      if (messages.length === 0) {
        return { content: [{ type: "text" as const, text: summary }] };
      }
      log("·", "poll", `${messages.length} message(s) drained via notify`, clientId);
      const inbox = messages.map(m => `[${m.ts}] ${m.text}`).join("\n");
      return { content: [{ type: "text" as const, text: `${summary}\n\n⚠️ USER SENT YOU A MESSAGE — STOP AND RESPOND BEFORE CONTINUING:\n${inbox}` }] };
    }
  );

  server.tool(
    "ask",
    "Send a question to the user and wait for their reply. Channels are server-configured. " +
      "Use when a decision is needed before continuing — e.g. 'Should I delete these files?'",
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

      log("→", "ask:telegram", question, clientId);
      if (cfg.telegram?.enabled && cfg.telegram.token && cfg.telegram.chatId) {
        const askPrefix = sessionTag ? `❓ [${sessionTag}]` : `❓ [${clientId}]`;
        const replyHint = sessionTag
          ? `\n\nReply with: @${sessionTag} <your answer>`
          : `\n\nReply to this message with your answer.`;
        await fetch(`https://api.telegram.org/bot${cfg.telegram.token}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: cfg.telegram.chatId,
            text: `${askPrefix} ${question}${replyHint}`,
          }),
        }).catch((err) => log("→", "ask:telegram", `ERROR: ${err}`, clientId));
      }

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
            log("→", "ask:email", `question sent to ${email.to}, reply URL: ${replyUrl}`, clientId);
          }
        } catch (err) {
          log("→", "ask:email", `ERROR: ${err instanceof Error ? err.message : String(err)}`, clientId);
        }
      }

      log("→", "ask", `waiting for reply (timeout: ${timeout_seconds}s)`, clientId);
      const reply = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingAsks.delete(token);
          reject(new Error(`No reply received within ${timeout_seconds}s`));
        }, timeout_seconds * 1000);
        pendingAsks.set(token, { resolve, timer, tag: sessionTag });
      });

      log("←", "ask:reply", reply, clientId);
      return { content: [{ type: "text" as const, text: reply }] };
    }
  );

  server.tool(
    "poll",
    "Check for unsolicited messages the user has sent. " +
      "Returns queued messages and clears the queue. Returns 'inbox:empty' if nothing pending. " +
      "Prefer subscribing to the /api/inbox/stream SSE endpoint for real-time delivery.",
    {},
    async () => {
      const messages = drainInboxFor(sessionTag);
      if (messages.length === 0) {
        return { content: [{ type: "text" as const, text: "inbox:empty" }] };
      }
      log("·", "poll", `${messages.length} message(s) drained`, clientId);
      return {
        content: [{
          type: "text" as const,
          text: `⚠️ USER SENT YOU A MESSAGE — STOP AND RESPOND BEFORE CONTINUING:\n` + messages.map(m => `[${m.ts}] ${m.text}`).join("\n"),
        }],
      };
    }
  );

  server.tool(
    "wait_for_inbox",
    "Block until the user sends an unsolicited message, or until the timeout " +
      "expires. Returns the message(s) as tool results (the reliable MCP delivery " +
      "path — notifications over SSE are dropped by many clients). Default timeout " +
      "is 50s to stay under the JS SDK's 60s request timeout; keep the agent-side " +
      "loop re-calling on empty so a quiet user doesn't leak an abandoned waiter. " +
      "If messages are already queued for this session, returns them immediately.",
    {
      timeout_seconds: z.number().min(5).max(55).default(50)
        .describe("How long to block before returning empty (5-55s)"),
    },
    async ({ timeout_seconds = 50 }: { timeout_seconds?: number }) => {
      // Fast-path: if there are already messages queued for this session tag,
      // drain and return them without parking a waiter.
      const queued = drainInboxFor(sessionTag);
      if (queued.length > 0) {
        const body = queued.map(m => `[${m.ts}] ${m.text}`).join("\n");
        return { content: [{ type: "text" as const, text: `⚠️ USER SENT YOU A MESSAGE — STOP AND RESPOND BEFORE CONTINUING:\n${body}` }] };
      }
      const token = randomUUID();
      const entries = await new Promise<InboxEntry[]>((resolve) => {
        const timer = setTimeout(() => {
          inboxWaiters.delete(token);
          resolve([]);
        }, timeout_seconds * 1000);
        inboxWaiters.set(token, { resolve, timer, tag: sessionTag });
      });
      if (entries.length === 0) {
        return { content: [{ type: "text" as const, text: "inbox:empty" }] };
      }
      log("·", "wait_for_inbox", `${entries.length} message(s) delivered`, clientId);
      const body = entries.map(m => `[${m.ts}] ${m.text}`).join("\n");
      return { content: [{ type: "text" as const, text: `⚠️ USER SENT YOU A MESSAGE — STOP AND RESPOND BEFORE CONTINUING:\n${body}` }] };
    }
  );

  server.tool(
    "get_idle_seconds",
    "Returns the number of seconds since the user's last keyboard/mouse input. " +
      "Call this periodically during long work as a cheap heartbeat — the server " +
      "will piggy-back any pending inbox messages in the response, so you stay " +
      "responsive to the user without having to call poll. Returns -1 if idle " +
      "detection is unsupported on this platform — in that case, proceed without " +
      "gating (fail-open).",
    {},
    async () => {
      const secs = getOsIdleSeconds();
      return { content: [{ type: "text" as const, text: appendInbox(String(secs), sessionTag, clientId) }] };
    }
  );

  server.tool(
    "get_idle_config",
    "Returns the server's idle gating policy: { enabled, thresholdSeconds, alwaysDesktopWhenActive }. " +
      "Informational only — the server gates internally on every notify call. " +
      "Also drains pending inbox messages — safe to use as a heartbeat.",
    {},
    async () => {
      const cfg = loadConfig();
      const idle = cfg.idle ?? { enabled: true, thresholdSeconds: 120, alwaysDesktopWhenActive: true };
      return { content: [{ type: "text" as const, text: appendInbox(JSON.stringify(idle), sessionTag, clientId) }] };
    }
  );

  server.tool(
    "get_dnd_status",
    "Returns the current DND state: " +
      "{ active: boolean, reason: 'manual' | 'schedule' | 'off' }. " +
      "When active, the server will suppress delivery for priority < high. " +
      "Also drains pending inbox messages — safe to use as a heartbeat.",
    {},
    async () => {
      const cfg = loadConfig();
      const active = isDndActive(cfg);
      let reason = "off";
      if (active) {
        reason = cfg.dnd?.enabled ? "manual" : "schedule";
      }
      return {
        content: [{ type: "text" as const, text: appendInbox(JSON.stringify({ active, reason }), sessionTag, clientId) }],
      };
    }
  );

  server.tool(
    "update_instructions",
    "Persist a block of behavioral instructions for this client into its CLAUDE.md " +
      "(or equivalent config file) so they survive session restarts and context compaction. " +
      "Call this whenever the user asks you to remember a rule, change a behavior, or update " +
      "how you should act — the instructions will be reloaded on every future session. " +
      "Pass the full desired instructions block; it replaces the previous block atomically.",
    {
      instructions: z.string().max(4000).describe("The full instructions block to persist"),
      target: z.enum(["global", "project"]).default("global").describe(
        "global = ~/.claude/CLAUDE.md (all projects); project = .claude/CLAUDE.md in cwd"
      ),
    },
    async ({ instructions, target }) => {
      try {
        const MARKER_START = "<!-- omni-notify-mcp:instructions:start -->";
        const MARKER_END   = "<!-- omni-notify-mcp:instructions:end -->";
        const block = `${MARKER_START}\n## omni-notify-mcp behavioral rules\n\n${instructions.trim()}\n${MARKER_END}`;

        let claudeMdPath: string;
        if (target === "global") {
          const claudeDir = join(homedir(), ".claude");
          if (!existsSync(claudeDir)) mkdirSync(claudeDir, { recursive: true });
          claudeMdPath = join(claudeDir, "CLAUDE.md");
        } else {
          const projectClaudeDir = join(process.cwd(), ".claude");
          if (!existsSync(projectClaudeDir)) mkdirSync(projectClaudeDir, { recursive: true });
          claudeMdPath = join(projectClaudeDir, "CLAUDE.md");
        }

        let existing = "";
        if (existsSync(claudeMdPath)) {
          existing = readFileSync(claudeMdPath, "utf8");
        }

        let updated: string;
        if (existing.includes(MARKER_START)) {
          // Replace existing block
          const startIdx = existing.indexOf(MARKER_START);
          const endIdx   = existing.indexOf(MARKER_END);
          if (endIdx !== -1) {
            updated = existing.slice(0, startIdx) + block + existing.slice(endIdx + MARKER_END.length);
          } else {
            updated = existing.slice(0, startIdx) + block;
          }
        } else {
          // Append
          updated = existing + (existing.endsWith("\n") || existing === "" ? "" : "\n") + "\n" + block + "\n";
        }

        writeFileSync(claudeMdPath, updated, "utf8");
        return {
          content: [{ type: "text" as const, text: `Instructions persisted to ${claudeMdPath}` }],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Failed to persist instructions: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    }
  );

  return server;
}

const httpTransports: Record<string, StreamableHTTPServerTransport> = {};

interface SessionMeta {
  clientId: string;      // display name: tag or workspace name or sess-xxxx
  tag?: string;          // user-supplied session tag from ?tag=
  clientName?: string;   // MCP clientInfo.name (e.g. "claude-code")
  clientVersion?: string;
  workspaceName?: string; // workspace folder name (e.g. "AlphaWave")
  host?: string;         // remote address of the client
  connectedAt: number;
  lastSeen: number;      // last time we saw any request from this session
}
const sessions: Record<string, SessionMeta> = {};

// Reap sessions that haven't made any request in a while. Keeps the sessions
// list and pills bar accurate even when clients vanish without closing their
// transport (VS Code window closed, laptop lid shut, network died). On next
// reconnect the client gets a 404 and reinitializes cleanly.
//
// The MCP instructions force agents to call get_idle_seconds every 15–30s as a
// keepalive, so any session that hasn't made *any* request in 90s is almost
// certainly dead. Keep this tight — the whole point is that stale sessions
// stop showing up in broadcast acks.
const SESSION_IDLE_TIMEOUT_MS = 90 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [sessionId, meta] of Object.entries(sessions)) {
    if (now - meta.lastSeen > SESSION_IDLE_TIMEOUT_MS) {
      log("·", "session", `reaped idle session ${meta.clientId} (last seen ${Math.round((now - meta.lastSeen) / 1000)}s ago)`);
      try { httpTransports[sessionId]?.close(); } catch { /* ignore */ }
      delete httpTransports[sessionId];
      delete sessions[sessionId];
    }
  }
  // Prune SSE inbox subscribers whose underlying socket has died. Node
  // surfaces dead sockets as destroyed/writableEnded — if we don't sweep
  // these, broadcastInbox quietly writes to ghosts and the ack count lies
  // to the user ("Broadcast to 3 sessions" when there's really one).
  for (const c of inboxStreamClients) {
    if (c.res.destroyed || c.res.writableEnded || !c.res.writable) {
      inboxStreamClients.delete(c);
    }
  }
}, 15_000);

function listActiveSessions(): SessionMeta[] {
  return Object.values(sessions);
}

function sessionsMatchingTag(tag: string | undefined): SessionMeta[] {
  if (!tag) return listActiveSessions();
  return listActiveSessions().filter(s => s.tag === tag);
}

// Synchronous best-effort liveness check before we count sessions in an ack.
// The transport's SDK doesn't expose a "ping" API, but it does hold a ref to
// the response stream of the last GET the client opened — if that stream is
// destroyed/ended, the client is gone. We also use the `lastSeen` shortcut:
// if a session hasn't made a request in more than (idle+grace) seconds and
// the MCP instructions require a 15-30s heartbeat, it's dead. Be lenient —
// false-positives here result in lying to the user; false-negatives just
// cause a harmless write that the next reap will clean up.
const LIVE_GRACE_MS = 60_000;
function pruneDeadSessions(): void {
  const now = Date.now();
  for (const [sessionId, meta] of Object.entries(sessions)) {
    const stale = now - meta.lastSeen > LIVE_GRACE_MS;
    const transport = httpTransports[sessionId] as any;
    // The SDK stashes the active response stream on the transport for server-
    // sent notifications. If it exists and is dead, prune. Guarded because
    // the internal field name isn't stable across SDK versions.
    const streams: any[] = [transport?._streams, transport?._responseStreams, transport?._sseResponse]
      .filter(Boolean)
      .flatMap(s => (s instanceof Map ? [...s.values()] : Array.isArray(s) ? s : [s]));
    const deadStream = streams.length > 0 && streams.every(r => r?.destroyed || r?.writableEnded || r?.writable === false);
    if (stale || deadStream) {
      log("·", "session", `pruned unresponsive session ${meta.clientId} (stale=${stale}, deadStream=${deadStream})`);
      try { httpTransports[sessionId]?.close(); } catch { /* ignore */ }
      delete httpTransports[sessionId];
      delete sessions[sessionId];
    }
  }
}

function sessionDisplay(s: SessionMeta): string {
  return s.tag ? `@${s.tag}` : s.clientId;
}

app.all("/mcp", async (req, res) => {
  console.log("[debug-url]", req.method, req.url, "query:", JSON.stringify(req.query), "ua:", req.headers["user-agent"]);
  const existingSessionId = req.headers["mcp-session-id"] as string | undefined;

  if (existingSessionId && httpTransports[existingSessionId]) {
    const transport = httpTransports[existingSessionId];
    await transport.handleRequest(req, res, req.body);
    // Lazy-populate clientInfo after initialize lands on an existing session.
    const meta = sessions[existingSessionId];
    if (meta) meta.lastSeen = Date.now();
    const mcpServer = (httpTransports[existingSessionId] as any)?.__mcpServer;
    if (meta && !meta.clientName && mcpServer?.getClientVersion) {
      try {
        const info = mcpServer.getClientVersion();
        if (info) {
          meta.clientName = info.name;
          meta.clientVersion = info.version;
        }
      } catch { /* ignore */ }
    }
    return;
  }

  // Auto-reconnect path. If the client presents a session id we don't know
  // about AND the request body is a fresh `initialize`, adopt the stale id
  // instead of 404-ing. This covers the "server was restarted while Claude
  // Code was open" case: clients that cache the session id (claude-code#27142)
  // would otherwise stay ghost until the human manually reloaded the window.
  // A non-initialize request with an unknown id still gets 404 — the client
  // is expected to reinitialize in response.
  const bodyIsInitialize =
    req.method === "POST" &&
    req.body &&
    (Array.isArray(req.body)
      ? req.body.some((m: any) => m?.method === "initialize")
      : req.body.method === "initialize");

  if (existingSessionId && !bodyIsInitialize) {
    res.status(404).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Session not found — reinitialize" },
      id: null,
    });
    return;
  }

  const rawTag = typeof req.query.tag === "string" ? req.query.tag : undefined;
  const sessionTag = rawTag?.toLowerCase().replace(/[^a-z0-9_-]/g, "") || undefined;
  // If the client brought a stale id on an initialize, reuse it so the client
  // never has to swap ids. Otherwise mint a fresh one.
  const newSessionId = existingSessionId ?? randomUUID();
  const host = (req.socket.remoteAddress || "").replace(/^::ffff:/, "") || undefined;
  const port = req.socket.remotePort;
  // Pull clientInfo and workspace from the initialize body immediately so the
  // pill shows a readable name from the start.
  const initBody = Array.isArray(req.body)
    ? req.body.find((m: any) => m?.method === "initialize")
    : req.body;
  const earlyClientName: string | undefined = initBody?.params?.clientInfo?.name;
  // Prefer the workspace folder name (e.g. "AlphaWave", "notify-mcp-src") over
  // the generic client name ("claude-code"). workspaceFolders[0].name is set by
  // Claude Code and Cursor; rootUri is the fallback.
  const workspaceFolders: any[] | undefined = initBody?.params?.workspaceFolders;
  const rootUri: string | undefined = initBody?.params?.rootUri ?? initBody?.params?.root_uri;
  const workspaceName: string | undefined =
    workspaceFolders?.[0]?.name ||
    (rootUri ? rootUri.replace(/\\/g, "/").split("/").filter(Boolean).pop() : undefined);
  // Build a distinguishable client id: tag wins if set; workspace name next;
  // then clientInfo.name; otherwise use host+port. If the base id is already
  // taken, append -2, -3, … so two windows on the same project still show up.
  const baseId = sessionTag
    ?? workspaceName
    ?? earlyClientName
    ?? (host && port ? `${host === "127.0.0.1" || host === "::1" ? "local" : host}:${port}` : `sess-${newSessionId.slice(0, 8)}`);
  // Exclude the session being re-adopted from the "taken" set — it's about to
  // be replaced, so its old clientId should be available for reuse.
  const adoptingId = existingSessionId && bodyIsInitialize ? existingSessionId : undefined;
  const takenIds = new Set(
    Object.entries(sessions)
      .filter(([sid]) => sid !== adoptingId)
      .map(([, s]) => s.clientId)
  );
  let clientId = baseId;
  for (let n = 2; takenIds.has(clientId); n++) clientId = `${baseId}-${n}`;
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => newSessionId });
  transport.onclose = () => {
    if (transport.sessionId) {
      delete httpTransports[transport.sessionId];
      delete sessions[transport.sessionId];
    }
  };
  const mcpServer = createMcpServer(clientId, sessionTag);
  await mcpServer.connect(transport);
  // Stash the underlying MCP server on the transport so subsequent requests
  // can grab clientInfo once the initialize handshake completes.
  (transport as any).__mcpServer = (mcpServer as any).server ?? mcpServer;
  await transport.handleRequest(req, res, req.body);
  if (transport.sessionId) {
    httpTransports[transport.sessionId] = transport;
    const now = Date.now();
    sessions[transport.sessionId] = {
      clientId, tag: sessionTag, host, connectedAt: now, lastSeen: now,
      clientName: earlyClientName,
      clientVersion: initBody?.params?.clientInfo?.version,
      workspaceName,
    };
    trackReconnect(clientId);
  }
});

// ── Reconnect tracker ─────────────────────────────────────────────────────────
// After server restart, collect clients that reconnect within RECONNECT_WINDOW_MS
// then send a single notify confirming they received updated instructions.

const RECONNECT_WINDOW_MS = 20_000;
const reconnectedClients: string[] = [];
let reconnectNotifScheduled = false;
const serverStartedAt = Date.now();

function trackReconnect(clientId: string): void {
  if (Date.now() - serverStartedAt > RECONNECT_WINDOW_MS) return;
  if (reconnectedClients.includes(clientId)) return;
  reconnectedClients.push(clientId);
  if (!reconnectNotifScheduled) {
    reconnectNotifScheduled = true;
    setTimeout(async () => {
      const list = reconnectedClients.join(", ");
      const count = reconnectedClients.length;
      const msg = `${count} client${count === 1 ? "" : "s"} reconnected and received updated instructions: ${list}`;
      try { await sendNotification(msg, "low", "omni-notify-mcp"); } catch { /* best effort */ }
    }, RECONNECT_WINDOW_MS);
  }
}

// ── Start ─────────────────────────────────────────────────────────────────────

const httpServer = app.listen(PORT, "0.0.0.0", () => {
  const ip = getLocalIp();
  console.log(`\n  Claude Notify config UI  → http://localhost:${PORT}`);
  console.log(`  MCP endpoint (remote)    → http://${ip}:${PORT}/mcp\n`);
  startTelegramListener();
  open(`http://localhost:${PORT}`).catch(() => {});
});

// TCP-level keepalive on every incoming socket. Without this, a client that
// vanishes (laptop lid, killed VS Code, WiFi drop) leaves a half-open TCP
// connection that Node never notices — the SDK's `onclose` therefore never
// fires and the session goes zombie. With SO_KEEPALIVE the OS probes every
// 15s and kills the socket within a couple minutes of silence, which fires
// our reaper and clears the session bookkeeping.
httpServer.on("connection", (socket) => {
  socket.setKeepAlive(true, 15_000);
});
// keepAliveTimeout gates how long Node holds an HTTP/1.1 keep-alive idle
// connection open before closing it. Default is 5s, which was fine for
// short-lived requests but kills long-poll waiters and MCP GET streams
// prematurely. Bump above the 55s long-poll ceiling so the socket stays
// alive across the whole wait. headersTimeout must exceed it.
httpServer.keepAliveTimeout = 75_000;
httpServer.headersTimeout = 80_000;

// App-level keepalive on every active MCP GET SSE stream. The SDK doesn't
// emit any bytes on an idle stream, so intermediate proxies and some clients
// time out the stream after ~60s of silence. We write an SSE *comment* line
// (`: keepalive\n\n`) directly to each live response — comments are ignored
// by SSE parsers but reset proxy idle timers and surface dead sockets as
// write errors that we can catch and reap. Pattern is the community-standard
// fix for typescript-sdk#270.
setInterval(() => {
  for (const [sid, transport] of Object.entries(httpTransports)) {
    const t = transport as any;
    // Internal field names vary across SDK versions. Collect every candidate
    // response stream reference; the ones we find are either Response-like
    // objects with .write or Maps/arrays of them. Write-failure is the signal
    // that tells us the socket is dead.
    const candidates: any[] = [];
    for (const key of ["_streamMapping", "_streams", "_responseStreams", "_sseResponse", "_responses"]) {
      const v = t[key];
      if (!v) continue;
      if (v instanceof Map) candidates.push(...v.values());
      else if (Array.isArray(v)) candidates.push(...v);
      else candidates.push(v);
    }
    let wrote = false;
    let allDead = candidates.length > 0;
    for (const r of candidates) {
      if (!r || r.destroyed || r.writableEnded || r.writable === false) continue;
      try {
        r.write(`: keepalive ${Date.now()}\n\n`);
        wrote = true;
        allDead = false;
      } catch {
        // write failed — socket is dead, move on
      }
    }
    if (candidates.length > 0 && allDead) {
      try { httpTransports[sid]?.close(); } catch { /* ignore */ }
      delete httpTransports[sid];
      delete sessions[sid];
    }
    // Touch lastSeen on a successful keepalive write so the reaper doesn't
    // kill a session that's quietly connected but idle. lastSeen normally
    // tracks inbound requests; extending it to "stream is verified writable"
    // is fine — if the write succeeds, the client really is still there.
    if (wrote && sessions[sid]) {
      sessions[sid].lastSeen = Date.now();
    }
  }
}, 20_000);
