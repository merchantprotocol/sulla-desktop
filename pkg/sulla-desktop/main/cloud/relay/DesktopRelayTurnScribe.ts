// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { DesktopRelayHistoryPorts, DesktopRelayLog, ScopedRelayBinding, ScopedRelayRunBinding } from './DesktopRelayPorts';

export type RelayTurnRole = 'user' | 'assistant' | 'tool';

/**
 * Writes committed relay turns to the sync log (local claude_messages +
 * sync_queue push). The desktop is the system of record for relay
 * conversations: turns are scribed independently of WebSocket delivery, so a
 * phone that was asleep recovers them from history. Propagate commit errors
 * so committed live frames never advertise unsaved data.
 */
export class DesktopRelayTurnScribe {
  constructor(
    private readonly history: DesktopRelayHistoryPorts,
    _log: DesktopRelayLog,
  ) {}

  async scribe(conversationId: string | undefined, role: RelayTurnRole, content: string, opts?: { id?: string, ts?: string, delivery?: ScopedRelayRunBinding & { run: string } }): Promise<void> {
    if (!conversationId || !content.trim()) return;
    await this.history.scribe({
      conversationId, role, content, ts: opts?.ts ?? new Date().toISOString(), id: opts?.id, ...(opts?.delivery ? { delivery: opts.delivery } : {}),
    });
  }

  deriveId(conversationId: string, role: RelayTurnRole, content: string, ts: string): string {
    return this.history.deriveMessageId(conversationId, role, content, ts);
  }

  /** Scribe a turn under a freshly derived id and return that id, so mobile persists the same row. */
  async scribeDerived(conversationId: string, role: RelayTurnRole, content: string): Promise<string> {
    const ts = new Date().toISOString();
    const id = this.deriveId(conversationId, role, content, ts);
    await this.scribe(conversationId, role, content, { id, ts });
    return id;
  }

  acceptUserTurn(conversationId: string, id: string, content: string, scope?: ScopedRelayBinding, delivery?: ScopedRelayRunBinding & { run: string }): ReturnType<DesktopRelayHistoryPorts['acceptUserTurn']> {
    return this.history.acceptUserTurn({ conversationId, role: 'user', content, id, ts: new Date().toISOString(), ...(scope ? { scope } : {}), ...(delivery ? { delivery } : {}) });
  }
}
