// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';
import type pg from 'pg';
import { lockStoredNamespace } from '../src/storedNamespace.js';

class AdvisoryLockRecorder {
  readonly statements:string[] = [];
  readonly values:unknown[][] = [];

  readonly client = {
    query: async (sql:string, values:unknown[] = []) => {
      this.statements.push(sql);
      this.values.push(values);
      return { rows:[], rowCount:0 };
    },
  } as unknown as pg.PoolClient;
}

// The real-Postgres behaviour (siblings hold the gate together, conflicts wait, no deadlock against the
// namespace trigger) is proven in StoredNamespaceConcurrency.test.ts. These pin the calls the gate makes.
describe('stored namespace locks', () => {
  // risk: concurrent creates must not deadlock against the namespace trigger (migrations 027/067). A scoped
  // create takes the collection key shared plus its path slots AND declares its scope in one call, so the
  // trigger never upgrades the shared key to exclusive (the deadlock 33378a49d worked around by serializing).
  it('takes the scoped gate and declares the scope in one call per create', async () => {
    const first = new AdvisoryLockRecorder();
    const second = new AdvisoryLockRecorder();
    await Promise.all([
      lockStoredNamespace(first.client, 'collection-a', 'alpha/one.txt'),
      lockStoredNamespace(second.client, 'collection-a', 'alpha/two.txt'),
    ]);
    expect(first.statements).toEqual(['SELECT files_lock_namespace_scope($1,$2)']);
    expect(first.values).toEqual([['collection-a', 'alpha/one.txt']]);
    expect(second.values).toEqual([['collection-a', 'alpha/two.txt']]);
  });

  // risk: two spellings of one collection id must take the same keys and declare the scope the trigger matches.
  it('normalizes the collection id to the canonical lowercase uuid text', async () => {
    const upper = new AdvisoryLockRecorder();
    await lockStoredNamespace(upper.client, 'ABCDEF01-0000-4000-8000-00000000000A', 'alpha/one.txt');
    expect(upper.values).toEqual([['abcdef01-0000-4000-8000-00000000000a', 'alpha/one.txt']]);
  });

  // risk: a broad rename, move or delete must exclude all path-scoped create transactions.
  it('keeps the exclusive collection gate for unscoped namespace mutations', async () => {
    const recorder = new AdvisoryLockRecorder();
    await lockStoredNamespace(recorder.client, 'collection-a');
    expect(recorder.statements).toEqual(['SELECT pg_advisory_xact_lock(hashtextextended($1,0))']);
    expect(recorder.values).toEqual([['stored-namespace:collection-a']]);
  });
});
