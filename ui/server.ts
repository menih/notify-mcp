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
  return c;
}

function mergePreservingSecrets(
  existing: Record<string, any>,
  update: Record<string, any>
): Record<string, any> {
  const merged: Record<string, any> = { ...defaultConfig(), ...existing };
  for (const section of ["desktop", "telegram", "whatsapp", "sms", "email", "dnd", "idle"] as const) {
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
      `Add-Type -AssemblyName presentationCore; $p = New-Object System.Windows.Media.MediaPlayer; $p.Open([uri]'${audioFilePath.replace(/\\/g, "\\\\")}'); $p.Play(); Start-Sleep -Seconds 10`,
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
  let desktopOnlyMode = false;
  if (priority !== "high" && cfg.idle?.enabled !== false) {
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
let tgPollOffset = -1;
let lastUserMessageId: number | undefined;

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

// SSE stream of new inbox messages (server-push). Each connection may filter
// by tag: /api/inbox/stream?tag=alphawave. Filtering rule mirrors poll/notify:
// untagged messages always delivered; tagged messages only when tags match.
interface SseClient { res: express.Response; tag?: string }
const inboxStreamClients = new Set<SseClient>();

function broadcastInbox(entry: InboxEntry) {
  const payload = JSON.stringify(entry);
  for (const c of inboxStreamClients) {
    if (!matchesSession(entry, c.tag)) continue;
    try {
      c.res.write(`data: ${payload}\n\n`);
    } catch {
      // drop on failure; the close handler will remove the client
    }
  }
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
            inboxQueue.push(entry);
            broadcastInbox(entry);
            log("·", "inbox", text, tag);
            // Acknowledge receipt so user knows the message was queued.
            // Wording is deliberately about *delivery*, not processing: the
            // agent might be tailing the SSE stream (sees it immediately) or
            // might only check on its next poll/notify call.
            const ackText = tag
              ? `📬 Delivered to @${tag}.`
              : `📬 Delivered. The agent will process it on its next check-in.`;
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

const MCP_INSTRUCTIONS = `
This server delivers notifications to the user through whatever channels the
user has configured on the server side. The client never needs to know which
channels are in use — just call 'notify' or 'ask' with a generic message.

BEHAVIORAL RULES for every client that connects:

1. Always call 'notify' for milestones, decisions, completions. The SERVER
   handles all gating (DND, idle, channel routing). You do not need to
   pre-flight with 'get_idle_seconds' — the server checks it itself and
   downgrades the delivery automatically. When the user is active, the server
   will play a local desktop sound+banner so they know something happened
   (without blasting their phone). Just call 'notify'.

2. Use priority correctly:
   - 'low'    = email only — for low-stakes status (background completion).
   - 'normal' = desktop + Telegram + email — the default.
   - 'high'   = all channels including SMS — bypasses DND AND idle gating.
                Use ONLY for catastrophic findings or decisions that block
                progress. Misuse will train the user to ignore your notifs.

3. Echo the full message body in your own chat / conversation output as well
   as sending it through 'notify'. The user may be reading the terminal
   directly; don't rely on them checking their phone / email.

4. The message body should be channel-agnostic. Never name 'Telegram', 'SMS',
   'email', etc. in your messages — those are server delivery details the
   user has already configured. Say 'notif' or 'notification' instead.

5. When the user sends you an unsolicited message (visible as INBOX items in
   the 'notify' response, via 'poll', or via the /api/inbox/stream SSE), reply
   to them THROUGH 'notify' so the reply actually reaches them — not just in
   your chat output.

6. The 'get_idle_*' and 'get_dnd_status' tools are informational. You can
   inspect them if you want to explain a delivery decision, but they are NOT
   required pre-flights — the server gates server-side.
`.trim();

function createMcpServer(clientId: string, sessionTag?: string) {
  const server = new McpServer(
    { name: "notify-mcp", version: "1.0.0" },
    { instructions: MCP_INSTRUCTIONS }
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
    "get_idle_seconds",
    "Returns the number of seconds since the user's last keyboard/mouse input. " +
      "Call this before 'notify' or 'ask' to decide whether to skip (user is active) " +
      "or fire (user stepped away). Returns -1 if idle detection is unsupported on " +
      "this platform — in that case, proceed without gating (fail-open).",
    {},
    async () => {
      const secs = getOsIdleSeconds();
      return { content: [{ type: "text" as const, text: String(secs) }] };
    }
  );

  server.tool(
    "get_idle_config",
    "Returns the server's idle gating policy: { enabled, thresholdSeconds, alwaysDesktopWhenActive }. " +
      "Informational only — the server gates internally on every notify call. " +
      "You don't need to pre-flight idle checks; just call 'notify'.",
    {},
    async () => {
      const cfg = loadConfig();
      const idle = cfg.idle ?? { enabled: true, thresholdSeconds: 120, alwaysDesktopWhenActive: true };
      return { content: [{ type: "text" as const, text: JSON.stringify(idle) }] };
    }
  );

  server.tool(
    "get_dnd_status",
    "Returns the current DND state: " +
      "{ active: boolean, reason: 'manual' | 'schedule' | 'off' }. " +
      "When active, the server will suppress delivery for priority < high. " +
      "Clients can use this to short-circuit before calling 'notify'.",
    {},
    async () => {
      const cfg = loadConfig();
      const active = isDndActive(cfg);
      let reason = "off";
      if (active) {
        reason = cfg.dnd?.enabled ? "manual" : "schedule";
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ active, reason }) }],
      };
    }
  );

  return server;
}

const httpTransports: Record<string, StreamableHTTPServerTransport> = {};

app.all("/mcp", async (req, res) => {
  const existingSessionId = req.headers["mcp-session-id"] as string | undefined;

  if (existingSessionId && httpTransports[existingSessionId]) {
    await httpTransports[existingSessionId].handleRequest(req, res, req.body);
    return;
  }

  const rawTag = typeof req.query.tag === "string" ? req.query.tag : undefined;
  const sessionTag = rawTag?.toLowerCase().replace(/[^a-z0-9_-]/g, "") || undefined;
  const newSessionId = randomUUID();
  const clientId = sessionTag ?? `sess-${newSessionId.slice(0, 8)}`;
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => newSessionId });
  transport.onclose = () => {
    if (transport.sessionId) delete httpTransports[transport.sessionId];
  };
  await createMcpServer(clientId, sessionTag).connect(transport);
  await transport.handleRequest(req, res, req.body);
  if (transport.sessionId) httpTransports[transport.sessionId] = transport;
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, "0.0.0.0", () => {
  const ip = getLocalIp();
  console.log(`\n  Claude Notify config UI  → http://localhost:${PORT}`);
  console.log(`  MCP endpoint (remote)    → http://${ip}:${PORT}/mcp\n`);
  startTelegramListener();
  open(`http://localhost:${PORT}`).catch(() => {});
});
