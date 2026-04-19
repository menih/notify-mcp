import twilio from "twilio";
import { WhatsAppConfig } from "../config.js";

export async function sendWhatsApp(config: WhatsAppConfig, message: string): Promise<void> {
  if (!config.enabled) return;
  const client = twilio(config.accountSid, config.authToken);
  await client.messages.create({
    body: message,
    from: "whatsapp:+14155238886",
    to: `whatsapp:${config.to}`,
  });
}
