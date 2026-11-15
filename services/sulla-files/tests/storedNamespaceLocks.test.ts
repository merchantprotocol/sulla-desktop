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

describe('stored namespace locks', () => {
  // risk: unrelated FUSE creates in the same collection must not queue behind one collection-wide exclusive lock.
  it('lets sibling creates use shared parent slots, distinct target locks and a shared collection gate', async () => {
    const first = new AdvisoryLockRecorder();
    const second = new AdvisoryLockRecorder();
    await Promise.all([
      lockStoredNamespace(first.client, 'collection-a', 'alpha/one.txt'),
      lockStoredNamespace(second.client, 'collection-a', 'alpha/two.txt'),
    ]);

    expect(first.statements[0]).toContain('pg_advisory_xact_lock_shared');
    expect(second.statements[0]).toContain('pg_advisory_xact_lock_shared');
    expect(first.values[0]).toEqual(second.values[0]);
    expect(first.values[1]).toEqual(second.values[1]);
    expect(first.statements[1]).toContain('pg_advisory_xact_lock_shared');
    expect(first.values[2]).not.toEqual(second.values[2]);
    expect(first.statements[2]).toContain('pg_advisory_xact_lock(');
  });

  // risk: same-path or file-versus-folder-prefix races must still share a transaction lock.
  it('locks the same target path and immediate parent for competing creates', async () => {
    const first = new AdvisoryLockRecorder();
    const second = new AdvisoryLockRecorder();
    await lockStoredNamespace(first.client, 'collection-a', 'alpha/one.txt');
    await lockStoredNamespace(second.client, 'collection-a', 'alpha/one.txt');
    expect(first.values.slice(1)).toEqual(second.values.slice(1));
  });

  it('shares ancestor path locks for deep file-versus-child namespace races', async () => {
    const file = new AdvisoryLockRecorder();
    const child = new AdvisoryLockRecorder();
    await lockStoredNamespace(file.client, 'collection-a', 'alpha');
    await lockStoredNamespace(child.client, 'collection-a', 'alpha/deep/child.txt');
    const fileKeys = file.values.slice(1).map(values => values[0]);
    const childKeys = child.values.slice(1).map(values => values[0]);
    expect(fileKeys.some(key => childKeys.includes(key))).toBe(true);
  });

  // risk: a broad rename, move or delete must exclude all path-scoped create transactions.
  it('keeps the exclusive collection gate for unscoped namespace mutations', async () => {
    const recorder = new AdvisoryLockRecorder();
    await lockStoredNamespace(recorder.client, 'collection-a');
    expect(recorder.statements).toEqual(['SELECT pg_advisory_xact_lock(hashtextextended($1,0))']);
    const scoped = new AdvisoryLockRecorder();
    await lockStoredNamespace(scoped.client, 'collection-a', 'alpha/one.txt');
    expect(recorder.values[0]).toEqual(scoped.values[0]);
  });
});
