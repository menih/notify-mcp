export interface SlackConfig {
  enabled: boolean;
  webhookUrl: string;
}

const EMOJI_MAP: Record<string, string> = { low: "ℹ️", normal: "🔔", high: "🚨" };

export async function sendSlack(
  config: SlackConfig,
  message: string,
  priority: "low" | "normal" | "high" = "normal",
  title = "Claude Notify",
): Promise<void> {
  if (!config.enabled) return;
  const emoji = EMOJI_MAP[priority] ?? EMOJI_MAP.normal;
  const res = await fetch(config.webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: `${emoji} *${title}*`,
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: `${emoji} *${title}*\n${message}` },
        },
        {
          type: "context",
          elements: [{ type: "mrkdwn", text: `Priority: ${priority} · <!date^${Math.floor(Date.now() / 1000)}^{time}|now>` }],
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Slack ${res.status}: ${await res.text()}`);
}
