// Omni Notify MCP — VS Code extension
//
// This extension is intentionally a *thin shim* around the npm package
// `omni-notify-mcp`. The actual MCP server, channels, config UI, and all
// behavior live in that npm package — this extension just makes it
// discoverable from the VS Code marketplace and provides convenience
// commands.
//
// VS Code 1.86+ has native MCP support. The user still needs to register
// the server in `.vscode/mcp.json` (or workspace settings) — but they get
// a one-click "Open Settings" command and a status bar indicator showing
// whether the config UI server is up.

const vscode = require("vscode");
const { spawn } = require("child_process");
const http = require("http");

let uiProcess = null;
let statusBarItem = null;

function activate(context) {
  // ── Status bar item ─────────────────────────────────────────────────────
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBarItem.command = "omniNotifyMcp.openSettings";
  statusBarItem.tooltip = "Click to open Omni Notify settings";
  context.subscriptions.push(statusBarItem);
  refreshStatus();
  // Refresh every 10s so user sees server come/go.
  const refresher = setInterval(refreshStatus, 10_000);
  context.subscriptions.push({ dispose: () => clearInterval(refresher) });

  // ── Commands ────────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("omniNotifyMcp.openSettings", openSettings),
    vscode.commands.registerCommand("omniNotifyMcp.openHelp", openHelp),
    vscode.commands.registerCommand("omniNotifyMcp.startServer", startServer)
  );

  // ── Auto-start ──────────────────────────────────────────────────────────
  const cfg = vscode.workspace.getConfiguration("omniNotifyMcp");
  if (cfg.get("autoStartUi")) {
    startServer();
  }

  // ── First-run welcome ───────────────────────────────────────────────────
  const KEY = "omniNotifyMcp.welcomed";
  if (!context.globalState.get(KEY)) {
    context.globalState.update(KEY, true);
    vscode.window
      .showInformationMessage(
        "Omni Notify MCP installed. Run `npx omni-notify-mcp` once to start the config UI, then add the server to your `.vscode/mcp.json`.",
        "Open Setup Help",
        "Open Settings UI"
      )
      .then((choice) => {
        if (choice === "Open Setup Help") openHelp();
        else if (choice === "Open Settings UI") openSettings();
      });
  }
}

function deactivate() {
  if (uiProcess && !uiProcess.killed) {
    try { uiProcess.kill(); } catch {}
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

function uiPort() {
  return vscode.workspace.getConfiguration("omniNotifyMcp").get("uiPort") || 3737;
}

function pingUi() {
  return new Promise((resolve) => {
    const req = http.get(
      { host: "127.0.0.1", port: uiPort(), path: "/api/config", timeout: 800 },
      (res) => { resolve(res.statusCode === 200); res.resume(); }
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}

async function refreshStatus() {
  const up = await pingUi();
  if (up) {
    statusBarItem.text = "$(bell) Notify";
    statusBarItem.backgroundColor = undefined;
  } else {
    statusBarItem.text = "$(bell-slash) Notify";
    statusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
  }
  statusBarItem.show();
}

async function openSettings() {
  const port = uiPort();
  const up = await pingUi();
  if (!up) {
    const choice = await vscode.window.showWarningMessage(
      `Config UI server isn't running on port ${port}.`,
      "Start it now",
      "Setup help"
    );
    if (choice === "Start it now") {
      startServer();
      // Give it a moment to start, then open
      setTimeout(() => vscode.env.openExternal(vscode.Uri.parse(`http://localhost:${port}`)), 1500);
    } else if (choice === "Setup help") {
      openHelp();
    }
    return;
  }
  vscode.env.openExternal(vscode.Uri.parse(`http://localhost:${port}`));
}

async function openHelp() {
  const port = uiPort();
  const up = await pingUi();
  if (up) {
    vscode.env.openExternal(vscode.Uri.parse(`http://localhost:${port}/help.html`));
  } else {
    // Fallback to GitHub README
    vscode.env.openExternal(vscode.Uri.parse("https://github.com/menih/omni-notify-mcp#readme"));
  }
}

function startServer() {
  if (uiProcess && !uiProcess.killed) {
    vscode.window.showInformationMessage("Omni Notify config UI is already running.");
    return;
  }
  // Spawn `npx omni-notify-mcp ui` — uses whatever's installed/cached by npx.
  // On Windows, must use shell so npx.cmd resolves.
  const isWin = process.platform === "win32";
  uiProcess = spawn("npx", ["-y", "omni-notify-mcp", "ui"], {
    shell: isWin,
    stdio: "ignore",
    detached: false,
    env: { ...process.env, PORT: String(uiPort()) },
  });
  uiProcess.on("error", (err) => {
    vscode.window.showErrorMessage(`Failed to start Omni Notify: ${err.message}`);
    uiProcess = null;
  });
  uiProcess.on("exit", (code) => {
    if (code !== 0 && code !== null) {
      vscode.window.showWarningMessage(`Omni Notify config UI exited with code ${code}.`);
    }
    uiProcess = null;
    refreshStatus();
  });
  vscode.window.showInformationMessage(`Starting Omni Notify config UI on port ${uiPort()}…`);
  setTimeout(refreshStatus, 2000);
}

module.exports = { activate, deactivate };
