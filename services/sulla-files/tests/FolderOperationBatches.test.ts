// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Characterizes the receipt-backed batch API (submit/run/control/undo, folder move and Trash, folder
// restore, cooperative cancellation) against a real Postgres. Point SULLA_FILES_TEST_DATABASE_URL at a
// throwaway database. Each run creates and drops its own schema and applies the real migrations.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FilesIdentity } from '../src/auth.js';
import { migrate } from '../src/db.js';
import { controlDatabaseBatch, getDatabaseBatch, parseDatabaseBatch, runDatabaseBatch, submitDatabaseBatch } from '../src/databaseOperationBatches.js';
import { restoreTrashedFile, trashFileWithoutReceipt } from '../src/databaseOperations.js';
import { restoreTrashedFolder } from '../src/folderOperationBatches.js';
import { OperationCancellationRegistry } from '../src/Services/OperationCancellationRegistry.js';

const databaseUrl = process.env.SULLA_FILES_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('database operation batches (real Postgres)', () => {
  const schema = `files_dbops_spec_${ randomUUID().replaceAll('-', '') }`;
  const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  let pool:pg.Pool;
  const actor:FilesIdentity = { userId: 'dbops-user', deviceId: 'dbops-device', kind: 'capability' };
  let onFile:(fileId:string) => void = () => undefined;
  const access = { file: async(_client:pg.PoolClient, fileId:string) => { onFile(fileId) }, path: async() => undefined };
  let collectionId = '';

  beforeAll(async() => {
    await admin.query(`CREATE SCHEMA ${ schema }`);
    pool = new pg.Pool({ connectionString: databaseUrl, max: 4, options: `-csearch_path=${ schema },public` });
    await migrate(pool);
  }, 60_000);
  afterAll(async() => { await pool?.end(); await admin.query(`DROP SCHEMA IF EXISTS ${ schema } CASCADE`); await admin.end() });
  beforeEach(async() => {
    onFile = () => undefined;
    collectionId = randomUUID();
    await pool.query(`INSERT INTO collections(id,owner_user_id,name,kind,home,encrypted_data_key,dedup_key_ciphertext,retention_policy,published,legacy_source)
      VALUES($1,$2,'Files','knowledge','desktop-only','{}','{}','{}',TRUE,FALSE)`, [collectionId, actor.userId]);
  });

  async function seedFile(path:string):Promise<{ id:string; versionId:string }> {
    const hash = `dbops-${ randomUUID() }`;
    await pool.query(`INSERT INTO manifests(hash,chunk_ids,total_size) VALUES($1,'[]'::jsonb,0)`, [hash]);
    const file = (await pool.query(`INSERT INTO files(collection_id,path,created_by_type,created_by_id) VALUES($1,$2,'user',$3) RETURNING id`, [collectionId, path, actor.userId])).rows[0];
    const version = (await pool.query(`INSERT INTO file_versions(file_id,chunk_collection_id,manifest_hash,size,created_by_type,created_by_id,device_id)
      VALUES($1,$2,$3,0,'user',$4,'dbops-device') RETURNING id`, [file.id, collectionId, hash, actor.userId])).rows[0];
    await pool.query('UPDATE files SET current_version_id=$2 WHERE id=$1', [file.id, version.id]);
    return { id: file.id, versionId: version.id };
  }
  const filesIn = async(collection = collectionId) => (await pool.query('SELECT id,path,deleted_at IS NOT NULL AS deleted FROM files WHERE collection_id=$1 ORDER BY path', [collection])).rows;
  const foldersIn = async() => (await pool.query('SELECT id,path,deleted_at IS NOT NULL AS deleted FROM file_folders WHERE collection_id=$1 ORDER BY path', [collectionId])).rows;
  async function folderBatch(item:Record<string, unknown>) {
    const input = parseDatabaseBatch({ idempotencyKey: randomUUID(), collectionId, items: [{ itemId: randomUUID(), kind: 'folder', ...item }] });
    return submitDatabaseBatch(pool, input, actor, access);
  }

  // risk: data loss — a folder move must carry every nested file and folder, and Undo must put them back.
  it('moves a whole folder subtree and undoes it exactly', async() => {
    const top = await seedFile('a/x.md'); const nested = await seedFile('a/b/y.md'); await seedFile('other.md');
    const submitted = await folderBatch({ action: 'move', folderPath: 'a', targetPath: 'c' });
    expect(submitted.state).toBe('pending');
    await runDatabaseBatch(pool, submitted.operationId, actor, access);

    const done = await getDatabaseBatch(pool, submitted.operationId, actor, access);
    expect(done.state).toBe('completed');
    expect(done.items[0]).toMatchObject({ state: 'completed', undoSupported: true, error: null });
    const moved = await filesIn();
    expect(moved.map(file => [file.id, file.path])).toEqual([[nested.id, 'c/b/y.md'], [top.id, 'c/x.md'], [expect.any(String), 'other.md']]);
    const folders = await foldersIn();
    expect(folders.map(folder => folder.path)).toEqual(['c', 'c/b']);

    const undone = await controlDatabaseBatch(pool, submitted.operationId, 'undo', {}, actor, access);
    expect(undone.state).toBe('undone');
    expect((await filesIn()).map(file => file.path)).toEqual(['a/b/y.md', 'a/x.md', 'other.md']);
    // Folder identities survive the round trip; only their paths change back.
    expect((await foldersIn()).map(folder => [folder.id, folder.path])).toEqual([[folders[0].id, 'a'], [folders[1].id, 'a/b']]);
  });

  // risk: data loss — a folder Trash batch must tombstone every file and folder, and restore must bring them all back.
  it('trashes a folder subtree in one batch and restores it from its receipt', async() => {
    await seedFile('docs/one.md'); await seedFile('docs/deep/two.md');
    const submitted = await folderBatch({ action: 'trash', folderPath: 'docs' });
    await runDatabaseBatch(pool, submitted.operationId, actor, access);
    const done = await getDatabaseBatch(pool, submitted.operationId, actor, access);
    expect(done.state).toBe('completed');
    expect((await filesIn()).every(file => file.deleted)).toBe(true);
    expect((await foldersIn()).every(folder => folder.deleted)).toBe(true);

    const receipt = (await pool.query('SELECT folder_plan FROM files_database_operation_receipts WHERE id=$1', [done.items[0].receiptId])).rows[0];
    const root = receipt.folder_plan.folders.find((item:any) => item.before.path === 'docs');
    const restored = await restoreTrashedFolder(pool, root.before.folderId, done.items[0].receiptId!, root.after.revision, actor, access);
    expect(restored).toMatchObject({ status: 'restored', kind: 'folder', id: root.before.folderId, path: 'docs' });
    expect((await filesIn()).map(file => [file.path, file.deleted])).toEqual([['docs/deep/two.md', false], ['docs/one.md', false]]);
    expect((await foldersIn()).every(folder => !folder.deleted)).toBe(true);
    // The receipt is spent: a second restore is refused.
    await expect(restoreTrashedFolder(pool, root.before.folderId, done.items[0].receiptId!, root.after.revision, actor, access)).rejects.toMatchObject({ status: 409 });
  });

  // risk: irreversible side effect — a cancel between leaves must roll the whole item back, and Retry must finish it.
  it('rolls back an item cancelled between leaves and completes it on retry', async() => {
    await seedFile('src/a.md'); await seedFile('src/b.md');
    const submitted = await folderBatch({ action: 'move', folderPath: 'src', targetPath: 'dst' });
    const registry = OperationCancellationRegistry.sharedBy(pool);
    onFile = () => registry.request(submitted.operationId);
    await runDatabaseBatch(pool, submitted.operationId, actor, access);
    onFile = () => undefined;

    const cancelled = await getDatabaseBatch(pool, submitted.operationId, actor, access);
    expect(cancelled.items[0]).toMatchObject({ state: 'failed', retryable: true, error: { status: 409, code: 'operation-cancelled' } });
    expect((await filesIn()).map(file => file.path)).toEqual(['src/a.md', 'src/b.md']);
    expect(await foldersIn()).toEqual([]);

    const retried = await controlDatabaseBatch(pool, submitted.operationId, 'retry', {}, actor, access);
    expect(retried.state).toBe('pending');
    expect(registry.isRequested(submitted.operationId)).toBe(false);
    await runDatabaseBatch(pool, submitted.operationId, actor, access);
    expect((await getDatabaseBatch(pool, submitted.operationId, actor, access)).state).toBe('completed');
    expect((await filesIn()).map(file => file.path)).toEqual(['dst/a.md', 'dst/b.md']);
  });

  // risk: duplicate submit — the same idempotency key replays the same batch, a different request with it is refused.
  it('replays an identical submit and refuses a reused key for another request', async() => {
    await seedFile('k/a.md');
    const input = parseDatabaseBatch({ idempotencyKey: randomUUID(), collectionId, items: [{ itemId: randomUUID(), kind: 'folder', action: 'move', folderPath: 'k', targetPath: 'k2' }] });
    const first = await submitDatabaseBatch(pool, input, actor, access);
    const again = await submitDatabaseBatch(pool, input, actor, access);
    expect(again.operationId).toBe(first.operationId);
    const other = parseDatabaseBatch({ ...input, items: [{ ...input.items[0], targetPath: 'k3' }] });
    await expect(submitDatabaseBatch(pool, other, actor, access)).rejects.toMatchObject({ status: 409, code: 'idempotency-conflict' });
  });

  // risk: data loss — Trash without a receipt keeps history, and Restore brings back the exact pre-Trash content.
  it('trashes a single file without a receipt and restores its pre-Trash content', async() => {
    const file = await seedFile('notes/plan.md');
    await trashFileWithoutReceipt(pool, file.id, actor, access);
    const trashed = (await pool.query('SELECT current_version_id,deleted_at,operation_revision FROM files WHERE id=$1', [file.id])).rows[0];
    expect(trashed.deleted_at).not.toBeNull();
    await expect(trashFileWithoutReceipt(pool, file.id, actor, access)).rejects.toMatchObject({ status: 409 });

    const restored = await restoreTrashedFile(pool, file.id, actor, access, { expectedVersionId: trashed.current_version_id });
    expect(restored).toMatchObject({ status: 'restored', kind: 'file', id: file.id, path: 'notes/plan.md', receiptId: null });
    const version = (await pool.query('SELECT restored_from_version_id,parent_version_id FROM file_versions WHERE id=$1', [restored.versionId])).rows[0];
    expect(version).toEqual({ restored_from_version_id: file.versionId, parent_version_id: trashed.current_version_id });
    expect((await pool.query("SELECT op FROM journal WHERE file_id=$1 AND op IN('delete','restore') ORDER BY seq", [file.id])).rows.map(row => row.op)).toEqual(['delete', 'restore']);
  });
});
