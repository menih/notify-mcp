import { WhatsAppConfig } from "../config.js";

export async function sendWhatsApp(config: WhatsAppConfig, message: string): Promise<void> {
  if (!config.enabled) return;
  const res = await fetch(
    `https://api.callmebot.com/whatsapp.php?phone=${config.phone}&text=${encodeURIComponent(message)}&apikey=${config.apikey}`
  );
  if (!res.ok) throw new Error(`Callmebot error ${res.status}: ${await res.text()}`);
}
