// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

export type AgentMessageKind = 'human' | 'parent' | 'child' | 'peer' | 'contract' | 'blocker';

export interface AgentMessageEnvelope {
  from: string;
  kind: AgentMessageKind;
  body: string;
  ids: { messageId: string; jobId?: string; taskIndex?: number; threadId?: string };
}

export interface AgentInboxTarget { channel: string; threadId?: string }
export interface AgentInboxEntry { envelope: AgentMessageEnvelope; target: AgentInboxTarget }

export interface AgentInboxRepository {
  enqueue(entry: AgentInboxEntry): Promise<boolean>;
  pending(target: AgentInboxTarget): Promise<AgentInboxEntry[]>;
  markDelivered(messageIds: string[]): Promise<void>;
}

export interface AgentInboxDeliveryPolicy {
  isRunning(target: AgentInboxTarget): boolean;
  wake(target: AgentInboxTarget, batch: string, entries: AgentInboxEntry[]): Promise<void>;
}

/** Durable, deduplicated mailbox. It never interrupts an active receiver. */
export class AgentInbox {
  private readonly delivering = new Set<string>();

  constructor(
    private readonly repository: AgentInboxRepository,
    private readonly delivery: AgentInboxDeliveryPolicy,
  ) {}

  async receive(entry: AgentInboxEntry): Promise<'duplicate' | 'queued' | 'delivered'> {
    const inserted = await this.repository.enqueue(entry);
    if (!inserted) return 'duplicate';
    if (this.delivery.isRunning(entry.target)) return 'queued';
    await this.flush(entry.target);
    return 'delivered';
  }

  async flush(target: AgentInboxTarget): Promise<number> {
    const key = `${ target.channel }|${ target.threadId ?? '' }`;
    if (this.delivering.has(key) || this.delivery.isRunning(target)) return 0;
    this.delivering.add(key);
    try {
      const entries = await this.repository.pending(target);
      if (!entries.length) return 0;
      await this.delivery.wake(target, this.render(entries), entries);
      await this.repository.markDelivered(entries.map(entry => entry.envelope.ids.messageId));
      return entries.length;
    } finally {
      this.delivering.delete(key);
    }
  }

  render(entries: AgentInboxEntry[]): string {
    return entries.map(({ envelope }) => {
      const label = envelope.kind === 'peer'
        ? `Peer message from ${ envelope.from }`
        : `${ envelope.kind } message from ${ envelope.from }`;
      return `[${ label }]\n${ envelope.body }`;
    }).join('\n\n==========\n\n');
  }
}
