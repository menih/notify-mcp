import { TelegramConfig } from "../config.js";

export async function sendTelegram(config: TelegramConfig, message: string): Promise<void> {
  if (!config.enabled) return;
  const res = await fetch(`https://api.telegram.org/bot${config.token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: config.chatId, text: message }),
  });
  if (!res.ok) throw new Error(`Telegram error ${res.status}: ${await res.text()}`);
}
