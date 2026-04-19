import { WhatsAppConfig } from "../config.js";

export async function sendWhatsApp(config: WhatsAppConfig, message: string): Promise<void> {
  if (!config.enabled) return;
  const encoded = encodeURIComponent(message);
  const url = `https://api.callmebot.com/whatsapp.php?phone=${config.phone}&text=${encoded}&apikey=${config.apikey}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Callmebot error ${res.status}: ${await res.text()}`);
}
