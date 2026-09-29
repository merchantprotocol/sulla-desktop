/**
 * Session-token registry behind MCPServerHost: maps a Bearer token (handed to
 * a Claude Code / Codex process for its MCP config and `sulla` CLI calls) to
 * the live graph state those calls should act on.
 *
 * Kept free of express / MCP SDK imports so the expiry rules are unit-testable.
 */

import { randomBytes } from 'crypto';

import type { BaseThreadState } from '@pkg/agent/nodes/Graph';

// Default session lifetime. Claude Code calls are short (usually <60s), but
// workflow orchestration can take longer — 10 min leaves room.
export const DEFAULT_SESSION_TTL_MS = 10 * 60 * 1000;

/**
 * A live Claude Code invocation bound to a specific graph instance. Tools
 * called over MCP during the invocation operate on `state` — they can
 * read/mutate the calling graph's metadata directly, which is the whole
 * point of the in-process bridge.
 */
export interface ToolSession {
  id:         string;
  state:      BaseThreadState;
  createdAt:  number;
  lastUsedAt: number;
  expiresAt:  number;
  /** Idle lifetime: every use slides `expiresAt` to `now + ttlMs`. */
  ttlMs:      number;
}

export class ToolSessionRegistry {
  private readonly sessions = new Map<string, ToolSession>();

  register(state: BaseThreadState, ttlMs: number = DEFAULT_SESSION_TTL_MS): string {
    const id = randomBytes(24).toString('base64url');

    this.put(id, state, ttlMs);
    return id;
  }

  revoke(id: string): void {
    this.sessions.delete(id);
  }

  /**
   * Re-point a token at a new graph state and refresh its TTL. A token that
   * was reaped while its process sat idle is revived under the same id — the
   * process cannot pick up a replacement, so minting a new one would leave
   * every CLI/MCP call in the turn on "Expired tool session". Keeps the
   * session's own TTL unless one is passed.
   */
  rebind(id: string, state: BaseThreadState, ttlMs?: number): boolean {
    if (!id) return false;
    const session = this.sessions.get(id);
    if (!session) {
      this.put(id, state, ttlMs ?? DEFAULT_SESSION_TTL_MS);
      return true;
    }
    const now = Date.now();
    if (ttlMs !== undefined) session.ttlMs = ttlMs;
    session.state = state;
    session.lastUsedAt = now;
    session.expiresAt = now + session.ttlMs;
    return true;
  }

  /** Live session for a token, sliding its expiry; null if unknown or expired. */
  get(id: string): ToolSession | null {
    const session = this.sessions.get(id);
    if (!session) return null;
    const now = Date.now();
    if (session.expiresAt <= now) {
      this.sessions.delete(id);
      return null;
    }
    // Sliding expiry: a session in active use never times out mid-turn.
    session.lastUsedAt = now;
    session.expiresAt = Math.max(session.expiresAt, now + session.ttlMs);
    return session;
  }

  sweepExpired(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(id);
    }
  }

  clear(): void {
    this.sessions.clear();
  }

  private put(id: string, state: BaseThreadState, ttlMs: number): void {
    const now = Date.now();

    this.sessions.set(id, { id, state, createdAt: now, lastUsedAt: now, expiresAt: now + ttlMs, ttlMs });
  }
}
