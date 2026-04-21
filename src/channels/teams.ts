export interface TeamsConfig {
  enabled: boolean;
  webhookUrl: string;
}

const COLOR_MAP: Record<string, string> = { low: "Default", normal: "Accent", high: "Attention" };

export async function sendTeams(
  config: TeamsConfig,
  message: string,
  priority: "low" | "normal" | "high" = "normal",
  title = "Claude Notify",
): Promise<void> {
  if (!config.enabled) return;
  const res = await fetch(config.webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "message",
      attachments: [{
        contentType: "application/vnd.microsoft.card.adaptive",
        contentUrl: null,
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.2",
          body: [
            {
              type: "TextBlock",
              size: "Medium",
              weight: "Bolder",
              text: title,
              color: COLOR_MAP[priority] ?? "Default",
            },
            {
              type: "TextBlock",
              text: message,
              wrap: true,
            },
            {
              type: "TextBlock",
              text: `Priority: ${priority} · ${new Date().toLocaleTimeString()}`,
              isSubtle: true,
              size: "Small",
            },
          ],
        },
      }],
    }),
  });
  if (!res.ok) throw new Error(`Teams ${res.status}: ${await res.text()}`);
}
