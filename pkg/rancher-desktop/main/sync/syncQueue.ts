/**
 * Sync queue — pending local mutations waiting to be pushed to sulla-workers.
 *
 * Mirror of sulla-mobile/src/db/sync-queue.ts so push/pull semantics match
 * on both sides of the pipeline. When a table row changes locally, call
 * enqueueSyncOp() to record the intent; the SullaSyncService periodically
 * drains the queue via getPendingOps() → push → clearOps().
 */

import crypto from 'crypto';

import { postgresClient } from '@pkg/agent/database/PostgresClient';

function generateId(): string {
  return crypto.randomUUID();
}

/**
 * Record an upsert or delete intent against a local row so it will be
 * pushed to the cloud on the next sync cycle. The (table_name, record_key)
 * uniqueness means multiple edits to the same entity before a successful
 * push collapse into a single op with the latest intent.
 */
export async function enqueueSyncOp(
  tableName: string,
  recordKey: Record<string, unknown>,
  operation: 'upsert' | 'delete',
): Promise<void> {
  try {
    const keyJson = JSON.stringify(recordKey);
    await postgresClient.query(
      `INSERT INTO sync_queue (id, table_name, record_key, operation)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (table_name, record_key) DO UPDATE SET
         operation = EXCLUDED.operation,
         created_at = CURRENT_TIMESTAMP`,
      [generateId(), tableName, keyJson, operation],
    );
  } catch (err) {
    console.warn('[SyncQueue] enqueue failed:', { tableName, operation, error: String(err) });
  }
}

export interface SyncQueueEntry {
  id:         string;
  table_name: string;
  record_key: string;
  operation:  'upsert' | 'delete';
  created_at: string;
}

export async function getPendingOps(limit = 500): Promise<SyncQueueEntry[]> {
  return postgresClient.query<SyncQueueEntry>(
    `SELECT id, table_name, record_key, operation, created_at
     FROM sync_queue
     ORDER BY created_at ASC
     LIMIT $1`,
    [limit],
  );
}

export async function clearOps(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const placeholders = ids.map((_, i) => `$${ i + 1 }`).join(',');
  await postgresClient.query(
    `DELETE FROM sync_queue WHERE id IN (${ placeholders })`,
    ids,
  );
}

export async function pendingCount(): Promise<number> {
  const rows = await postgresClient.query<{ count: string }>(
    'SELECT COUNT(*)::text as count FROM sync_queue',
  );
  return Number(rows[0]?.count ?? 0);
}
