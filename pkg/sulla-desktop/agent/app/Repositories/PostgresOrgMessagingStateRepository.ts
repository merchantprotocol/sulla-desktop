// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { PostgresConnection } from '@sulla/foundation/postgres';
import type { InboxCursor } from '@sulla/domain';
import type { OrgMessagingStateRepository, PendingOrgMessage } from '../../services/OrgMessagingStateRepository';

export class PostgresOrgMessagingStateRepository implements OrgMessagingStateRepository {
  constructor(private readonly connection: PostgresConnection) {}

  async enqueue(message: PendingOrgMessage): Promise<void> {
    await this.connection.run(`INSERT INTO org_messaging_outbox(org_id,message_id,envelope) VALUES ($1,$2,$3::jsonb) ON CONFLICT(org_id,message_id) DO NOTHING`, [message.orgId, message.messageId, message.envelope]);
  }

  async pending(orgId: string): Promise<PendingOrgMessage[]> {
    return this.connection.select<PendingOrgMessage>(`SELECT org_id AS "orgId", message_id AS "messageId", envelope::text AS envelope FROM org_messaging_outbox
      WHERE org_id=$1 AND sent_at IS NULL AND failed_at IS NULL ORDER BY created_at,message_id`, [orgId]);
  }

  async markSent(orgId: string, messageId: string): Promise<void> {
    await this.connection.run(`UPDATE org_messaging_outbox SET sent_at=now() WHERE org_id=$1 AND message_id=$2 AND sent_at IS NULL`, [orgId, messageId]);
  }

  async markFailed(orgId: string, messageId: string, reason: string): Promise<void> {
    await this.connection.run(`UPDATE org_messaging_outbox SET failed_at=now(),failure_reason=$3 WHERE org_id=$1 AND message_id=$2 AND sent_at IS NULL AND failed_at IS NULL`, [orgId, messageId, reason]);
  }

  async cursor(orgId: string, userId: string): Promise<InboxCursor> {
    const rows = await this.connection.select<{ since: number }>(`SELECT since FROM org_messaging_inbox_cursors WHERE org_id=$1 AND user_id=$2`, [orgId, userId]);
    return { orgId, userId, since: rows[0]?.since ?? 0 };
  }

  async advanceCursor(cursor: InboxCursor): Promise<void> {
    await this.connection.run(`INSERT INTO org_messaging_inbox_cursors(org_id,user_id,since) VALUES($1,$2,$3)
      ON CONFLICT(org_id,user_id) DO UPDATE SET since=GREATEST(org_messaging_inbox_cursors.since,EXCLUDED.since),updated_at=now()`, [cursor.orgId, cursor.userId, cursor.since]);
  }

  async lastContactPrompt(orgId: string, userId: string, senderUserId: string): Promise<number | undefined> {
    const rows = await this.connection.select<{ askedAt: string | number }>(`SELECT (EXTRACT(EPOCH FROM last_asked_at)*1000)::bigint AS "askedAt" FROM org_messaging_contact_prompts WHERE org_id=$1 AND user_id=$2 AND sender_user_id=$3`, [orgId, userId, senderUserId]);
    return rows[0] ? Number(rows[0].askedAt) : undefined;
  }

  async recordContactPrompt(orgId: string, userId: string, senderUserId: string, askedAt: number): Promise<void> {
    await this.connection.run(`INSERT INTO org_messaging_contact_prompts(org_id,user_id,sender_user_id,last_asked_at) VALUES($1,$2,$3,to_timestamp($4/1000.0))
      ON CONFLICT(org_id,user_id,sender_user_id) DO UPDATE SET last_asked_at=EXCLUDED.last_asked_at`, [orgId, userId, senderUserId, askedAt]);
  }
}
