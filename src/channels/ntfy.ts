export interface NtfyConfig {
  enabled: boolean;
  topic: string;
  serverUrl?: string;   // default: https://ntfy.sh
  token?: string;       // for self-hosted or ntfy.sh pro
}

const PRIORITY_MAP: Record<string, number> = { low: 2, normal: 3, high: 5 };

export async function sendNtfy(
  config: NtfyConfig,
  message: string,
  priority: "low" | "normal" | "high" = "normal",
  title = "Claude Notify",
): Promise<void> {
  if (!config.enabled) return;
  const base = (config.serverUrl ?? "https://ntfy.sh").replace(/\/$/, "");
  const safeTitle = encodeURIComponent(title);
  const headers: Record<string, string> = {
    "Content-Type": "text/plain; charset=utf-8",
    "Title": safeTitle,
    "Priority": String(PRIORITY_MAP[priority] ?? 3),
    "Tags": priority === "high" ? "rotating_light" : "bell",
  };
  if (config.token) headers["Authorization"] = `Bearer ${config.token}`;
  const res = await fetch(`${base}/${encodeURIComponent(config.topic)}`, {
    method: "POST",
    headers,
    body: message,
  });
  if (!res.ok) throw new Error(`ntfy ${res.status}: ${await res.text()}`);
}
