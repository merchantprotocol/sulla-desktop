// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

// Characterizes native source custody (ingest + publication operations) on the real Files schema.
// Point SULLA_FILES_TEST_DATABASE_URL at a throwaway Postgres; each run creates and drops its own schema
// and applies every real migration through db.migrate.
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db.js';
import { NativeSourceOperations, type NativeSourceOperationInput } from '../src/NativeSourceOperations.js';
import { NativeSourceOperationRepository } from '../src/Repositories/NativeSourceOperationRepository.js';

const databaseUrl = process.env.SULLA_FILES_TEST_DATABASE_URL;
const hex = (value:string) => createHash('sha256').update(value).digest('hex');
const handle = (seed:string) => createHash('sha256').update(seed).digest('base64url').slice(0, 43);

describe.skipIf(!databaseUrl)('native source operations (real Postgres)', () => {
  const schema = `files_native_ops_${ randomUUID().replaceAll('-', '') }`;
  const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  let pool:pg.Pool;
  let collectionId = '';
  let service:NativeSourceOperations;
  const host = { serial: <T>(operation:()=>Promise<T>) => operation(), fuseRow: async() => { throw new Error('unused') } };

  beforeAll(async() => {
    await admin.query(`CREATE SCHEMA "${ schema }"`);
    pool = new pg.Pool({ connectionString: databaseUrl, max: 4, options: `-csearch_path=${ schema },public` });
    await migrate(pool);
  });
  afterAll(async() => { await pool?.end(); await admin.query(`DROP SCHEMA IF EXISTS "${ schema }" CASCADE`); await admin.end() });
  beforeEach(async() => {
    collectionId = randomUUID();
    // Unique explorer_path per collection: collections_explorer_path_owner_org is unique per owner.
    await pool.query(`INSERT INTO collections(id,owner_user_id,name,kind,home,encrypted_data_key,dedup_key_ciphertext,retention_policy,published,legacy_source,explorer_path)
      VALUES($1,'u1','Files','knowledge','desktop-only','{}','{}','{}',TRUE,FALSE,$1)`, [collectionId]);
    service = new NativeSourceOperations(pool, host, new NativeSourceOperationRepository(pool), undefined, 200);
  });

  async function file(path:string):Promise<{ id:string; versionId:string }> {
    const id = (await pool.query("INSERT INTO files(collection_id,path,created_by_type,created_by_id,mime,size) VALUES($1,$2,'user','u1','text/plain',0) RETURNING id", [collectionId, path])).rows[0].id;
    const versionId = await version(id);
    return { id, versionId };
  }
  async function version(fileId:string):Promise<string> {
    const versionId = (await pool.query(`INSERT INTO file_versions(file_id,chunk_collection_id,size,created_by_type,created_by_id,device_id)
      VALUES($1,$2,0,'user','u1','d1') RETURNING id`, [fileId, collectionId])).rows[0].id;
    await pool.query('UPDATE files SET current_version_id=$2 WHERE id=$1', [fileId, versionId]);
    return versionId;
  }
  const operation = async(id:string) => (await pool.query('SELECT * FROM files_native_source_operations WHERE operation_id=$1', [id])).rows[0];
  const source = async(fileId:string) => (await pool.query('SELECT * FROM files_native_sources WHERE file_id=$1', [fileId])).rows[0];

  async function ingested(path = 'a.txt') {
    const target = await file(path);
    const input:NativeSourceOperationInput = { operationId: randomUUID(), handle: handle(path + randomUUID()), sourceRevision: hex('r1'), desiredHash: hex('bytes'), collectionId, path };
    const result = await service.ingest(input, async() => ({ id: target.id, current_version_id: target.versionId, path, mime: 'text/plain', size: 0 }));
    return { target, input, result };
  }

  // risk: data accuracy — an ingest must bind the native handle to exactly the Files version it committed.
  it('ingests once, binds the source and replays the same result for the same operation id', async() => {
    const { target, input, result } = await ingested();
    expect(result.id).toBe(target.id);
    expect((await operation(input.operationId))).toMatchObject({ direction: 'ingest', state: 'completed', file_id: target.id, files_version_id: target.versionId });
    expect(await source(target.id)).toMatchObject({ source_handle: input.handle, source_revision: input.sourceRevision, source_hash: input.desiredHash, state: 'active', display_name: 'a.txt' });
    let calls = 0;
    const replay = await service.ingest(input, async() => { calls++; throw new Error('must not re-ingest') });
    expect(replay.id).toBe(target.id);
    expect(calls).toBe(0);
  });

  // risk: integrity — reusing an operation id with different inputs must never rebind a source.
  it('refuses an operation id reused with different immutable inputs', async() => {
    const { input } = await ingested();
    await expect(service.ingest({ ...input, desiredHash: hex('other') }, async() => { throw new Error('unreachable') })).rejects.toMatchObject({ status: 409 });
  });

  // risk: failure path — a failed ingest stays retryable (planned) and records why it failed.
  it('records the error and leaves a failed ingest planned for retry', async() => {
    const input:NativeSourceOperationInput = { operationId: randomUUID(), handle: handle('fail'), sourceRevision: hex('r1'), desiredHash: hex('b'), collectionId, path: 'f.txt' };
    await expect(service.ingest(input, async() => { throw new Error('disk vanished') })).rejects.toThrow('disk vanished');
    expect(await operation(input.operationId)).toMatchObject({ state: 'planned', last_error: 'disk vanished' });
  });

  // risk: data accuracy — an exact acknowledgement advances the source and completes the publication atomically.
  it('completes a publication only with an exact durable proof', async() => {
    const { target, input } = await ingested('p.txt');
    const publishId = randomUUID();
    await service.planPublication({ operationId: publishId, handle: input.handle, sourceRevision: input.sourceRevision, fileId: target.id, baseVersionId: target.versionId, desiredHash: hex('new') });
    expect(await service.publicationActions()).toEqual([expect.objectContaining({ operationId: publishId, fileId: target.id, state: 'publishing' })]);
    const proof = { nextSourceRevision: hex('r2'), originalSourceRevision: input.sourceRevision, originalSourceHash: input.desiredHash,
      currentSourceHash: hex('new'), filesBaseVersionId: target.versionId, currentFilesVersionId: target.versionId };
    await expect(service.finishPublication(publishId, { ...proof, currentSourceHash: hex('forged') })).rejects.toMatchObject({ status: 409 });
    expect((await operation(publishId)).state).toBe('publishing');
    await service.finishPublication(publishId, proof);
    expect(await operation(publishId)).toMatchObject({ state: 'completed', next_source_revision: hex('r2') });
    expect(await source(target.id)).toMatchObject({ source_revision: hex('r2'), source_hash: hex('new'), state: 'active' });
    await service.finishPublication(publishId, proof); // idempotent acknowledgement
  });

  // risk: lost update — if Files moved during publication, the recovery marker is committed even though the call fails.
  it('commits recovery-required and rejects when Files advanced during publication', async() => {
    const { target, input } = await ingested('adv.txt');
    const publishId = randomUUID();
    await service.planPublication({ operationId: publishId, handle: input.handle, sourceRevision: input.sourceRevision, fileId: target.id, baseVersionId: target.versionId, desiredHash: hex('new') });
    await version(target.id);
    await expect(service.finishPublication(publishId, { nextSourceRevision: hex('r2'), originalSourceRevision: input.sourceRevision, originalSourceHash: input.desiredHash,
      currentSourceHash: hex('new'), filesBaseVersionId: target.versionId, currentFilesVersionId: target.versionId })).rejects.toMatchObject({ status: 409 });
    expect(await operation(publishId)).toMatchObject({ state: 'recovery-required', next_source_revision: hex('r2'), last_error: 'Files advanced during native publication' });
    expect((await source(target.id)).source_revision).toBe(input.sourceRevision);
  });

  // risk: unknown outcome — a publication reported without proof must be held for reconciliation, never completed.
  it('marks an unproven publication recovery-required and rejects unknown ids', async() => {
    const { target, input } = await ingested('np.txt');
    const publishId = randomUUID();
    await service.planPublication({ operationId: publishId, handle: input.handle, sourceRevision: input.sourceRevision, fileId: target.id, baseVersionId: target.versionId, desiredHash: hex('n') });
    await service.finishPublication(publishId, undefined, 'electron crashed');
    expect(await operation(publishId)).toMatchObject({ state: 'recovery-required', last_error: 'electron crashed' });
    await service.finishPublication(publishId); // already recovery-required: accepted
    await expect(service.finishPublication(randomUUID())).rejects.toMatchObject({ status: 404 });
  });

  // risk: permissions — sessions not re-granted by Electron lose access; granted ones are restored.
  it('revalidates sessions: granted handles stay active, others must be reselected', async() => {
    const kept = await ingested('k.txt'); const lost = await ingested('l.txt');
    await service.revalidateSessions([kept.input.handle]);
    expect(await source(kept.target.id)).toMatchObject({ state: 'active', last_error: null });
    expect(await source(lost.target.id)).toMatchObject({ state: 'reselect-required', recovery: { action: 'reselect-native-source' } });
  });

  // risk: crash recovery — after restart, committed ingests complete and in-flight publications are held.
  it('reconciles operations left behind by a restart', async() => {
    const { target, input } = await ingested('r.txt');
    const plannedId = randomUUID();
    await pool.query(`INSERT INTO files_native_source_operations(operation_id,source_handle,direction,state,source_revision,source_hash,file_id,files_version_id,desired_hash)
      VALUES($1,$2,'ingest','planned',$3,$4,$5,$6,$4)`, [plannedId, input.handle, input.sourceRevision, input.desiredHash, target.id, target.versionId]);
    const publishId = randomUUID();
    await service.planPublication({ operationId: publishId, handle: input.handle, sourceRevision: input.sourceRevision, fileId: target.id, baseVersionId: target.versionId, desiredHash: hex('x') });
    await service.reconcileAfterRestart();
    expect((await operation(plannedId)).state).toBe('completed');
    expect(await operation(publishId)).toMatchObject({ state: 'recovery-required', recovery: { action: 'compare-source-to-files-version' } });
  });

  // risk: integrity — reselection rebinds only the single matching interrupted publication.
  it('reselects an interrupted publication onto a new handle', async() => {
    const { target, input } = await ingested('s.txt');
    const publishId = randomUUID();
    await service.planPublication({ operationId: publishId, handle: input.handle, sourceRevision: input.sourceRevision, fileId: target.id, baseVersionId: target.versionId, desiredHash: hex('y') });
    await service.finishPublication(publishId, undefined, 'lost');
    await service.revalidateSessions([]);
    const next = handle('next');
    expect(await service.reselectInterruptedPublication({ fileId: target.id, previousHandle: handle('wrong'), handle: next, sourceRevision: hex('r9'), sourceHash: hex('y') })).toBe(false);
    expect(await service.reselectInterruptedPublication({ fileId: target.id, previousHandle: input.handle, handle: next, sourceRevision: hex('r9'), sourceHash: hex('y') })).toBe(true);
    expect(await source(target.id)).toMatchObject({ source_handle: next, source_revision: hex('r9'), recovery: { publicationOperationId: publishId, originalHandle: input.handle } });
  });
});
