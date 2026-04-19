import { WhatsAppConfig } from "../config.js";

export async function sendWhatsApp(config: WhatsAppConfig, message: string): Promise<void> {
  if (!config.enabled) return;
  const res = await fetch(
    `https://api.green-api.com/waInstance${config.instanceId}/sendMessage/${config.apiToken}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId: `${config.phone}@c.us`, message }),
    }
  );
  if (!res.ok) throw new Error(`Green API error ${res.status}: ${await res.text()}`);
}
