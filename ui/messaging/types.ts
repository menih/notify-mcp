export type Priority = "low" | "normal" | "high";

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
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  accessToken?: string;
  connectedEmail?: string;
  host?: string;
  port?: number;
  secure?: boolean;
  user?: string;
  pass?: string;
}

export interface NtfyConfig {
  enabled: boolean;
  topic: string;
  serverUrl?: string;
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

export interface DndConfig {
  enabled: boolean;
  schedule: {
    enabled: boolean;
    quietStart: string;
    quietEnd: string;
    days: number[];
  };
}

export interface IdleConfig {
  enabled: boolean;
  thresholdSeconds: number;
  alwaysDesktopWhenActive: boolean;
}

export interface AppConfig {
  desktop: DesktopConfig;
  telegram: TelegramConfig;
  whatsapp: WhatsAppConfig;
  sms: SmsConfig;
  email: EmailConfig;
  ntfy: NtfyConfig;
  discord: DiscordConfig;
  slack: SlackConfig;
  teams: TeamsConfig;
  dnd: DndConfig;
  idle: IdleConfig;
}

export interface InboxEntry {
  text: string;
  ts: string;
  tag?: string;
  messageId?: number;
}

export interface SessionMeta {
  sessionId: string;
  clientId: string;
  tag?: string;
  clientName?: string;
  clientVersion?: string;
  workspaceName?: string;
  host?: string;
  connectedAt: number;
  lastSeen: number;
}
