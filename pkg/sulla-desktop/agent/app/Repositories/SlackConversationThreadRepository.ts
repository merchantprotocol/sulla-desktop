// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { postgresClient } from '../../database/PostgresClient';

/** Owns persistence of stable Slack thread headers in conversation_history. */
export class SlackConversationThreadRepository {
  constructor(private readonly db = postgresClient) {}

  async ensureThread(threadId: string, title: string): Promise<void> {
    await this.db.queryOne(
      `INSERT INTO conversation_history (id, thread_id, type, title, status, hidden, source, message_count, created_at, last_active_at)
       VALUES ($1,$1,'chat',$2,'active',FALSE,'slack',0,now(),now())
       ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title, hidden=FALSE, source='slack'`,
      [threadId, title],
    );
  }
}
