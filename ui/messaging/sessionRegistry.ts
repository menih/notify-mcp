import type { SessionMeta } from "./types.js";

export class SessionRegistry {
  private readonly sessions = new Map<string, SessionMeta>();

  upsert(meta: SessionMeta): void {
    this.sessions.set(meta.sessionId, meta);
  }

  touch(sessionId: string): void {
    const current = this.sessions.get(sessionId);
    if (!current) return;
    current.lastSeen = Date.now();
  }

  remove(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  all(): SessionMeta[] {
    return [...this.sessions.values()];
  }

  matching(tag?: string): SessionMeta[] {
    if (!tag) return this.all();
    return this.all().filter((session) => session.tag === tag);
  }

  get(sessionId: string): SessionMeta | undefined {
    return this.sessions.get(sessionId);
  }

  reapIdle(timeoutMs: number): SessionMeta[] {
    const now = Date.now();
    const removed: SessionMeta[] = [];
    for (const [id, session] of this.sessions) {
      if (now - session.lastSeen > timeoutMs) {
        removed.push(session);
        this.sessions.delete(id);
      }
    }
    return removed;
  }
}
