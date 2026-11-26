// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Session-token registry behind MCPServerHost: maps a Bearer token (handed to
 * a Claude Code / Codex process for its MCP config and `sulla` CLI calls) to
 * the live graph state those calls should act on.
 *
 * Kept free of express / MCP SDK imports so the expiry rules are unit-testable.
 */

import { randomBytes } from 'crypto';
import { toolSessionOrigin } from '@pkg/agent/services/ToolSessionOrigin';

import type { BaseThreadState } from '@pkg/agent/nodes/Graph';
import type { ToolExecutionContext } from '@pkg/agent/tools/executionContext';

// Default session lifetime. Claude Code calls are short (usually <60s), but
// workflow orchestration can take longer — 10 min leaves room.
export const DEFAULT_SESSION_TTL_MS = 10 * 60 * 1000;

/**
 * A live Claude Code invocation bound to a specific graph instance. Tools
 * called over MCP during the invocation operate on `state` — they can
 * read/mutate the calling graph's metadata directly, which is the whole
 * point of the in-process bridge.
 */
export type ClerkSessionAuthority = 'ordinary' | 'local' | 'unpaired' | {
  generation: string;
  expiresAt: number;
  parent?: { id: string; generation: string };
};

export interface ToolSession {
  /** Never projected into tokens, graph metadata, or caller-supplied execution contexts. */
  clerk:             ClerkSessionAuthority;
  id:                string;
  state:             BaseThreadState;
  createdAt:         number;
  lastUsedAt:        number;
  expiresAt:         number;
  /** Idle lifetime: every use slides `expiresAt` to `now + ttlMs`. */
  ttlMs:             number;
  /** Verified container identity projected into in-process tool dispatch. */
  executionContext?: ToolExecutionContext;
}

export class ToolSessionRegistry {
  private readonly sessions = new Map<string, ToolSession>();

  // Only launcher defaults outlive idle eviction. Revocation/stop invalidates the
  // captured owner marker even when the session record has already been swept.
  private readonly launcherOwners = new Map<string, { ordinaryOnly: boolean }>();

  ownLauncher(id: string): () => boolean {
    const session = this.peek(id);
    if (!session || this.launcherOwners.has(id)) throw new Error('Launcher session unavailable or already owned');
    const owner = { ordinaryOnly: session.clerk === 'ordinary' };
    this.launcherOwners.set(id, owner);
    return () => this.launcherOwners.get(id) === owner;
  }

  register(state: BaseThreadState, ttlMs: number = DEFAULT_SESSION_TTL_MS, executionContext?: ToolExecutionContext): string {
    const id = randomBytes(24).toString('base64url');

    this.put(id, state, ttlMs, executionContext);
    return id;
  }

  revoke(id: string): void {
    this.launcherOwners.delete(id);
    this.sessions.delete(id);
  }

  /**
   * Re-point a token at a new graph state and refresh its TTL. A token that
   * was reaped while its process sat idle is revived under the same id — the
   * process cannot pick up a replacement, so minting a new one would leave
   * every CLI/MCP call in the turn on "Expired tool session". Keeps the
   * session's own TTL unless one is passed.
   */
  rebind(id: string, state: BaseThreadState, ttlMs?: number, executionContext?: ToolExecutionContext): boolean {
    if (!id) return false;
    const session = this.peek(id);
    const owner = this.launcherOwners.get(id);
    if (owner && toolSessionOrigin.ordinaryOnly) owner.ordinaryOnly = true;
    if (!session) {
      // A swept record has lost its provenance. Only an owned launcher's renewal can restore pairing.
      this.put(id, state, ttlMs ?? DEFAULT_SESSION_TTL_MS, executionContext, owner?.ordinaryOnly !== false || !executionContext);
      return true;
    }
    const now = Date.now();
    if (ttlMs !== undefined) session.ttlMs = ttlMs;
    // Losing a container binding must never turn its process into a trusted desktop root.
    session.clerk = this.initialAuthority(executionContext, session.clerk === 'ordinary' || (!executionContext && session.clerk !== 'local'));
    if (owner && session.clerk === 'ordinary') owner.ordinaryOnly = true;
    session.state = state;
    session.executionContext = executionContext;
    session.lastUsedAt = now;
    session.expiresAt = now + session.ttlMs;
    return true;
  }

  /** Maintenance lookup must not keep an idle provider session alive. */
  peek(id: string, now = Date.now()): ToolSession | null {
    const session = this.sessions.get(id);
    if (!session) return null;
    if (session.expiresAt <= now) {
      this.sessions.delete(id);
      return null;
    }
    return session;
  }

  get(id: string): ToolSession | null {
    const now = Date.now();
    const session = this.peek(id, now);
    if (!session) return null;
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

  get size(): number {
    return this.sessions.size;
  }

  clear(): void {
    this.launcherOwners.clear();
    this.sessions.clear();
  }

  private initialAuthority(context: ToolExecutionContext | undefined, ordinaryOnly = false): ClerkSessionAuthority {
    return ordinaryOnly || toolSessionOrigin.ordinaryOnly ? 'ordinary' : context ? 'unpaired' : 'local';
  }

  private put(id: string, state: BaseThreadState, ttlMs: number, executionContext?: ToolExecutionContext, ordinaryOnly = false): void {
    const now = Date.now();

    this.sessions.set(id, { id, state, clerk: this.initialAuthority(executionContext, ordinaryOnly), createdAt: now, lastUsedAt: now, expiresAt: now + ttlMs, ttlMs, executionContext });
  }
}
