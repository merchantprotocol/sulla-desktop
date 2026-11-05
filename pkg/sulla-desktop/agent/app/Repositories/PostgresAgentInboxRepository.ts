// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { PostgresConnection } from '@sulla/foundation/postgres';
import type { AgentInboxEntry, AgentInboxRepository, AgentInboxTarget, AgentMessageKind } from '../../services/AgentInbox';

export class PostgresAgentInboxRepository implements AgentInboxRepository {
  constructor(private readonly connection: PostgresConnection) {}

  async enqueue(entry: AgentInboxEntry): Promise<boolean> {
    const rows = await this.connection.select<{ message_id: string }>(
      `INSERT INTO agent_inbox_messages
         (message_id, receiver_channel, receiver_thread_id, sender, kind, body, ids)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       ON CONFLICT (message_id) DO NOTHING RETURNING message_id`,
      [entry.envelope.ids.messageId, entry.target.channel, entry.target.threadId ?? null,
        entry.envelope.from, entry.envelope.kind, entry.envelope.body, JSON.stringify(entry.envelope.ids)],
    );
    return Boolean(rows?.length);
  }

  async pending(target: AgentInboxTarget): Promise<AgentInboxEntry[]> {
    const rows = await this.connection.select<any>(
      `SELECT * FROM agent_inbox_messages
        WHERE receiver_channel = $1 AND delivered_at IS NULL
          AND ($2::text IS NULL OR receiver_thread_id = $2 OR receiver_thread_id IS NULL)
        ORDER BY created_at, message_id`,
      [target.channel, target.threadId ?? null],
    );
    return (rows ?? []).map(row => ({
      target: { channel: row.receiver_channel, threadId: row.receiver_thread_id ?? target.threadId },
      envelope: { from: row.sender, kind: row.kind as AgentMessageKind, body: row.body, ids: row.ids },
    }));
  }

  async markDelivered(messageIds: string[]): Promise<void> {
    if (!messageIds.length) return;
    await this.connection.run(
      'UPDATE agent_inbox_messages SET delivered_at = now() WHERE message_id = ANY($1::text[]) AND delivered_at IS NULL',
      [messageIds as unknown as string],
    );
  }
}
