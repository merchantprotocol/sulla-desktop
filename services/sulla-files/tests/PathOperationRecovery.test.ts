// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

// Crash recovery for native path operations and the Trash retention sweep, on the real Files schema
// (all migrations) and a real temp folder driven through FilesMutationCoordinator.
// Requires SULLA_FILES_TEST_DATABASE_URL.
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TransactionRunner } from '../src/FilesTransaction.js';
import { migrate } from '../src/db.js';
import { OperationFingerprint } from '../src/PathOperationPlan.js';
import { PathOperationRecovery } from '../src/PathOperationRecovery.js';
import { PathOperationRepository } from '../src/Repositories/PathOperationRepository.js';
import { FilesMutationCoordinator } from '../src/safeFilesystem.js';
import { TrashReceiptExpiry } from '../src/TrashReceiptExpiry.js';

const databaseUrl = process.env.SULLA_FILES_TEST_DATABASE_URL;
const sha256 = (value:string) => createHash('sha256').update(value).digest('hex');
const present = (path:string) => access(path).then(() => true, () => false);

describe.skipIf(!databaseUrl)('path operation recovery and trash expiry (real Postgres + temp folder)', () => {
  const schema = `files_path_recovery_${ randomUUID().replaceAll('-', '') }`;
  const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  let pool:pg.Pool;
  let root = '';
  let mutations:FilesMutationCoordinator;
  let recovery:PathOperationRecovery;
  const disposed:string[] = [];
  const journal:any = { dispose: async(id:string) => { disposed.push(id); return { state: 'complete' } }, recover: async() => undefined };

  beforeAll(async() => {
    await admin.query(`CREATE SCHEMA "${ schema }"`);
    pool = new pg.Pool({ connectionString: databaseUrl, max: 4, options: `-csearch_path=${ schema },public` });
    await migrate(pool);
  });
  afterAll(async() => { await pool?.end(); await admin.query(`DROP SCHEMA IF EXISTS "${ schema }" CASCADE`); await admin.end(); if (root) await rm(root, { recursive: true, force: true }) });
  beforeEach(async() => {
    await pool.query('DELETE FROM files_path_operations');
    await pool.query('DELETE FROM files_database_operation_receipts');
    disposed.length = 0;
    if (root) await rm(root, { recursive: true, force: true });
    root = await mkdtemp(join(tmpdir(), 'sulla-path-recovery-'));
    mutations = new FilesMutationCoordinator(root);
    recovery = new PathOperationRecovery(new PathOperationRepository(pool), mutations, new Map([['default', mutations]]), () => journal);
  });

  /** A copy that crashed after publishing its target: plan + durable receipt, in the given journal state. */
  async function crashedCopy(state:'publishing' | 'db-committed') {
    await writeFile(join(root, 'source.txt'), 'payload');
    const operationId = randomUUID(); const hash = sha256('payload');
    const entry = { rootId: 'default', fileId: randomUUID(), sourcePath: 'source.txt', targetPath: 'copy.txt', stagePath: `.sulla-trash/.operations/${ operationId }/f.copy`, contentHash: hash, kind: 'copy' };
    const publication = await mutations.copyVerified({ source: entry.sourcePath, target: entry.targetPath, staged: entry.stagePath, verify: pinned => recovery.verifyPinned(pinned, hash) });
    await pool.query("INSERT INTO files_path_operations(operation_id,action,state,plan,receipts) VALUES($1,'copy',$2,$3::jsonb,$4::jsonb)", [operationId, state, JSON.stringify([entry]),
      JSON.stringify([{ fileId: entry.fileId, stagePath: entry.stagePath, targetPath: entry.targetPath, published: true, fingerprint: OperationFingerprint.serialize(publication.fingerprint) }])]);
    return { operationId, entry };
  }
  const operation = async(id:string) => (await pool.query('SELECT state,last_error FROM files_path_operations WHERE operation_id=$1', [id])).rows[0];

  // risk: data integrity — an uncommitted copy is undone: the published target and stage go, the source stays.
  it('rolls back an uncommitted copy', async() => {
    const { operationId, entry } = await crashedCopy('publishing');
    await recovery.recoverAll();
    expect(await present(join(root, entry.targetPath))).toBe(false);
    expect(await present(join(root, entry.stagePath))).toBe(false);
    expect(await readFile(join(root, 'source.txt'), 'utf8')).toBe('payload');
    expect(await operation(operationId)).toMatchObject({ state: 'completed', last_error: null });
  });

  // risk: data loss — a committed copy is finished, never rolled back: the target stays and the stage is cleaned up.
  it('finishes a committed copy', async() => {
    const { operationId, entry } = await crashedCopy('db-committed');
    await recovery.recoverAll();
    expect(await readFile(join(root, entry.targetPath), 'utf8')).toBe('payload');
    expect(await present(join(root, entry.stagePath))).toBe(false);
    expect((await operation(operationId)).state).toBe('completed');
  });

  // risk: data loss — if the committed target changed, nothing is touched and the operation is held with its error.
  it('preserves artifacts and records the error when a committed target changed', async() => {
    const { operationId, entry } = await crashedCopy('db-committed');
    await writeFile(join(root, entry.targetPath), 'edited by the user');
    await expect(recovery.recoverAll()).rejects.toThrow(`Files path operation ${ operationId } requires preserved-artifact reconciliation`);
    expect(await readFile(join(root, entry.targetPath), 'utf8')).toBe('edited by the user');
    expect(await present(join(root, entry.stagePath))).toBe(true);
    expect(await operation(operationId)).toMatchObject({ state: 'db-committed', last_error: expect.stringContaining('Committed target identity changed') });
  });

  async function trashReceipt(expiresAt:Date, lifecycleExtra:Record<string, unknown> = {}):Promise<string> {
    return (await pool.query(`INSERT INTO files_database_operation_receipts(actor_user_id,actor_scope,idempotency_key,request,collection_id,file_id,action,state,before_state,after_state,folder_plan)
      VALUES('u1','s',$1,'{}',$2,$3,'trash','completed','{}','{}',$4) RETURNING id`, [randomUUID(), randomUUID(), randomUUID(), { lifecycle: { expiresAt: expiresAt.toISOString(), ...lifecycleExtra } }])).rows[0].id;
  }

  // risk: retention policy — expired Trash loses its undo and its retained artifacts; unexpired and held receipts don't.
  it('expires only due trash receipts and disposes their retained artifacts', async() => {
    const now = new Date('2026-11-16T00:00:00Z');
    const due = await trashReceipt(new Date('2026-11-01T00:00:00Z'));
    const notDue = await trashReceipt(new Date('2026-12-01T00:00:00Z'));
    const held = await trashReceipt(new Date('2026-11-01T00:00:00Z'));
    await pool.query("INSERT INTO files_path_operations(operation_id,action,state,plan) VALUES($1,'trash','completed','{}'::jsonb)", [due]);
    await pool.query("INSERT INTO files_path_operations(operation_id,action,state,plan,last_error) VALUES($1,'trash','completed','{}'::jsonb,'stuck')", [held]);
    const expiry = new TrashReceiptExpiry(new PathOperationRepository(pool), new TransactionRunner(pool), () => journal);
    expect(await expiry.expire(now)).toEqual({ invalidated: 1, disposed: 1, preserved: 1 });
    expect(disposed).toEqual([due]);
    const plan = async(id:string) => (await pool.query('SELECT folder_plan FROM files_database_operation_receipts WHERE id=$1', [id])).rows[0].folder_plan;
    expect((await plan(due)).lifecycle.disposal).toMatchObject({ undoInvalidatedAt: now.toISOString(), invalidatedBy: 'configured-retention' });
    expect((await pool.query('SELECT plan FROM files_path_operations WHERE operation_id=$1', [due])).rows[0].plan.disposal.reason).toBe('configured-trash-retention-expired');
    expect((await plan(notDue)).lifecycle.disposal).toBeUndefined();
    expect((await plan(held)).lifecycle.disposal).toBeUndefined();
    expect(await expiry.expire(now)).toEqual({ invalidated: 0, disposed: 0, preserved: 1 });
  });
});
