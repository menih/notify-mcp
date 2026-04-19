// ── State ─────────────────────────────────────────────────────────────────

let config = {};
const dirty = new Set();

// ── Bootstrap ─────────────────────────────────────────────────────────────

async function init() {
  handleUrlParams();
  await loadConfig();
  renderOsHint();
}

function handleUrlParams() {
  const params = new URLSearchParams(location.search);
  if (params.has("success")) {
    const msg = params.get("success") === "gmail_connected"
      ? "Gmail connected successfully!"
      : "Success!";
    toast(msg, "ok");
  }
  if (params.has("error")) {
    toast("Error: " + decodeURIComponent(params.get("error")), "error");
  }
  if (params.toString()) {
    history.replaceState({}, "", location.pathname);
  }
}

async function loadConfig() {
  try {
    const res = await fetch("/api/config");
    config = await res.json();
    populateForm();
    updateBadges();
  } catch (e) {
    toast("Failed to load config: " + e, "error");
  }
}

// ── Populate form from config ─────────────────────────────────────────────

function populateForm() {
  // Desktop
  $("desktop-enabled").checked = !!config.desktop?.enabled;

  // Email / Gmail
  const email = config.email ?? {};
  if (email.connectedEmail) {
    showGmailConnected(email.connectedEmail, email.to);
  } else {
    showGmailSetup(email);
  }

  // Telegram
  const tg = config.telegram ?? {};
  $("telegram-enabled").checked = !!tg.enabled;
  $("telegram-token").value = tg.token ?? "";
  $("telegram-chatid").value = tg.chatId ?? "";


  // SMS
  const sms = config.sms ?? {};
  $("sms-enabled").checked = !!sms.enabled;
  $("sms-sid").value = sms.accountSid ?? "";
  $("sms-token").value = sms.authToken ?? "";
  $("sms-from").value = sms.from ?? "";
  $("sms-to").value = sms.to ?? "";

  // DND
  const dnd = config.dnd ?? {};
  $("dnd-enabled").checked = !!dnd.enabled;
  const sched = dnd.schedule ?? {};
  $("dnd-schedule-enabled").checked = !!sched.enabled;
  $("dnd-quiet-start").value = sched.quietStart ?? "22:00";
  $("dnd-quiet-end").value = sched.quietEnd ?? "08:00";
  const days = Array.isArray(sched.days) ? sched.days : [0,1,2,3,4,5,6];
  document.querySelectorAll("#dnd-days input[type=checkbox]").forEach(el => {
    el.checked = days.includes(parseInt(el.dataset.day, 10));
  });

  // Idle gating
  const idle = config.idle ?? {};
  $("idle-enabled").checked = idle.enabled !== false; // default on
  $("idle-threshold").value = idle.thresholdSeconds ?? 120;
}

function showGmailConnected(email, to) {
  $("gmail-connected-state").classList.remove("hidden");
  $("gmail-setup-state").classList.add("hidden");
  $("gmail-connected-email").textContent = email;
  $("gmail-to-connected").value = to ?? email;
  $("email-enabled").checked = !!config.email?.enabled;
}

function showGmailSetup(email) {
  $("gmail-connected-state").classList.add("hidden");
  $("gmail-setup-state").classList.remove("hidden");
  $("gmail-address").value = email.user ?? email.connectedEmail ?? "";
  $("gmail-guide").removeAttribute("open");
}

// ── Badges ────────────────────────────────────────────────────────────────

