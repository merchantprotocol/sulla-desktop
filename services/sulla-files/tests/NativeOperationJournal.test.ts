// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Characterizes native operation journal recovery (record a committed snapshot, replay it after a
// crash) and the legacy stored move/copy, against a real Postgres. Point SULLA_FILES_TEST_DATABASE_URL
// at a throwaway database. Each run creates and drops its own schema and applies the real migrations.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FilesIdentity } from '../src/auth.js';
import { migrate } from '../src/db.js';
import { applyDatabaseFileOperations, FileOperationConflict } from '../src/fileOperations.js';
import { NativeOperationJournal } from '../src/nativeOperationJournal.js';
import { NativeOperationJournalRepository } from '../src/Repositories/NativeOperationJournalRepository.js';
import { OperationCancellationRegistry } from '../src/Services/OperationCancellationRegistry.js';

const databaseUrl = process.env.SULLA_FILES_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('native operation journal and stored file operations (real Postgres)', () => {
  const schema = `files_journal_spec_${ randomUUID().replaceAll('-', '') }`;
  const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  let pool:pg.Pool;
  const actor:FilesIdentity = { userId: 'journal-user', deviceId: 'journal-device', kind: 'capability' };
  const rows = new NativeOperationJournalRepository();
  let collectionId = '';
  let otherCollectionId = '';
  // No native root is attached in these specs: every collection resolves to "stored only".
  const journal = () => new NativeOperationJournal(pool, async() => null, async() => undefined, async() => { throw new Error('unused') }, new OperationCancellationRegistry());

  beforeAll(async() => {
    await admin.query(`CREATE SCHEMA ${ schema }`);
    pool = new pg.Pool({ connectionString: databaseUrl, max: 3, options: `-csearch_path=${ schema },public` });
    await migrate(pool);
  }, 60_000);
  afterAll(async() => { await pool?.end(); await admin.query(`DROP SCHEMA IF EXISTS ${ schema } CASCADE`); await admin.end() });
  beforeEach(async() => {
    collectionId = randomUUID(); otherCollectionId = randomUUID();
    for (const id of [collectionId, otherCollectionId]) {
      // A unique explorer_path per collection: published collections of one owner share a unique index on it.
      await pool.query(`INSERT INTO collections(id,owner_user_id,name,kind,home,encrypted_data_key,dedup_key_ciphertext,retention_policy,published,legacy_source,explorer_path)
        VALUES($1,$2,'Files','knowledge','desktop-only','{}','{}','{}',TRUE,FALSE,$3)`, [id, actor.userId, id]);
    }
  });

  async function seedFile(path:string):Promise<{ id:string; versionId:string }> {
    const hash = `journal-${ randomUUID() }`;
    await pool.query(`INSERT INTO manifests(hash,chunk_ids,total_size) VALUES($1,'[]'::jsonb,0)`, [hash]);
    const file = (await pool.query(`INSERT INTO files(collection_id,path,created_by_type,created_by_id) VALUES($1,$2,'user',$3) RETURNING id`, [collectionId, path, actor.userId])).rows[0];
    const version = (await pool.query(`INSERT INTO file_versions(file_id,chunk_collection_id,manifest_hash,size,created_by_type,created_by_id,device_id)
      VALUES($1,$2,$3,0,'user',$4,'journal-device') RETURNING id`, [file.id, collectionId, hash, actor.userId])).rows[0];
    await pool.query('UPDATE files SET current_version_id=$2 WHERE id=$1', [file.id, version.id]);
    return { id: file.id, versionId: version.id };
  }

  /** Records a cross-collection (version 3) journal row whose committed snapshot is the file as it is now. */
  async function recordCrossOperation(fileId:string, state:string):Promise<string> {
    const operationId = randomUUID();
    const captured = await rows.capture(pool, [fileId], []);
    const committed = { fileIds: [fileId], folderIds: [], ...captured };
    const plan = { version: 3, receiptId: operationId, sourceCollectionId: collectionId, targetCollectionId: otherCollectionId, operationId, itemId: operationId,
      leaves: [], watched: [], committed, inverseCommitted: committed };
    await pool.query("INSERT INTO files_path_operations(operation_id,action,state,plan) VALUES($1,'move',$2,$3)", [operationId, state, plan]);
    return operationId;
  }
  const stateOf = async(operationId:string) => (await pool.query('SELECT state,last_error FROM files_path_operations WHERE operation_id=$1', [operationId])).rows[0];
  const replay = async(operationId:string) => journal().recover((await pool.query('SELECT * FROM files_path_operations WHERE operation_id=$1', [operationId])).rows[0]);

  // risk: data loss — a crash after the database commit must finish as completed only when the database still matches the record.
  it('replays a db-committed operation to completed when the committed snapshot still matches', async() => {
    const file = await seedFile('docs/a.md');
    const operationId = await recordCrossOperation(file.id, 'db-committed');
    await replay(operationId);
    expect(await stateOf(operationId)).toEqual({ state: 'completed', last_error: null });
  });

  // risk: data loss — drift after the commit must stop recovery (recovery-required) and leave the row for reconciliation.
  it('refuses to complete a db-committed operation whose files drifted after the commit', async() => {
    const file = await seedFile('docs/b.md');
    const operationId = await recordCrossOperation(file.id, 'db-committed');
    await pool.query("UPDATE files SET path='docs/moved-elsewhere.md' WHERE id=$1", [file.id]);
    await expect(replay(operationId)).rejects.toMatchObject({ status: 409, code: 'recovery-required' });
    expect((await stateOf(operationId)).state).toBe('db-committed');
  });

  // risk: irreversible side effect — an interrupted publish rolls back; an interrupted undo commit finishes as undone.
  it('rolls back an interrupted publish and finishes an undo that reached its database commit', async() => {
    const file = await seedFile('docs/c.md');
    const publishing = await recordCrossOperation(file.id, 'publishing');
    await replay(publishing);
    expect((await stateOf(publishing)).state).toBe('rolled-back');
    const undoCommitted = await recordCrossOperation(file.id, 'undo-db-committed');
    await replay(undoCommitted);
    expect((await stateOf(undoCommitted)).state).toBe('undone');
  });

  // risk: irreversible side effect — disposal only ever touches artifacts of an invalidated Trash receipt.
  it('disposes nothing without a journal row and refuses rows that were never invalidated', async() => {
    expect(await journal().dispose(randomUUID())).toEqual({ state: 'none' });
    const file = await seedFile('docs/d.md');
    const operationId = randomUUID();
    await pool.query("INSERT INTO files_path_operations(operation_id,action,state,plan) VALUES($1,'trash','completed',$2)", [operationId,
      { version: 2, rootId: 'root', collectionId, operationId, itemId: operationId, leaves: [], watched: [], committed: { fileIds: [file.id], folderIds: [], files: [], folders: [], watched: [] } }]);
    await expect(journal().dispose(operationId)).rejects.toMatchObject({ code: 'recovery-required' });
  });

  // risk: data accuracy — a stored move carries the file, its folder and the folder's grants to the new path.
  it('moves a stored folder with its file and folder grants in one transaction', async() => {
    const file = await seedFile('src/a.md');
    await pool.query("INSERT INTO file_folders(collection_id,path,created_by_id) VALUES($1,'src',$2)", [collectionId, actor.userId]);
    await pool.query("INSERT INTO folder_shares(collection_id,folder_path,principal_type,principal_id,role,created_by) VALUES($1,'src','user','friend','view',$2)", [collectionId, actor.userId]);
    const row = (await pool.query('SELECT * FROM files WHERE id=$1', [file.id])).rows[0];
    const [moved] = await applyDatabaseFileOperations(pool, 'move', [{ file: row, targetPath: 'dst/a.md' }], actor, [{ collectionId, sourcePath: 'src', targetPath: 'dst' }]);
    expect(moved).toMatchObject({ id: file.id, path: 'dst/a.md' });
    expect((await pool.query('SELECT path FROM file_folders WHERE collection_id=$1 ORDER BY path', [collectionId])).rows.map(r => r.path)).toEqual(['dst']);
    expect((await pool.query('SELECT folder_path FROM folder_shares WHERE collection_id=$1', [collectionId])).rows).toEqual([{ folder_path: 'dst' }]);
    expect((await pool.query("SELECT op FROM journal WHERE file_id=$1 AND op='rename'", [file.id])).rowCount).toBe(1);
  });

  // risk: data loss — two items with one destination, or a source that changed since it was shown, are refused with nothing written.
  it('refuses duplicate destinations and changes nothing when a selected file changed', async() => {
    const a = await seedFile('x/a.md'); const b = await seedFile('x/b.md');
    const [rowA, rowB] = (await pool.query('SELECT * FROM files WHERE id=ANY($1::uuid[]) ORDER BY path', [[a.id, b.id]])).rows;
    await expect(applyDatabaseFileOperations(pool, 'move', [{ file: rowA, targetPath: 'y.md' }, { file: rowB, targetPath: 'y.md' }], actor)).rejects.toBeInstanceOf(FileOperationConflict);
    await expect(applyDatabaseFileOperations(pool, 'copy', [{ file: rowA, targetPath: 'y/a.md' }, { file: { ...rowB, path: 'x/stale.md' }, targetPath: 'y/b.md' }], actor)).rejects.toMatchObject({ status: 409 });
    expect((await pool.query("SELECT 1 FROM files WHERE collection_id=$1 AND path LIKE 'y/%'", [collectionId])).rowCount).toBe(0);
  });
});
