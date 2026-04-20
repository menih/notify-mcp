import notifier from "node-notifier";
import { spawn } from "child_process";
import { tmpdir } from "os";
import { join } from "path";
import { DesktopConfig } from "../config.js";

const DEFAULT_TTS_VOICE = "en-US-AndrewMultilingualNeural";

export async function sendDesktop(config: DesktopConfig, message: string): Promise<void> {
  if (!config.enabled) return;
  const wantSound = config.sound !== false;
  // On Windows, SnoreToast's per-app sound is often muted in Windows settings.
  // Fire a PowerShell beep alongside the toast so audio is reliable.
  if (wantSound && process.platform === "win32") {
    spawn("powershell", [
      "-NoProfile", "-Command",
      "Add-Type -AssemblyName System.Windows.Forms; [System.Media.SystemSounds]::Asterisk.Play(); Start-Sleep -Milliseconds 600",
    ], { windowsHide: true, stdio: "ignore" });
  }
  if (config.tts) {
    // Fire-and-forget: synthesize and play in the background so we don't
    // block the MCP request on network + audio playback.
    speak(message, config.ttsVoice ?? DEFAULT_TTS_VOICE).catch(() => {});
  }
  await new Promise<void>((resolve, reject) => {
    notifier.notify(
      { title: "Claude", message, sound: wantSound && process.platform !== "win32" },
      (err) => err ? reject(err) : resolve(),
    );
  });
}

export async function speak(text: string, voice: string = DEFAULT_TTS_VOICE): Promise<void> {
  // Lazy import so boot doesn't pay for msedge-tts when TTS is off.
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