function updateBadges() {
  setBadge("desktop",   config.desktop?.enabled  ? "ok"   : "idle",
    config.desktop?.enabled ? "Enabled" : "Disabled");

  const email = config.email ?? {};
  setBadge("email",
    email.connectedEmail ? "ok" : email.clientId ? "warn" : "idle",
    email.connectedEmail ? "Connected" : email.clientId ? "Credentials saved" : "Not configured");

  const tg = config.telegram ?? {};
  setBadge("telegram",
    tg.enabled && tg.token && tg.chatId ? "ok" : tg.token ? "warn" : "idle",
    tg.enabled && tg.token && tg.chatId ? "Configured" : tg.token ? "Incomplete" : "Not configured");

const sms = config.sms ?? {};
  setBadge("sms",
    sms.enabled && sms.accountSid && sms.authToken ? "ok" : sms.accountSid ? "warn" : "idle",
    sms.enabled && sms.accountSid && sms.authToken ? "Configured" : sms.accountSid ? "Incomplete" : "Not configured");

  // DND badge: "Active" (red), "Scheduled" (warn), or "Off" (idle)
  const dnd = config.dnd ?? {};
  const sched = dnd.schedule ?? {};
  if (dnd.enabled) {
    setBadge("dnd", "warn", "Active (manual)");
  } else if (sched.enabled) {
    setBadge("dnd", "warn", `Scheduled ${sched.quietStart ?? "22:00"}-${sched.quietEnd ?? "08:00"}`);
  } else {
    setBadge("dnd", "idle", "Off");
  }

  // Idle badge
  const idle = config.idle ?? {};
  setBadge("idle",
    idle.enabled !== false ? "ok" : "idle",
    idle.enabled !== false ? `Gate < ${idle.thresholdSeconds ?? 120}s idle` : "Disabled");
}

function setBadge(channel, type, text) {
  const el = $("badge-" + channel);
  el.className = "badge badge-" + type;
  el.textContent = text;
}

// ── Save handlers ─────────────────────────────────────────────────────────

function saveDesktop() {
  patch({ desktop: { enabled: $("desktop-enabled").checked } });
}

async function saveEmail() {
  const to = $("gmail-to-connected").value.trim();
  const enabled = $("email-enabled").checked;
  await patch({ email: { to, enabled } });
  clearDirty("email");
}

async function saveTelegram() {
  await patch({
    telegram: {
      enabled: $("telegram-enabled").checked,
      token: $("telegram-token").value.trim(),
      chatId: $("telegram-chatid").value.trim(),
    },
  });
  clearDirty("telegram");
}

async function detectChatId() {
  const token = $("telegram-token").value.trim();
  if (!token) { toast("Enter bot token first.", "error"); return; }
  try {
    const res = await fetch(`/api/telegram/chatid?token=${encodeURIComponent(token)}`);
    const json = await res.json();
    if (!res.ok) throw new Error(json.error);
    $("telegram-chatid").value = json.chatId;
    markDirty("telegram");
    toast("Chat ID detected: " + json.chatId, "ok");
  } catch (e) {
    toast("" + e, "error");
  }
}

async function saveDnd() {
  const days = [];
  document.querySelectorAll("#dnd-days input[type=checkbox]").forEach(el => {
    if (el.checked) days.push(parseInt(el.dataset.day, 10));
  });
  await patch({
    dnd: {
      enabled: $("dnd-enabled").checked,
      schedule: {
        enabled: $("dnd-schedule-enabled").checked,
        quietStart: $("dnd-quiet-start").value || "22:00",
        quietEnd: $("dnd-quiet-end").value || "08:00",
        days,
      },
    },
  });
  clearDirty("dnd");
}

async function saveIdle() {
  const thresh = parseInt($("idle-threshold").value, 10);
  await patch({
    idle: {
      enabled: $("idle-enabled").checked,
      thresholdSeconds: Number.isFinite(thresh) && thresh > 0 ? thresh : 120,
    },
  });
  clearDirty("idle");
}

async function saveSms() {
  await patch({
    sms: {
      enabled: $("sms-enabled").checked,
      accountSid: $("sms-sid").value.trim(),
      authToken: $("sms-token").value.trim(),
      from: $("sms-from").value.trim(),
      to: $("sms-to").value.trim(),
    },
  });
  clearDirty("sms");
}

