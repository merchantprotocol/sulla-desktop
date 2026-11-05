// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { AgentInboxTarget } from './AgentInbox';

export interface ReceiverRunReservation { release(): void }

/**
 * Serializes inbox-owned graph turns for one receiver in the Electron main
 * process. Desktop currently has exactly one agent-job/graph writer process;
 * Postgres claims remain the crash/restart safety net. If that architecture
 * becomes multi-writer, this guard must be paired with a Postgres advisory
 * lock keyed by receiver.
 */
export class ReceiverRunGuard {
  private readonly active = new Set<string>();

  isActive(target: AgentInboxTarget): boolean {
    return this.active.has(this.key(target));
  }

  tryReserve(target: AgentInboxTarget): ReceiverRunReservation | undefined {
    const key = this.key(target);
    if (this.active.has(key)) return undefined;
    this.active.add(key);
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.active.delete(key);
      },
    };
  }

  private key(target: AgentInboxTarget): string {
    return `${ target.channel }|${ target.threadId ?? '' }`;
  }
}
