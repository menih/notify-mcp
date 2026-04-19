import twilio from "twilio";
import { SmsConfig } from "../config.js";

export async function sendSms(config: SmsConfig, message: string): Promise<void> {
  if (!config.enabled) return;
  const client = twilio(config.accountSid, config.authToken);
  await client.messages.create({ body: message, from: config.from, to: config.to });
}
