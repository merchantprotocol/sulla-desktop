// SPDX-License-Identifier: GPL-2.0-or-later
// The same write-safety scenarios on the real migrated PostgreSQL test database (root-run fixture).
import { afterAll, beforeAll, describe, it } from 'vitest';

import {
  completeSnapshotStillRemovesExplicitly, lostCommitOfPartialIsNotClaimedOrReplayed, partialSnapshotKeepsCanonicalHistory,
  type ScenarioDatabase,
} from '../../Support/PartialSnapshotScenarios';
import { TestDatabase } from '../../Support/TestDatabase';

const dbDescribe = TestDatabase.available() ? describe : describe.skip;

dbDescribe('conversation store partial snapshot write safety on the migrated database', () => {
  const database = new TestDatabase();
  let pool: import('pg').Pool;
  const db: ScenarioDatabase = {
    query: async(text: string, params?: any[]) => {
      const result = await pool.query(text, params ?? []);
      return { rows: result.rows, rowCount: result.rowCount };
    },
    transaction: async(work, afterCommit) => {
      const client = await pool.connect();
      const scoped = { query: async(text: string, params?: any[]) => { const r = await client.query(text, params ?? []); return { rows: r.rows, rowCount: r.rowCount } } };
      try {
        await client.query('BEGIN');
        const result = await work(scoped);
        await client.query('COMMIT');
        afterCommit?.();
        return result;
      } catch (error) {
        try { await client.query('ROLLBACK') } catch { /* already committed */ }
        throw error;
      } finally { client.release() }
    },
  };

  beforeAll(async() => {
    await database.initialize();
    const { Pool } = await import('pg');
    pool = new Pool({ connectionString: database.appUrl(), max: 2 });
    await pool.query(`DELETE FROM conversation_history WHERE id IN ('T', 'O', 'C', 'L')`);
  }, 60_000);
  afterAll(async() => {
    await pool?.query(`DELETE FROM conversation_history WHERE id IN ('T', 'O', 'C', 'L')`).catch(() => undefined);
    await pool?.end();
    await database.dispose();
  });

  it('appends only a new message from a partial snapshot and leaves all canonical rows untouched', async() => {
    await partialSnapshotKeepsCanonicalHistory(db);
  }, 60_000);

  it('still soft-deletes exactly the message an authoritative complete snapshot removed', async() => {
    await completeSnapshotStillRemovesExplicitly(db);
  }, 60_000);

  it('does not claim or replay a partial snapshot whose COMMIT reply was lost', async() => {
    await lostCommitOfPartialIsNotClaimedOrReplayed(db);
  }, 60_000);
});
