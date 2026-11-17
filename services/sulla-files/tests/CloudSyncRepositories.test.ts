// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Runs the cloud-sync repositories' real SQL against Postgres. Point SULLA_FILES_TEST_DATABASE_URL at a
// throwaway database (e.g. `docker run --rm -e POSTGRES_PASSWORD=x -p 55432:5432 postgres:16-alpine`).
// Each run creates and drops its own schema: minimal base tables, then the real cloud-sync migrations.
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PgCloudCatalogRepository } from '../src/Repositories/CloudCatalogRepository.js';
import { PgCloudChunkMapRepository } from '../src/Repositories/CloudChunkMapRepository.js';
import { PgCloudCollectionCatalogRepository } from '../src/Repositories/CloudCollectionCatalogRepository.js';
import { PgCloudFileHeadRepository } from '../src/Repositories/CloudFileHeadRepository.js';
import { PgCloudOperationQueueRepository } from '../src/Repositories/CloudOperationQueueRepository.js';
import { PgCloudPushProgressRepository } from '../src/Repositories/CloudPushProgressRepository.js';
import { PgCloudSyncStateRepository } from '../src/Repositories/CloudSyncStateRepository.js';
import { CloudSyncService } from '../src/cloudSync/service.js';
import { OrgRootKeyCache } from '../src/cloudSync/OrgRootKeyCache.js';
import { Store } from '../src/store.js';
import type { SyncHead } from '../src/cloudSync/envelope.js';
import type { UploadSession } from '../src/cloudSync/repository.js';

const databaseUrl = process.env.SULLA_FILES_TEST_DATABASE_URL;
const migration = (name:string) => readFileSync(new URL(`../migrations/${ name }`, import.meta.url), 'utf8');
const hex64 = (seed:string) => seed.repeat(64).slice(0, 64);
const wrapped = { v: 1, alg: 'test', ct: 'wrapped-root' };

