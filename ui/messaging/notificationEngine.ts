import type { Priority } from "./types.js";

export interface NotificationRoutingContext {
  inTelegramConversation: boolean;
  uiActive: boolean;
  idleSeconds: number;
}

export interface NotificationSenders {
  desktop?: (message: string) => Promise<void>;
  telegram?: (message: string) => Promise<void>;
  sms?: (message: string) => Promise<void>;
  email?: (message: string) => Promise<void>;
  ntfy?: (message: string, priority: Priority) => Promise<void>;
  discord?: (message: string, priority: Priority) => Promise<void>;
  slack?: (message: string, priority: Priority) => Promise<void>;
  teams?: (message: string, priority: Priority) => Promise<void>;
}

export interface NotificationPolicy {
  idleEnabled: boolean;
  idleThresholdSeconds: number;
  alwaysDesktopWhenActive: boolean;
  dndActive: boolean;
}

export interface NotificationResult {
  delivered: string[];
  errors: string[];
  suppressedReason?: string;
}

export function computeDesktopOnlyMode(
  priority: Priority,
  policy: NotificationPolicy,
  ctx: NotificationRoutingContext,
): { desktopOnly: boolean; suppressedReason?: string } {
  if (priority === "high") {
    return { desktopOnly: false };
  }
  if (policy.dndActive) {
    return { desktopOnly: false, suppressedReason: "dnd" };
  }
  if (ctx.uiActive || (policy.idleEnabled && !ctx.inTelegramConversation && ctx.idleSeconds >= 0 && ctx.idleSeconds < policy.idleThresholdSeconds)) {
    if (policy.alwaysDesktopWhenActive) {
      return { desktopOnly: true };
    }
    return { desktopOnly: false, suppressedReason: "idle" };
  }
  return { desktopOnly: false };
}

export async function sendWithRouting(options: {
  message: string;
  priority: Priority;
  senders: NotificationSenders;
  policy: NotificationPolicy;
  ctx: NotificationRoutingContext;
  enableDesktop: boolean;
  enableTelegram: boolean;
  enableEmail: boolean;
  enableSms: boolean;
  enableNtfy: boolean;
  enableDiscord: boolean;
  enableSlack: boolean;
  enableTeams: boolean;
}): Promise<NotificationResult> {
  const {
    message,
    priority,
    senders,
    policy,
    ctx,
    enableDesktop,
    enableTelegram,
    enableEmail,
    enableSms,
    enableNtfy,
    enableDiscord,
    enableSlack,
    enableTeams,
  } = options;

  const mode = computeDesktopOnlyMode(priority, policy, ctx);
  if (mode.suppressedReason === "dnd") {
    return { delivered: [], errors: [], suppressedReason: "DND active" };
  }
  if (mode.suppressedReason === "idle") {
    return { delivered: [], errors: [], suppressedReason: "Idle gated while active" };
  }

  const delivered: string[] = [];
  const errors: string[] = [];
  const desktopOnly = mode.desktopOnly;

  const trySend = async (name: string, fn: (() => Promise<void>) | undefined): Promise<void> => {
    if (!fn) return;
    try {
      await fn();
      delivered.push(name);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${name}: ${msg}`);
    }
  };

  if (priority !== "low") {
    if (enableDesktop) {
      await trySend("desktop", senders.desktop ? () => senders.desktop!(message) : undefined);
    }
    if (!desktopOnly && enableTelegram) {
      await trySend("telegram", senders.telegram ? () => senders.telegram!(message) : undefined);
    }
  }

  if (!desktopOnly && enableEmail) {
    await trySend("email", senders.email ? () => senders.email!(message) : undefined);
  }

  if (!desktopOnly && enableNtfy) {
    await trySend("ntfy", senders.ntfy ? () => senders.ntfy!(message, priority) : undefined);
  }

  if (!desktopOnly && enableDiscord) {
    await trySend("discord", senders.discord ? () => senders.discord!(message, priority) : undefined);
  }

  if (!desktopOnly && enableSlack) {
    await trySend("slack", senders.slack ? () => senders.slack!(message, priority) : undefined);
  }

  if (!desktopOnly && enableTeams) {
    await trySend("teams", senders.teams ? () => senders.teams!(message, priority) : undefined);
  }

  if (priority === "high" && enableSms) {
    await trySend("sms", senders.sms ? () => senders.sms!(message) : undefined);
  }

  return { delivered, errors };
}
