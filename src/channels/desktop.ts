import notifier from "node-notifier";
import { DesktopConfig } from "../config.js";

export async function sendDesktop(config: DesktopConfig, message: string): Promise<void> {
  if (!config.enabled) return;
  await new Promise<void>((resolve, reject) => {
    notifier.notify({ title: "Claude", message, sound: config.sound !== false }, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}