async function patch(update) {
  try {
    const res = await fetch("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(update),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error);
    toast("Saved", "ok");
    await loadConfig();
  } catch (e) {
    toast("Save failed: " + e, "error");
  }
}

// ── gcloud auth ───────────────────────────────────────────────────────────

async function checkGcloud() {
  const res = await fetch("/api/gcloud/status");
  const status = await res.json();
  renderGcloudPanel(status);
  return status;
}

function renderGcloudPanel(status) {
  const panel = $("gcloud-auth-panel");
  const row = $("gcloud-status-row");
  panel.classList.remove("hidden");

  if (!status.installed) {
    row.innerHTML = `
      <span class="dot dot-warn"></span>
      <span class="status-text">gcloud not installed —
        <code class="cp" onclick="copyText(this)" style="font-size:11px">brew install --cask google-cloud-sdk</code>
        then refresh
      </span>`;
    return;
  }

  if (status.authenticated) {
    row.innerHTML = `
      <span class="dot dot-ok"></span>
      <span class="status-text">gcloud logged in as</span>
      <span class="status-account">${status.account}</span>`;
    return;
  }

  row.innerHTML = `
    <span class="dot dot-warn"></span>
    <span class="status-text">gcloud not logged in</span>
    <button class="btn btn-secondary" style="margin-left:auto;padding:4px 12px;font-size:12px"
      onclick="gcloudLogin()">Login with Google</button>`;
}

async function gcloudLogin() {
  const row = $("gcloud-status-row");
  const logPanel = $("gcloud-log");

  row.innerHTML = `<span class="dot dot-spin"></span>
    <span class="status-text">Opening browser for Google login…</span>`;
  logPanel.classList.remove("hidden");
  logPanel.textContent = "";

  const es = new EventSource("/api/gcloud/login");

  es.onmessage = (e) => {
    const { type, msg } = JSON.parse(e.data);

    if (type === "already_authed") {
      renderGcloudPanel({ installed: true, authenticated: true, account: msg });
      logPanel.classList.add("hidden");
      es.close();
      return;
    }

    if (type === "done") {
      renderGcloudPanel({ installed: true, authenticated: true, account: msg });
      logPanel.classList.add("hidden");
      toast("Logged in as " + msg, "ok");
      es.close();
      return;
    }

    if (type === "error") {
      row.innerHTML = `<span class="dot dot-warn"></span>
        <span class="status-text" style="color:var(--danger)">${msg}</span>`;
      es.close();
      return;
    }

    if (type === "open_browser") {
      logPanel.textContent += "Browser opened for login. Complete auth there, then come back here.\n";
      return;
    }

    if (type === "log") {
      logPanel.textContent += msg + "\n";
      logPanel.scrollTop = logPanel.scrollHeight;
    }
  };

  es.onerror = () => {
    row.innerHTML = `<span class="dot dot-warn"></span>
      <span class="status-text" style="color:var(--danger)">Connection lost</span>`;
    es.close();
  };
}

// ── Gmail App Password setup ──────────────────────────────────────────────

function openAppPasswords() {
  fetch("/api/google/open-apppasswords").catch(() => {});
}

async function saveAppPassword() {
  const gmailAddress = $("gmail-address").value.trim();
  const appPassword = $("gmail-app-password").value.replace(/\s/g, "");
  if (!gmailAddress || !appPassword) {
    toast("Enter your Gmail address and app password.", "error");
    return;
  }
  const btn = document.querySelector("#gmail-setup-state .btn-primary");
  if (btn) { btn.disabled = true; btn.textContent = "Connecting…"; }
  try {
    const res = await fetch("/api/google/apppassword", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ gmailAddress, appPassword }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error);
    toast("Gmail connected!", "ok");
    await loadConfig();
  } catch (e) {
    toast("Failed: " + e, "error");
    if (btn) { btn.disabled = false; btn.textContent = "Connect"; }
  }
}

async function disconnectGmail() {
  if (!confirm("Disconnect Gmail? You'll need to re-authenticate to send emails.")) return;
  try {
    const res = await fetch("/auth/google", { method: "DELETE" });
    if (!res.ok) throw new Error((await res.json()).error);
    toast("Gmail disconnected", "ok");
    await loadConfig();
  } catch (e) {
    toast("Error: " + e, "error");
  }
}

// ── Test channels ─────────────────────────────────────────────────────────

async function testChannel(channel) {
  const btn = document.querySelector(`#card-${channel === "email" ? "email" : channel} .btn-secondary`);
  if (btn) { btn.disabled = true; btn.textContent = "Sending…"; }

  try {
    const res = await fetch(`/api/test/${channel}`, { method: "POST" });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error);
    toast(json.message, "ok");
    setBadge(channel, "ok", "✓ Works");
  } catch (e) {
    toast("Test failed: " + e, "error");
    setBadge(channel, "error", "Failed");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Send test";
    }
  }
}

