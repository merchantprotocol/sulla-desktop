// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { PostgresConnection } from '@sulla/foundation/postgres';
import type { InboxCursor } from '@sulla/domain';
import type { OrgMessagingStateRepository, PendingOrgMessage } from '../../services/OrgMessagingStateRepository';

export class PostgresOrgMessagingStateRepository implements OrgMessagingStateRepository {
  constructor(private readonly connection: PostgresConnection) {}

  async enqueue(message: PendingOrgMessage): Promise<void> {
    await this.connection.run(`INSERT INTO org_messaging_outbox(message_id,envelope) VALUES ($1,$2::jsonb) ON CONFLICT(message_id) DO NOTHING`, [message.messageId, message.envelope]);
  }

  async pending(): Promise<PendingOrgMessage[]> {
    return this.connection.select<PendingOrgMessage>(`SELECT message_id AS "messageId", envelope::text AS envelope FROM org_messaging_outbox WHERE sent_at IS NULL ORDER BY created_at,message_id`);
  }

  async markSent(messageId: string): Promise<void> {
    await this.connection.run(`UPDATE org_messaging_outbox SET sent_at=now() WHERE message_id=$1 AND sent_at IS NULL`, [messageId]);
  }

  async cursor(orgId: string, userId: string): Promise<InboxCursor> {
    const rows = await this.connection.select<{ since: number }>(`SELECT since FROM org_messaging_inbox_cursors WHERE org_id=$1 AND user_id=$2`, [orgId, userId]);
    return { orgId, userId, since: rows[0]?.since ?? 0 };
  }

  async advanceCursor(cursor: InboxCursor): Promise<void> {
    await this.connection.run(`INSERT INTO org_messaging_inbox_cursors(org_id,user_id,since) VALUES($1,$2,$3)
      ON CONFLICT(org_id,user_id) DO UPDATE SET since=GREATEST(org_messaging_inbox_cursors.since,EXCLUDED.since),updated_at=now()`, [cursor.orgId, cursor.userId, cursor.since]);
  }
}
