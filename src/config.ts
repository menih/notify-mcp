import { readFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export interface DesktopConfig {
  enabled: boolean;
  sound?: boolean;
  tts?: boolean;
  ttsVoice?: string;
}

export interface TelegramConfig {
  enabled: boolean;
  token: string;
  chatId: string;
}

export interface WhatsAppConfig {
  enabled: boolean;
  instanceId: string;
  apiToken: string;
  phone: string;
}

export interface SmsConfig {
  enabled: boolean;
  accountSid: string;
  authToken: string;
  from: string;
  to: string;
}

export interface EmailConfig {
  enabled: boolean;
  to: string;
  from?: string;
  // OAuth (Gmail) — populated by the config UI
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  accessToken?: string;
  connectedEmail?: string;
  // SMTP fallback
  host?: string;
  port?: number;
  secure?: boolean;
  user?: string;
  pass?: string;
}

export interface NtfyConfig {
  enabled: boolean;
  topic: string;
}

export interface DiscordConfig {
  enabled: boolean;
  webhookUrl: string;
  username?: string;
}

export interface SlackConfig {
  enabled: boolean;
  webhookUrl: string;
}

export interface TeamsConfig {
  enabled: boolean;
  webhookUrl: string;
}

export interface Config {
  desktop: DesktopConfig;
  telegram: TelegramConfig;
  whatsapp: WhatsAppConfig;
  sms: SmsConfig;
  email: EmailConfig;
  ntfy: NtfyConfig;
  discord: DiscordConfig;
  slack: SlackConfig;
  teams: TeamsConfig;
}

const CONFIG_PATHS = [
  join(process.cwd(), "config.json"),
  join(homedir(), ".notify-mcp", "config.json"),
];

export function loadConfig(): Config {
  for (const path of CONFIG_PATHS) {
    if (existsSync(path)) {
      const raw = readFileSync(path, "utf-8");
      return JSON.parse(raw) as Config;
    }
  }
  throw new Error(
    `No config.json found. Run: npm run ui  (then configure at http://localhost:3737)`
  );
}
