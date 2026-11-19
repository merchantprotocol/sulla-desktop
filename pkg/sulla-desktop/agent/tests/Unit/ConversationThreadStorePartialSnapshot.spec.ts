// SPDX-License-Identifier: GPL-2.0-or-later
// Real SQL on an in-process PostgreSQL (PGlite). The tables mirror the columns the conversations
// store uses (migrations 0019, 0058, 0127, 0128); the store's own statements run unchanged.
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';

import {
  completeSnapshotStillRemovesExplicitly, lostCommitOfPartialIsNotClaimedOrReplayed, partialSnapshotKeepsCanonicalHistory,
  type ScenarioDatabase,
} from '../Support/PartialSnapshotScenarios';

const SCHEMA = `
  CREATE TABLE conversation_history (
    id TEXT PRIMARY KEY, thread_id TEXT, type TEXT NOT NULL, title TEXT, status TEXT DEFAULT 'active',
    message_count INTEGER DEFAULT 0, created_at TIMESTAMPTZ DEFAULT now(), last_active_at TIMESTAMPTZ DEFAULT now(),
    pinned BOOLEAN DEFAULT FALSE, hidden BOOLEAN NOT NULL DEFAULT FALSE, source TEXT, last_message_preview TEXT,
    deleted_at TIMESTAMPTZ, thread_state JSONB
  );
  CREATE TABLE conversation_messages (
    id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversation_history(id) ON DELETE CASCADE,
    seq BIGINT GENERATED ALWAYS AS IDENTITY, role TEXT NOT NULL, content TEXT, tool_calls JSONB, tool_call_id TEXT,
    tool_name TEXT, tool_result JSONB, model TEXT, status TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), deleted_at TIMESTAMPTZ, kind TEXT, turn_id TEXT, position INTEGER, payload JSONB
  );
`;

let pg: PGlite;
const db: ScenarioDatabase = {
  query: async(text: string, params?: any[]) => {
    const result = await pg.query(text, params ?? []);
    return { rows: result.rows as any[], rowCount: result.affectedRows ?? null };
  },
  transaction: async(work, afterCommit) => {
    await pg.query('BEGIN');
    try {
      const result = await work(db);
      await pg.query('COMMIT');
      afterCommit?.();
      return result;
    } catch (error) {
      try { await pg.query('ROLLBACK') } catch { /* already committed */ }
      throw error;
    }
  },
};

beforeAll(async() => { pg = new PGlite() }, 60_000);
afterAll(async() => { await pg?.close() });
beforeEach(async() => {
  await pg.exec('DROP TABLE IF EXISTS conversation_messages; DROP TABLE IF EXISTS conversation_history;');
  await pg.exec(SCHEMA);
});

describe('conversation store write safety for partial browser-cache snapshots (real SQL)', () => {
  it('appends only a new message from a partial snapshot and leaves all canonical rows untouched', async() => {
    await partialSnapshotKeepsCanonicalHistory(db);
  }, 60_000);

  it('soft-deletes only messages explicitly removed', async() => {
    await completeSnapshotStillRemovesExplicitly(db);
  }, 60_000);

  it('does not claim or replay a partial snapshot whose COMMIT reply was lost', async() => {
    await lostCommitOfPartialIsNotClaimedOrReplayed(db);
  }, 60_000);
});
