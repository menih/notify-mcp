import notifier from "node-notifier";
import { spawn } from "child_process";
import { DesktopConfig } from "../config.js";

export async function sendDesktop(config: DesktopConfig, message: string): Promise<void> {
  if (!config.enabled) return;
  const wantSound = config.sound !== false;
  // On Windows, SnoreToast's per-app sound is often muted in Windows settings.
  // Fire a PowerShell beep alongside the toast so audio is reliable.
  if (wantSound && process.platform === "win32") {
    spawn("powershell", [
      "-NoProfile", "-Command",
      "[console]::beep(880,180); Start-Sleep -Milliseconds 60; [console]::beep(660,180)",
    ], { windowsHide: true, stdio: "ignore" });
  }
  await new Promise<void>((resolve, reject) => {
    notifier.notify(
      { title: "Claude", message, sound: wantSound && process.platform !== "win32" },
      (err) => err ? reject(err) : resolve(),
    );
  });
}
