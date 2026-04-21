export interface DiscordConfig {
  enabled: boolean;
  webhookUrl: string;
  username?: string;  // bot display name, default: "Claude Notify"
}

const COLOR_MAP: Record<string, number> = { low: 0x6b7280, normal: 0x7c6dfa, high: 0xef4444 };

export async function sendDiscord(
  config: DiscordConfig,
  message: string,
  priority: "low" | "normal" | "high" = "normal",
  title = "Claude Notify",
): Promise<void> {
  if (!config.enabled) return;
  const res = await fetch(config.webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: config.username ?? "Claude Notify",
      embeds: [{
        title,
        description: message,
        color: COLOR_MAP[priority] ?? COLOR_MAP.normal,
        timestamp: new Date().toISOString(),
      }],
    }),
  });
  if (!res.ok) throw new Error(`Discord ${res.status}: ${await res.text()}`);
}
