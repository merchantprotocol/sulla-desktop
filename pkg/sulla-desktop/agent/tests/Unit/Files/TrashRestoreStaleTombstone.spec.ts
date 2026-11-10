// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { restoreTrashedFile } from '../../../../../../services/sulla-files/src/databaseOperations';

// Regression: Desktop Files showed a trashed file in Trash, but "Restore" failed with
// "The current version is not a trash tombstone". A write after Trash (upload, sync or
// import) moved files.current_version_id to live content while deleted_at stayed set.
// The Trash list still shows that file, so restore must bring back its latest content.

type Row = Record<string, any>;

const FILE_ID = '5b0c1e2a-7d3f-4a10-9b8e-000000000001';
const COLLECTION_ID = '5b0c1e2a-7d3f-4a10-9b8e-0000000000c1';
const ACTOR = { userId: 'user-1', deviceId: 'device-1', kind: 'server-session' } as any;
const ACCESS = { file: async () => undefined, path: async () => undefined } as any;

class FakeFilesStore {
  readonly versions = new Map<string, Row>();
  file: Row;
  readonly audits: Row[] = [];
  readonly journal: Row[] = [];

  constructor(headVersionId: string, deletedAt: Date | null) {
    this.file = {
      id: FILE_ID, collection_id: COLLECTION_ID, path: '/notes/plan.md', current_version_id: headVersionId,
      deleted_at: deletedAt, size: 0, operation_revision: 7, record_lock_type: 'none',
      checked_out_by_user_id: null, checked_out_by_device_id: null, require_checkout: false, mime: 'text/markdown',
    };
  }

  addVersion(row: Row): void {
    this.versions.set(row.id, { file_id: FILE_ID, chunk_collection_id: COLLECTION_ID, manifest_hash: null, size: 0, deleted: false, parent_version_id: null, restored_from_version_id: null, ...row });
  }

  // Minimal pg surface for restoreTrashedFile: it routes on SQL shape and mutates the in-memory rows.
  makeClient() {
    const store = this;
    return {
      release: () => undefined,
      async query(sql: string, params: any[] = []) {
        const text = sql.replace(/\s+/g, ' ').trim();
        if (/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL)/.test(text)) return { rows: [], rowCount: 0 };
        if (text.startsWith('SELECT * FROM files WHERE id=$1 FOR UPDATE')) return { rows: [{ ...store.file }], rowCount: 1 };
        if (text.startsWith('SELECT * FROM file_versions WHERE id=$1 AND file_id=$2 FOR UPDATE')) {
          const row = store.versions.get(params[0]);
          return row && row.file_id === params[1] ? { rows: [{ ...row, id: params[0] }], rowCount: 1 } : { rows: [], rowCount: 0 };
        }
        if (text.startsWith('SELECT 1 FROM file_roots')) return { rows: [], rowCount: 0 };
        if (text.includes('WITH RECURSIVE lineage')) {
          // Mirrors the SQL: seed row, then walk parents only through tombstones; return first live content with a manifest.
          let id: string | null = params[0];
          while (id) {
            const row = store.versions.get(id);
            if (!row || row.file_id !== params[1]) break;
            if (!row.deleted && row.manifest_hash) return { rows: [{ ...row, id }], rowCount: 1 };
            if (!row.deleted) break;
            id = row.parent_version_id;
          }
          return { rows: [], rowCount: 0 };
        }
        if (text.startsWith('INSERT INTO file_versions')) {
          const id = randomUUID();
          store.versions.set(id, { file_id: params[0], chunk_collection_id: params[1], parent_version_id: params[2], restored_from_version_id: params[3], manifest_hash: params[4], size: params[5], deleted: false });
          return { rows: [{ id }], rowCount: 1 };
        }
        if (text.startsWith('UPDATE chunks')) return { rows: [], rowCount: 0 };
        if (text.startsWith('UPDATE files SET current_version_id=$2,deleted_at=NULL')) {
          if (store.file.deleted_at === null || store.file.current_version_id !== params[3]) return { rows: [], rowCount: 0 };
          store.file = { ...store.file, current_version_id: params[1], deleted_at: null, size: params[2] };
          return { rows: [{ ...store.file }], rowCount: 1 };
        }
        if (text.startsWith('INSERT INTO journal')) { store.journal.push({ op: params[3], version_id: params[2] }); return { rows: [], rowCount: 1 } }
        // 'trash-restore' is a SQL literal here, so the details JSON is the sixth bound parameter.
        if (text.startsWith('INSERT INTO audit_log')) { store.audits.push({ action: 'trash-restore', version_id: params[4], details: params[5] }); return { rows: [], rowCount: 1 } }
        throw new Error(`Unexpected SQL in fake: ${ text.slice(0, 120) }`);
      },
    };
  }

  makeDb() {
    const store = this;
    return {
      async query(sql: string) {
        if (sql.includes('SELECT collection_id FROM files')) return { rows: [{ collection_id: COLLECTION_ID }], rowCount: 1 };
        throw new Error(`Unexpected db.query: ${ sql.slice(0, 80) }`);
      },
      async connect() { return store.makeClient() },
    } as any;
  }
}