describe.skipIf(!databaseUrl)('cloud sync repositories (real Postgres)', () => {
  const schema = `files_cloud_sync_spec_${ randomUUID().replaceAll('-', '') }`;
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2, options: `-c search_path=${ schema }` });
  const state = new PgCloudSyncStateRepository(pool);
  const operations = new PgCloudOperationQueueRepository(pool);
  const chunks = new PgCloudChunkMapRepository(pool);
  const heads = new PgCloudFileHeadRepository(pool);
  const progress = new PgCloudPushProgressRepository(pool, heads);
  const collectionCatalog = new PgCloudCollectionCatalogRepository(pool);
  const webCatalog = new PgCloudCatalogRepository(pool);
  let collectionId = '';
  let otherCollectionId = '';

  beforeAll(async() => {
    await pool.query(`CREATE SCHEMA ${ schema }`);
    await pool.query(`CREATE TABLE collections(id uuid PRIMARY KEY,name text NOT NULL,owner_user_id text NOT NULL DEFAULT 'u1',published boolean NOT NULL DEFAULT TRUE,workspace_scope text NOT NULL DEFAULT 'principal',org_collection_level text NOT NULL DEFAULT 'none',org_collection_enrolled boolean NOT NULL DEFAULT FALSE,root_key_source text NOT NULL DEFAULT 'local',
      legacy_source boolean NOT NULL DEFAULT FALSE,system_area text,cloud_catalog_sync boolean NOT NULL DEFAULT FALSE,created_at timestamptz NOT NULL DEFAULT NOW())`);
    await pool.query(`CREATE TABLE files(id uuid PRIMARY KEY,collection_id uuid NOT NULL REFERENCES collections(id) ON DELETE CASCADE,path text NOT NULL,current_version_id uuid,
      deleted_at timestamptz,mime text,size bigint NOT NULL DEFAULT 0,extraction_status text NOT NULL DEFAULT 'pending',updated_at timestamptz NOT NULL DEFAULT NOW())`);
    await pool.query('CREATE TABLE file_folders(id uuid PRIMARY KEY,collection_id uuid NOT NULL,path text NOT NULL,deleted_at timestamptz)');
    await pool.query('CREATE TABLE file_versions(id uuid PRIMARY KEY,file_id uuid NOT NULL,parent_version_id uuid,deleted boolean NOT NULL DEFAULT FALSE)');
    await pool.query('CREATE TABLE chunks(collection_id uuid NOT NULL,id text NOT NULL,size bigint NOT NULL,stored_size bigint NOT NULL,PRIMARY KEY(collection_id,id))');
    await pool.query('CREATE TABLE files_chunk_cache(collection_id uuid NOT NULL,chunk_id text NOT NULL,state text NOT NULL,PRIMARY KEY(collection_id,chunk_id))');
    await pool.query('CREATE TABLE files_protected_files(file_id uuid PRIMARY KEY)');
    await pool.query(`CREATE TABLE file_sync_cursors(collection_id UUID NOT NULL REFERENCES collections(id) ON DELETE CASCADE,device_id TEXT NOT NULL,
      last_seq BIGINT NOT NULL DEFAULT 0,last_push_seq BIGINT NOT NULL DEFAULT 0,PRIMARY KEY(collection_id,device_id))`);
    for (const name of ['048_cloud_sync.sql', '051_cloud_backup_skips.sql', '052_cloud_sync_collection_info.sql', '058_file_restore_versions.sql', '070_cloud_sync_org_key_status.sql']) {
      await pool.query(migration(name));
    }
  });
  afterAll(async() => { await pool.query(`DROP SCHEMA IF EXISTS ${ schema } CASCADE`); await pool.end() });
  beforeEach(async() => {
    await pool.query('TRUNCATE collections CASCADE');
    await pool.query('TRUNCATE files, file_folders, file_versions, chunks, files_chunk_cache, files_protected_files CASCADE');
    collectionId = randomUUID(); otherCollectionId = randomUUID();
    await pool.query("INSERT INTO collections(id,name) VALUES($1,'Projects'),($2,'Other')", [collectionId, otherCollectionId]);
  });

  async function file(path:string, options:{ collection?:string; versionId?:string; status?:string; deleted?:boolean } = {}) {
    const fileId = randomUUID(); const versionId = options.versionId ?? randomUUID();
    await pool.query('INSERT INTO file_versions(id,file_id) VALUES($1,$2)', [versionId, fileId]);
    await pool.query('INSERT INTO files(id,collection_id,path,current_version_id,extraction_status,deleted_at) VALUES($1,$2,$3,$4,$5,$6)',
      [fileId, options.collection ?? collectionId, path, versionId, options.status ?? 'pending', options.deleted ? new Date() : null]);
    return { fileId, versionId };
  }

  const head = (seq:number):SyncHead => ({ format: 'sulla-files-sync-head', v: 1, collectionId, keyVersion: 1, seq, stateHash: hex64('a'), prevMac: '', mac: hex64('b') });

  it('enables backup once with a new root, keeps that root on later enables and resumes where it left off', async() => {
    // risk: data accuracy, replacing the wrapped root on re-enable would orphan everything already in Cloud.
    const first = await state.setEnabled(collectionId, true, wrapped);
    expect(first).toMatchObject({ enabled: true, status: 'needs-vault', keyVersion: 1, wrappedRoot: wrapped, cloudCreated: false });
    expect((await pool.query("SELECT 1 FROM file_sync_cursors WHERE collection_id=$1 AND device_id='cloud'", [collectionId])).rowCount).toBe(1);
    await state.markCreated(collectionId, head(3), randomUUID(), 2);
    expect((await state.setEnabled(collectionId, false, null)).status).toBe('off');
    await state.setStatus(collectionId, 'error', 'ignored while off');
    expect((await state.sync(collectionId))?.status).toBe('off');
    const resumed = await state.setEnabled(collectionId, true, { v: 1, alg: 'test', ct: 'a-different-root' });
    expect(resumed).toMatchObject({ enabled: true, status: 'idle', wrappedRoot: wrapped, lastSeq: 3, cloudCreated: true });
    expect((await state.enabledCollections()).map(row => row.collectionId)).toEqual([collectionId]);
  });

  it('asks for escrow only for collections not yet escrowed under the current vault epoch', async() => {
    // risk: a collection left un-escrowed cannot be restored on a new Desktop.
    const vaultId = randomUUID();
    await state.setEnabled(collectionId, true, wrapped);
    await state.setEnabled(otherCollectionId, true, wrapped);
    await state.markEscrowed(otherCollectionId, vaultId, 4);
    expect((await state.sync(otherCollectionId))?.status).toBe('idle');
    expect((await state.needsEscrow(vaultId, 4)).map(row => row.collectionId)).toEqual([collectionId]);
    expect((await state.needsEscrow(vaultId, 5)).map(row => row.collectionId).sort()).toEqual([collectionId, otherCollectionId].sort());
  });

  it('keeps org roots out of Vault escrow and refuses Cloud writes below edit', async() => {
    // risk: key custody and permissions — an org root must not be wrapped by a member Vault, and view grants cannot upload.
    await state.setEnabled(collectionId, true, wrapped);
    await pool.query("UPDATE collections SET workspace_scope='organization',org_collection_level='view',org_collection_enrolled=TRUE,root_key_source='org' WHERE id=$1", [collectionId]);
    expect(await state.needsEscrow(randomUUID(), 1)).toEqual([]);
    expect(await state.canWriteCollection(collectionId)).toBe(false);
    await pool.query("UPDATE collections SET org_collection_level='edit' WHERE id=$1", [collectionId]);
    expect(await state.canWriteCollection(collectionId)).toBe(true);
    await pool.query("UPDATE collections SET workspace_scope='principal' WHERE id=$1", [collectionId]);
    expect(await state.canWriteCollection(collectionId)).toBe(true);
  });

  it('enables an enrolled org collection without creating it or queuing escrow', async() => {
    // risk: key custody and data integrity — org sync must adopt an existing Cloud collection without persisting its root or minting a second collection.
    const root=Buffer.alloc(32,0x6a);
    await pool.query("UPDATE collections SET workspace_scope='organization',org_collection_level='edit',org_collection_enrolled=TRUE,root_key_source='org' WHERE id=$1",[collectionId]);
    expect(await state.enrolledOrgCollection(collectionId)).toBe(true);
    await state.enableOrgSync(collectionId,4);
    const sync=await state.sync(collectionId);
    expect(sync).toMatchObject({enabled:true,keyVersion:4,status:'idle',cloudCreated:true,lastSeq:0,head:null,escrowVaultId:null,escrowVaultEpoch:null,
      wrappedRoot:{version:1,algorithm:'xchacha20-poly1305',nonce:'org-key-source',ciphertext:'org-key-source'}});
    expect(await operations.hasOperation(collectionId)).toBe(false);
    const persisted=(await pool.query('SELECT to_jsonb(c)::text||to_jsonb(s)::text AS text FROM collections c JOIN files_cloud_sync s ON s.collection_id=c.id WHERE c.id=$1',[collectionId])).rows[0].text;
    expect(persisted).not.toContain(root.toString('base64'));
    root.fill(0);
    await state.enableOrgSync(collectionId,4);
    expect((await state.sync(collectionId))?.keyVersion).toBe(4);
    await pool.query("UPDATE collections SET org_collection_enrolled=FALSE WHERE id=$1",[collectionId]);
    await expect(state.enableOrgSync(collectionId,4)).rejects.toMatchObject({status:404});
  });

  it('marks enabled org sync needs-org-key when advance has no cached root',async()=>{
    // risk: reliability and key custody — missing org material is a recoverable waiting state, not a failed sync loop.
    await pool.query("UPDATE collections SET workspace_scope='organization',org_collection_level='edit',org_collection_enrolled=TRUE,root_key_source='org' WHERE id=$1",[collectionId]);
    await state.enableOrgSync(collectionId,5);
    const config:any={deviceId:'test-device',userId:'test-user',mode:'desktop',dataRoot:'/tmp/files-org-key-spec'};
    const service=new CloudSyncService(pool,config,{} as any,new Store('/tmp/files-org-key-spec/chunks'),{execute:async()=>{throw new Error('unexpected Cloud request')}},new OrgRootKeyCache());
    await (service as any).advance(collectionId);
    expect((await state.sync(collectionId))?.status).toBe('needs-org-key');
  });

  it('sends the folder name again only after a rename', async() => {
    // risk: a new Desktop restores folders under stale names.
    await state.setEnabled(collectionId, true, wrapped);
    const stale = await state.staleInfoName(collectionId);
    expect(stale?.name).toBe('Projects');
    await state.markInfoSent(collectionId, stale!.sha);
    expect(await state.staleInfoName(collectionId)).toBeNull();
    await pool.query("UPDATE collections SET name='Renamed' WHERE id=$1", [collectionId]);
    expect((await state.staleInfoName(collectionId))?.name).toBe('Renamed');
  });

  it('forgets every cloud record of a deleted cloud copy but leaves other collections alone', async() => {
    // risk: irreversible side effect, stale chunk map rows would let eviction trust a crypto-shredded copy.
    await state.setEnabled(collectionId, true, wrapped);
    await state.setEnabled(otherCollectionId, true, wrapped);
    const local = await file('a.txt');
    await pool.query('INSERT INTO files_cloud_versions(version_id,collection_id,file_id,pushed_seq) VALUES($1,$2,$3,1)', [local.versionId, collectionId, local.fileId]);
    for (const id of [collectionId, otherCollectionId]) {
      await chunks.recordSealedChunk(id, hex64('1'), hex64('2'), hex64('3'), 10);
      await heads.upsert(pool as unknown as pg.PoolClient, id, randomUUID(), randomUUID(), false, 1);
    }
    await progress.advancePushCursor(collectionId, 9);
    await state.markCloudDeleted(collectionId);
    expect(await state.sync(collectionId)).toMatchObject({ enabled: false, status: 'off', wrappedRoot: null, lastSeq: 0, cloudCreated: false, uploadSession: null });
    expect(await progress.pushCursor(collectionId)).toBe(0);
    for (const table of ['files_cloud_versions', 'files_cloud_chunk_map', 'files_cloud_file_heads']) {
      expect((await pool.query(`SELECT 1 FROM ${ table } WHERE collection_id=$1`, [collectionId])).rowCount).toBe(0);
    }
    expect((await pool.query('SELECT 1 FROM files_cloud_chunk_map WHERE collection_id=$1', [otherCollectionId])).rowCount).toBe(1);
  });

  it('hands out signed operations oldest first and still runs a delete after backup was switched off', async() => {
    // risk: irreversible side effect, ops must be signed in order and exactly once.
    await state.setEnabled(collectionId, true, wrapped);
    await state.setEnabled(otherCollectionId, false, null);
    const [older, newer, paused, shred] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await operations.queue(collectionId, 'commit', '/p', 'POST', '{}', hex64('c'), newer);
    await operations.queue(collectionId, 'upload-open', '/p', 'POST', '{}', hex64('c'), older, { a: 1 });
    await operations.queue(otherCollectionId, 'info', '/p', 'PUT', '{}', hex64('c'), paused);
    await operations.queue(otherCollectionId, 'delete', '/p', 'DELETE', null, hex64('c'), shred);
    await pool.query("UPDATE files_cloud_operations SET created_at=NOW()-make_interval(secs=>CASE handle WHEN $1::uuid THEN 40 WHEN $2::uuid THEN 30 WHEN $3::uuid THEN 20 ELSE 10 END)", [paused, older, newer]);
    expect((await operations.nextOperation())?.handle).toBe(older);
    expect(await operations.operationByHandle(older)).toMatchObject({ op: 'upload-open', collectionId, meta: { a: 1 }, attempts: 0 });
    expect(await operations.failOperation(older, 'x')).toBe(1);
    expect(await operations.failOperation(older, 'y')).toBe(2);
    await operations.completeOperation(older);
    expect((await operations.nextOperation())?.handle).toBe(newer);
    await operations.dropCollectionOperations(collectionId, ['commit']);
    expect(await operations.hasOperation(collectionId)).toBe(false);
    expect((await operations.nextOperation())?.handle).toBe(shred);
    expect(await operations.operationByHandle('not-a-uuid')).toBeNull();
  });

  it('only moves the push cursor forward and parks a failing version with growing backoff', async() => {
    // risk: data accuracy, a cursor moving backwards re-uploads, a lost skip stalls the collection.
    await state.setEnabled(collectionId, true, wrapped);
    await progress.advancePushCursor(collectionId, 7);
    await progress.advancePushCursor(collectionId, 4);
    expect(await progress.pushCursor(collectionId)).toBe(7);
    const local = await file('big.bin');
    await progress.skipVersion(collectionId, local.fileId, local.versionId, 'e'.repeat(800));
    let row = (await pool.query("SELECT attempts,length(error) AS length,EXTRACT(EPOCH FROM retry_at-NOW()) AS wait FROM files_cloud_skips WHERE version_id=$1", [local.versionId])).rows[0];
    expect([Number(row.attempts), Number(row.length)]).toEqual([1, 500]);
    expect(Number(row.wait)).toBeGreaterThan(3500);
    await progress.skipVersion(collectionId, local.fileId, local.versionId, 'again');
    row = (await pool.query("SELECT attempts,EXTRACT(EPOCH FROM retry_at-NOW()) AS wait FROM files_cloud_skips WHERE version_id=$1", [local.versionId])).rows[0];
    expect(Number(row.attempts)).toBe(2);
    expect(Number(row.wait)).toBeGreaterThan(7100);
    await progress.skipVersion(collectionId, randomUUID(), randomUUID(), 'unknown version');
    expect((await pool.query('SELECT 1 FROM files_cloud_skips')).rowCount).toBe(1);
    await progress.clearSkip(local.versionId);
    expect((await pool.query('SELECT 1 FROM files_cloud_skips')).rowCount).toBe(0);
  });

  it('records an acknowledged commit atomically: version, head, cursor and idle state', async() => {
    // risk: data accuracy, half-recorded commits make the next stateHash disagree with Cloud.
    await state.setEnabled(collectionId, true, wrapped);
    const local = await file('doc.txt');
    const session:UploadSession = { journalSeq: 12, fileId: local.fileId, versionId: local.versionId, parentVersionId: null, baseVersionId: null, deleted: false,
      manifest: {}, chunkIds: [], declared: [], staged: [], uploadId: null, present: [] };
    await state.saveSession(collectionId, session, 99, 'syncing');
    expect((await state.sync(collectionId))?.uploadSession?.versionId).toBe(local.versionId);
    await progress.finishCommit(collectionId, session, head(5));
    expect(await state.sync(collectionId)).toMatchObject({ status: 'idle', lastSeq: 5, uploadSession: null });
    expect(await heads.cloudHead(collectionId, local.fileId)).toBe(local.versionId);
    expect(await progress.pushCursor(collectionId)).toBe(12);
    expect(Number((await pool.query('SELECT pushed_seq FROM files_cloud_versions WHERE version_id=$1', [local.versionId])).rows[0].pushed_seq)).toBe(5);
  });

  it('never lets an older seq replace a newer cloud head and pages heads in fileId order', async() => {
    // risk: data accuracy, an out-of-order head rolls a file back in the stateHash.
    const client = await pool.connect();
    const ids = [randomUUID(), randomUUID(), randomUUID()].sort();
    try {
      for (const [index, id] of ids.entries()) await heads.upsert(client, collectionId, id, randomUUID(), false, 10 + index);
      const newer = randomUUID();
      await heads.upsert(client, collectionId, ids[0], newer, true, 20);
      await heads.upsert(client, collectionId, ids[0], randomUUID(), false, 15);
      expect(await heads.cloudHead(collectionId, ids[0])).toBe(newer);
    } finally { client.release() }
    const original = PgCloudFileHeadRepository.pageSize;
    (PgCloudFileHeadRepository as { pageSize:number }).pageSize = 2;
    try {
      const pages:string[][] = [];
      for await (const page of heads.cloudHeadPages(collectionId)) pages.push(page.map(entry => entry.fileId));
      expect(pages).toEqual([ids.slice(0, 2), ids.slice(2)]);
    } finally { (PgCloudFileHeadRepository as { pageSize:number }).pageSize = original }
  });

  it('only trusts a cloud chunk copy for eviction after Cloud verified it', async() => {
    // risk: irreversible side effect, evicting a chunk whose cloud copy is unverified loses data.
    await state.setEnabled(collectionId, true, wrapped);
    const [local, cloud] = [hex64('4'), hex64('5')];
    await pool.query("INSERT INTO chunks(collection_id,id,size,stored_size) VALUES($1,$2,100,140)", [collectionId, local]);
    await chunks.recordSealedChunk(collectionId, local, cloud, hex64('6'), 140);
    expect(await chunks.uploadedCopy(collectionId, local)).toBeNull();
    expect(await chunks.verifiedCopy(collectionId, local)).toBeNull();
    await chunks.markUploaded(collectionId, cloud);
    expect(await chunks.uploadedCopy(collectionId, local)).toEqual({ cloudChunkId: cloud, cipherBytes: 140, cipherSha256: hex64('6') });
    expect(await chunks.mappedCopy(collectionId, local)).toMatchObject({ cloudChunkId: cloud, keyVersion: 1, wrappedRoot: wrapped, plainBytes: 100 });
    await chunks.stopEviction(collectionId);
    expect(await chunks.verifiedCopy(collectionId, local)).toBeNull();
    await chunks.refreshVerified(collectionId, local);
    expect(await chunks.verifiedCopy(collectionId, local)).toBeNull();
    await chunks.adoptServerCopy(collectionId, cloud, hex64('7'), 150);
    expect(await chunks.verifiedCopy(collectionId, local)).toMatchObject({ cipherSha256: hex64('7'), cipherBytes: 150 });
    await chunks.forgetUpload(collectionId, [cloud]);
    expect(await chunks.uploadedCopy(collectionId, local)).toBeNull();
    await chunks.recordDownloadedCopy(collectionId, local, cloud, hex64('8'), 160);
    expect(await chunks.verifiedCopy(collectionId, local)).toMatchObject({ cipherBytes: 160 });
    expect(await chunks.localCopyOf(collectionId, cloud)).toEqual({ localChunkId: local, storedSize: 140 });
    expect(await chunks.localCopyOf(otherCollectionId, cloud)).toBeNull();
  });

  it('reports backup badges and keeps logs and hidden collections out of every Cloud listing', async() => {
    // risk: privacy, the audit logs area and protected files must never reach Cloud.
    await state.setEnabled(collectionId, true, wrapped);
    const backed = await file('backed.txt');
    const parked = await file('parked.txt');
    await file('indexed.txt', { status: 'indexed' });
    await file('gone.txt', { deleted: true });
    await pool.query('INSERT INTO files_cloud_versions(version_id,collection_id,file_id) VALUES($1,$2,$3)', [backed.versionId, collectionId, backed.fileId]);
    await progress.skipVersion(collectionId, parked.fileId, parked.versionId, 'refused');
    const badges = Object.fromEntries((await collectionCatalog.finderBadges(collectionId)).map(row => [row.path, row.state]));
    expect(badges).toEqual({ 'backed.txt': 'backed-up', 'parked.txt': 'error', 'indexed.txt': 'indexed' });

    const logs = randomUUID();
    await pool.query("INSERT INTO collections(id,name,system_area,cloud_catalog_sync) VALUES($1,'Logs','logs',TRUE)", [logs]);
    await pool.query('UPDATE collections SET cloud_catalog_sync=TRUE WHERE id=$1', [collectionId]);
    expect(await collectionCatalog.backupCandidate(logs)).toBe(false);
    expect(await collectionCatalog.backupCandidate('nope')).toBe(false);
    expect((await collectionCatalog.statusRows()).map(row => row.name)).toEqual(['Other', 'Projects']);
    expect([...await collectionCatalog.localCollectionIds([collectionId, randomUUID(), 'bad'])]).toEqual([collectionId]);
    expect((await webCatalog.visibleCollections('u1')).map(row => row.name)).toEqual(['Projects']);
    expect(await webCatalog.visibleCollections('someone-else')).toEqual([]);
    await pool.query('INSERT INTO files_protected_files(file_id) VALUES($1)', [backed.fileId]);
    expect((await webCatalog.visibleFiles(collectionId, 10)).map(row => row.path)).toEqual(['indexed.txt', 'parked.txt']);
    expect((await webCatalog.visibleFiles(collectionId, 1)).map(row => row.path)).toEqual(['indexed.txt']);
    expect(await webCatalog.visibleFile('u1', parked.fileId)).toMatchObject({ path: 'parked.txt' });
    expect(await webCatalog.visibleFile('someone-else', parked.fileId)).toBeNull();
  });

  it('keeps recursive-delete progress per batch and device, never moving backwards', async() => {
    // risk: irreversible side effect, a second device overwriting batch progress re-sends tombstones out of order.
    const root = await file('folder/a.txt');
    const batchId = randomUUID();
    await progress.save({ batchId, rootItemId: root.fileId, deviceId: 'mac-1', nextIndex: 3, sessions: [] });
    await progress.save({ batchId, rootItemId: root.fileId, deviceId: 'mac-1', nextIndex: 1, sessions: [] });
    await progress.save({ batchId: randomUUID(), rootItemId: root.fileId, deviceId: 'mac-2', nextIndex: 9, sessions: [] });
    expect(await progress.load(root.fileId)).toEqual({ batchId, rootItemId: root.fileId, deviceId: 'mac-1', nextIndex: 3, sessions: [] });
    await progress.clear(batchId);
    expect(await progress.load(root.fileId)).toBeNull();
  });

  it('round-trips a non-empty recursive-delete session list exactly', async () => {
    // risk: irreversible side effect, a resumed folder delete must re-send exactly the tombstones it saved.
    const root = await file('folder/b.txt');
    const batchId = randomUUID();
    const sessions = [
      { journalSeq: 7, fileId: root.fileId, versionId: randomUUID(), parentVersionId: null, baseVersionId: null, deleted: true,
        manifest: { size: 0, chunks: [] }, chunkIds: [], declared: [], staged: [], uploadId: null, present: [], namespaceKind: 'folder' as const },
      { journalSeq: 8, fileId: randomUUID(), versionId: randomUUID(), parentVersionId: randomUUID(), baseVersionId: null, deleted: true,
        manifest: null, chunkIds: ['c1', 'c1'], declared: [{ id: 'c1', cipherBytes: 12, cipherSha256: 'ab' }], staged: ['c1'], uploadId: 'u-1', present: [] },
    ];
    await progress.save({ batchId, rootItemId: root.fileId, deviceId: 'mac-1', nextIndex: 1, sessions });
    expect(await progress.load(root.fileId)).toEqual({ batchId, rootItemId: root.fileId, deviceId: 'mac-1', nextIndex: 1, sessions });
  });
});
