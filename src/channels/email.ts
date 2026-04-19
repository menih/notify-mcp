import nodemailer from "nodemailer";
import { EmailConfig } from "../config.js";

export async function sendEmail(config: EmailConfig, message: string): Promise<void> {
  if (!config.enabled) return;

  const transport = config.refreshToken && config.clientId && config.clientSecret
    ? nodemailer.createTransport({
        service: "gmail",
        auth: {
          type: "OAuth2",
          user: config.connectedEmail ?? config.to,
          clientId: config.clientId,
          clientSecret: config.clientSecret,
          refreshToken: config.refreshToken,
          accessToken: config.accessToken,
        },
      })
    : nodemailer.createTransport({
        host: config.host,
        port: config.port ?? 587,
        secure: config.secure ?? false,
        auth: { user: config.user, pass: config.pass },
      });

  await transport.sendMail({
    from: config.from ?? config.connectedEmail ?? config.user,
    to: config.to,
    subject: "Claude notification",
    text: message,
  });
}
