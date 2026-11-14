// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { postgresClient } from '../PostgresClient';

/** Repository for the per-thread subject-memory suppression ledger. */
export class SubjectMemorySentModel {
  async clearThread(threadId: string): Promise<void> {
    await postgresClient.query('DELETE FROM subject_memory.sent WHERE thread_id = $1', [threadId]);
  }

  async activeKeys(threadId: string): Promise<Set<string>> {
    const rows = await postgresClient.query<{ key: string }>(
      'SELECT key FROM subject_memory.sent WHERE thread_id = $1 AND cleared = false', [threadId],
    );
    return new Set(rows.map(row => row.key));
  }

  async record(threadId: string, keys: string[]): Promise<void> {
    if (!keys.length) return;
    await postgresClient.query(
      `INSERT INTO subject_memory.sent(thread_id,key,source)
       SELECT $1,x,'recall' FROM unnest($2::text[]) x
       ON CONFLICT(thread_id,key) DO UPDATE SET cleared=false,sent_at=now(),source='recall'`,
      [threadId, keys],
    );
  }

  async deleteExpiredBatch(limit = 500): Promise<number> {
    const rows = await postgresClient.query<{ thread_id: string }>(`
      WITH stale AS (
        SELECT sent.ctid, sent.thread_id
        FROM subject_memory.sent AS sent
        WHERE sent.cleared OR (
          sent.sent_at < NOW() - INTERVAL '14 days'
          AND NOT EXISTS (
            SELECT 1 FROM subject_memory.sent AS active
            WHERE active.thread_id = sent.thread_id
              AND active.sent_at >= NOW() - INTERVAL '14 days'
          )
        )
        ORDER BY sent.sent_at ASC
        LIMIT $1
      )
      DELETE FROM subject_memory.sent AS sent USING stale WHERE sent.ctid = stale.ctid
      RETURNING sent.thread_id
    `, [limit]);
    return rows.length;
  }
}