const versionId = () => randomUUID();

describe('restoreTrashedFile when the Trash head is no longer a tombstone', () => {
  it('restores the latest live content when a write landed after Trash and the Trash flag is still set', async () => {
    // risk: data loss — the trashed file must come back with its newest content, not fail.
    const oldContent = versionId(); const tombstone = versionId(); const laterContent = versionId();
    const store = new FakeFilesStore(laterContent, new Date('2026-11-09T10:00:00Z'));
    store.addVersion({ id: oldContent, manifest_hash: 'hash-old', size: 10 });
    store.addVersion({ id: tombstone, deleted: true, parent_version_id: oldContent, manifest_hash: null });
    store.addVersion({ id: laterContent, manifest_hash: 'hash-later', size: 20, parent_version_id: tombstone });

    const result = await restoreTrashedFile(store.makeDb(), FILE_ID, ACTOR, ACCESS, { expectedVersionId: laterContent });

    expect(result).toMatchObject({ status: 'restored', kind: 'file', id: FILE_ID, versionId: laterContent });
    expect(store.file.deleted_at).toBeNull();
    expect(store.file.current_version_id).toBe(laterContent);
    // History intact: nothing was added or dropped.
    expect([...store.versions.keys()].sort()).toEqual([oldContent, tombstone, laterContent].sort());
    expect(store.audits.at(-1)).toMatchObject({ action: 'trash-restore', details: { staleTrashFlag: true } });
  });

  it('still restores the pre-Trash version through the tombstone lineage when the head is the tombstone', async () => {
    // risk: data loss — the normal Trash path must keep working and keep history.
    const oldContent = versionId(); const tombstone = versionId();
    const store = new FakeFilesStore(tombstone, new Date('2026-11-09T10:00:00Z'));
    store.addVersion({ id: oldContent, manifest_hash: 'hash-old', size: 10 });
    store.addVersion({ id: tombstone, deleted: true, parent_version_id: oldContent, manifest_hash: null });

    const result = await restoreTrashedFile(store.makeDb(), FILE_ID, ACTOR, ACCESS, { expectedVersionId: tombstone });

    expect(result).toMatchObject({ status: 'restored', versionId: expect.any(String) });
    expect(store.file.deleted_at).toBeNull();
    expect(store.file.current_version_id).not.toBe(tombstone);
    const restored = store.versions.get(store.file.current_version_id)!;
    expect(restored).toMatchObject({ restored_from_version_id: oldContent, parent_version_id: tombstone, manifest_hash: 'hash-old' });
    // The tombstone and the old content are both still there.
    expect(store.versions.has(tombstone)).toBe(true);
    expect(store.versions.has(oldContent)).toBe(true);
  });

  it('reports a clear error only when no live content remains in the file history', async () => {
    // risk: data loss — refuse only when there is truly nothing to bring back, and say so.
    const tombstone = versionId();
    const store = new FakeFilesStore(tombstone, new Date('2026-11-09T10:00:00Z'));
    store.addVersion({ id: tombstone, deleted: true, parent_version_id: null, manifest_hash: null });

    await expect(restoreTrashedFile(store.makeDb(), FILE_ID, ACTOR, ACCESS, { expectedVersionId: tombstone }))
      .rejects.toMatchObject({ status: 409, message: expect.stringContaining('Nothing in this file can be restored') });
    expect(store.file.deleted_at).not.toBeNull();
    expect(store.versions.size).toBe(1);
  });
});