// ── OS hint ───────────────────────────────────────────────────────────────

function renderOsHint() {
  const ua = navigator.userAgent;
  const hint = $("os-hint");
  if (ua.includes("Mac")) {
    hint.textContent = "macOS: allow notifications for Terminal in System Settings";
    hint.classList.add("visible");
  } else if (ua.includes("Linux")) {
    hint.textContent = "Linux: needs libnotify (sudo apt install libnotify-bin)";
    hint.classList.add("visible");
  }
}

// ── Dirty tracking ────────────────────────────────────────────────────────

function markDirty(section) {
  dirty.add(section);
  const btn = $("save-" + section + "-btn");
  if (btn) btn.classList.add("dirty");
}

function clearDirty(section) {
  dirty.delete(section);
  const btn = $("save-" + section + "-btn");
  if (btn) btn.classList.remove("dirty");
}

// ── Toast ─────────────────────────────────────────────────────────────────

let toastTimer;
function toast(msg, type = "ok") {
  const el = $("toast");
  el.textContent = msg;
  el.className = "toast toast-" + type;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 3500);
}

// ── Utils ─────────────────────────────────────────────────────────────────

function $(id) { return document.getElementById(id); }

function copyText(el) {
  const text = el.textContent.replace(" 📋", "").trim();
  navigator.clipboard.writeText(text).then(() => {
    const orig = el.textContent;
    el.textContent = "Copied!";
    setTimeout(() => (el.textContent = orig), 1500);
  });
}

// ── Log panel ─────────────────────────────────────────────────────────────

// Each unique client gets a stable color
const clientColors = ["#7c6dfa","#38bdf8","#f472b6","#fb923c","#a3e635","#e879f9","#34d399","#facc15"];
const clientColorMap = {};
let clientColorIndex = 0;

function clientColor(id) {
  if (!clientColorMap[id]) {
    clientColorMap[id] = clientColors[clientColorIndex % clientColors.length];
    clientColorIndex++;
  }
  return clientColorMap[id];
}

function parseLogEntry(raw) {
  // Format: [ISO_TS][opt: [client]] DIR [channel] message
  const m = raw.match(/^\[([^\]]+)\](?:\s\[([^\]]+)\])?\s([→←·])\s\[([^\]]+)\]\s(.*)$/s);
  if (!m) return null;
  return { ts: m[1], client: m[2] || null, dir: m[3], channel: m[4], msg: m[5] };
}

function renderLogEntry(raw) {
  const panel = $("log-panel");
  const p = parseLogEntry(raw);
  const el = document.createElement("div");
  el.className = "log-entry";

  if (p) {
    const ts = new Date(p.ts).toLocaleTimeString([], { hour12: false });
    const dirClass = p.dir === "→" ? "log-dir-out" : p.dir === "←" ? "log-dir-in" : "log-dir-info";
    const clientHtml = p.client
      ? `<span class="log-client" style="color:${clientColor(p.client)}">${p.client}</span>`
      : "";
    el.innerHTML = `
      <span class="log-ts">${ts}</span>
      ${clientHtml}
      <span class="${dirClass}">${p.dir}</span>
      <span class="log-channel">[${p.channel}]</span>
      <span class="log-msg">${p.msg.replace(/</g,"&lt;")}</span>`;
  } else {
    el.innerHTML = `<span class="log-msg">${raw.replace(/</g,"&lt;")}</span>`;
  }

  const atBottom = panel.scrollHeight - panel.scrollTop <= panel.clientHeight + 20;
  panel.appendChild(el);
  if (atBottom) panel.scrollTop = panel.scrollHeight;
}

function clearLog() {
  $("log-panel").innerHTML = "";
}

function connectLogStream() {
  const dot = $("log-dot");
  const es = new EventSource("/api/logs");

  es.onmessage = (e) => {
    renderLogEntry(JSON.parse(e.data));
  };

  es.onopen = () => {
    if (dot) { dot.className = "dot dot-ok"; dot.style.display = "inline-block"; }
  };

  es.onerror = () => {
    if (dot) { dot.className = "dot dot-warn"; dot.style.display = "inline-block"; }
    es.close();
    setTimeout(connectLogStream, 3000);
  };
}

// ── Init ──────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => { init(); connectLogStream(); });
