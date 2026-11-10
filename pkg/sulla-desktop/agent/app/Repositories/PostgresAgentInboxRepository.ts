// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { PostgresConnection } from '@sulla/foundation/postgres';
import type { AgentInboxClaim, AgentInboxEntry, AgentInboxRepository, AgentInboxTarget, AgentMessageKind } from '../../services/AgentInbox';

const LEASE_SECONDS = 120;

export class PostgresAgentInboxRepository implements AgentInboxRepository {
  constructor(private readonly connection: PostgresConnection) {}
  async enqueue(entry: AgentInboxEntry): Promise<boolean> {
    const rows = await this.connection.select<{ message_id: string }>(`INSERT INTO agent_inbox_messages
      (message_id,receiver_channel,receiver_thread_id,receiver_agent_id,sender,kind,body,ids)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT(message_id) DO NOTHING RETURNING message_id`,
    [entry.envelope.ids.messageId, entry.target.channel, entry.target.threadId ?? null, entry.target.agentId ?? null, entry.envelope.from, entry.envelope.kind, entry.envelope.body, JSON.stringify(entry.envelope.ids)]);
    return Boolean(rows?.length);
  }
  async claim(target: AgentInboxTarget, owner: string): Promise<AgentInboxClaim> {
    const rows = await this.connection.select<any>(`WITH candidates AS (
      SELECT message_id FROM agent_inbox_messages WHERE receiver_channel=$1 AND delivered_at IS NULL
        AND ($2::text IS NULL OR receiver_thread_id=$2 OR receiver_thread_id IS NULL)
        AND (lease_expires_at IS NULL OR lease_expires_at<now()) ORDER BY created_at,message_id FOR UPDATE SKIP LOCKED)
      UPDATE agent_inbox_messages inbox SET lease_owner=$3,lease_expires_at=now()+($4*interval '1 second')
      FROM candidates WHERE inbox.message_id=candidates.message_id RETURNING inbox.*`, [target.channel, target.threadId ?? null, owner, LEASE_SECONDS]);
    return { owner, target, entries: rows.map(row => this.map(row, target)) };
  }
  async acknowledge(claim: AgentInboxClaim): Promise<void> {
    await this.connection.run(`UPDATE agent_inbox_messages SET delivered_at=now(),lease_owner=NULL,lease_expires_at=NULL
      WHERE message_id=ANY($1::text[]) AND lease_owner=$2 AND delivered_at IS NULL`, [claim.entries.map(e => e.envelope.ids.messageId) as unknown as string, claim.owner]);
  }
  async renew(claim: AgentInboxClaim): Promise<void> {
    await this.connection.run(`UPDATE agent_inbox_messages SET lease_expires_at=now()+($3*interval '1 second')
      WHERE message_id=ANY($1::text[]) AND lease_owner=$2 AND delivered_at IS NULL`, [claim.entries.map(e => e.envelope.ids.messageId) as unknown as string, claim.owner, LEASE_SECONDS]);
  }
  async release(claim: AgentInboxClaim): Promise<void> {
    await this.connection.run(`UPDATE agent_inbox_messages SET lease_owner=NULL,lease_expires_at=NULL
      WHERE message_id=ANY($1::text[]) AND lease_owner=$2 AND delivered_at IS NULL`, [claim.entries.map(e => e.envelope.ids.messageId) as unknown as string, claim.owner]);
  }
  async pendingTargets(): Promise<AgentInboxTarget[]> {
    const rows = await this.connection.select<any>(`SELECT DISTINCT receiver_channel,receiver_thread_id,receiver_agent_id FROM agent_inbox_messages
      WHERE delivered_at IS NULL AND (lease_expires_at IS NULL OR lease_expires_at<now())`);
    return rows.map(row => ({ channel: row.receiver_channel, threadId: row.receiver_thread_id ?? undefined, agentId: row.receiver_agent_id ?? undefined }));
  }
  private map(row: any, fallback: AgentInboxTarget): AgentInboxEntry {
    return { target: { channel: row.receiver_channel, threadId: row.receiver_thread_id ?? fallback.threadId, agentId: row.receiver_agent_id ?? fallback.agentId },
      envelope: { from: row.sender, kind: row.kind as AgentMessageKind, body: row.body, ids: row.ids } };
  }
}
