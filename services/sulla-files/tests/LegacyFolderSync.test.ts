// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

// Legacy server sync and replication on the real Files schema (all migrations) with a temp tracked
// root and chunk store. Only the sync server is faked, at the RemoteFilesClient boundary.
// Requires SULLA_FILES_TEST_DATABASE_URL.
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chunkId, encryptChunk } from '../src/crypto.js';
import { TransactionRunner } from '../src/FilesTransaction.js';
import { LegacyFolderSync } from '../src/LegacyFolderSync.js';
import { ReplicationPuller } from '../src/ReplicationPuller.js';
import { migrate } from '../src/db.js';
import { PublicationLifecyclePolicy } from '../src/publicationLifecyclePolicy.js';
import { CollectionPolicyRepository } from '../src/Repositories/CollectionPolicyRepository.js';
import { LegacySyncRepository } from '../src/Repositories/LegacySyncRepository.js';
import { ReplicationRepository } from '../src/Repositories/ReplicationRepository.js';
import { ScanProgress } from '../src/ScanProgress.js';
import { Store } from '../src/store.js';

const databaseUrl = process.env.SULLA_FILES_TEST_DATABASE_URL;
const sha256 = (value:string) => createHash('sha256').update(value).digest('hex');

/** The sync server, faked at its HTTP-client boundary. */
class FakeSyncServer {
  journal:any[] = [];
  prepareReply:any = { missing: [] };
  readonly calls:{ path:string; method:string; body?:any }[] = [];
  readonly uploaded:string[] = [];
  /** Encrypted chunks the server holds for download, by chunk id. */
  readonly served = new Map<string, Uint8Array>();
  readonly downloaded:string[] = [];
  constructor(private readonly collections:()=>any[]) {}
  async json(path:string, init:RequestInit = {}):Promise<any> {
    this.calls.push({ path, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : undefined });
    if (path === '/v1/collections') return init.method === 'POST' ? {} : this.collections();
    if (path.includes('/journal?after=')) return this.journal;
    if (path === '/v1/versions/prepare') return this.prepareReply;
    return {};
  }
  async putChunk(_collectionId:string, id:string):Promise<void> { this.uploaded.push(id) }
  async getChunk(_collectionId:string, id:string):Promise<Uint8Array> {
    const bytes = this.served.get(id);
    if (!bytes) throw new Error('unexpected chunk download');
    this.downloaded.push(id);
    return bytes;
  }
}

describe.skipIf(!databaseUrl)('legacy folder sync + replication (real Postgres, fake sync server)', () => {
  const schema = `files_legacy_sync_${ randomUUID().replaceAll('-', '') }`;
  const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  let pool:pg.Pool;
  let temp = '';
  let collectionId = '';
  let root:any;
  let store:Store;
  let server:FakeSyncServer;
  let sync:LegacyFolderSync;
  let puller:ReplicationPuller;
  const progress = new ScanProgress();
  const deviceId = 'this-device';
  const dataKey = Buffer.alloc(32, 1);
  const dedupKey = Buffer.alloc(32, 2);

  beforeAll(async() => {
    await admin.query(`CREATE SCHEMA "${ schema }"`);
    pool = new pg.Pool({ connectionString: databaseUrl, max: 4, options: `-csearch_path=${ schema },public` });
    await migrate(pool);
  });
  afterAll(async() => { await pool?.end(); await admin.query(`DROP SCHEMA IF EXISTS "${ schema }" CASCADE`); await admin.end(); if (temp) await rm(temp, { recursive: true, force: true }) });
  beforeEach(async() => {
    if (temp) await rm(temp, { recursive: true, force: true });
    temp = await mkdtemp(join(tmpdir(), 'sulla-legacy-sync-'));
    await mkdir(join(temp, 'files')); await mkdir(join(temp, 'chunks'));
    collectionId = randomUUID();
    // Unique explorer_path per collection: collections_explorer_path_owner_org is unique per owner.
    // Separate params: one $n bound to both a uuid and a text column fails with "inconsistent types deduced".
    await pool.query(`INSERT INTO collections(id,owner_user_id,name,kind,home,encrypted_data_key,dedup_key_ciphertext,retention_policy,published,legacy_source,explorer_path)
      VALUES($1,'sync-user','Files','knowledge','synced','{}','{}','{}',TRUE,FALSE,$2)`, [collectionId, `fixture-${ collectionId }`]);
    root = { id: 'default', name: 'Files', path: join(temp, 'files'), syncMode: 'server', paused: false, exclusions: [], primary: true };
    store = new Store(join(temp, 'chunks'));
    server = new FakeSyncServer(() => [{ id: collectionId, name: 'Files' }]);
    const config:any = { serverUrl: 'http://sync.invalid', deviceId, userId: 'sync-user', keyring: { requireLegacySync: async() => undefined, keys: async() => ({ data: dataKey, dedup: dedupKey }) } };
    const transactions = new TransactionRunner(pool);
    const rootFor = () => root;
    puller = new ReplicationPuller(pool, config, store, server as any, new ReplicationRepository(pool), { apply: async() => undefined } as any, transactions,
      new CollectionPolicyRepository(), new PublicationLifecyclePolicy(), rootFor);
    sync = new LegacyFolderSync(pool, config, store, [root], new Map([['default', collectionId]]), progress, server as any, new LegacySyncRepository(pool), puller, transactions,
      new CollectionPolicyRepository(), { homeCollectionId: () => collectionId, rootFor });
  });

  async function localVersion(path:string, content:string) {
    const chunk = sha256(content);
    await store.put(collectionId, chunk, Buffer.from(content));
    await pool.query('INSERT INTO manifests(hash,chunk_ids,total_size) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [sha256(`m:${ content }`), JSON.stringify([chunk]), content.length]);
    await pool.query('INSERT INTO chunks(collection_id,id,size,stored_size,location,refcount) VALUES($1,$2,$3,$3,$4,1) ON CONFLICT DO NOTHING', [collectionId, chunk, content.length, `chunks/${ collectionId }/${ chunk }`]);
    const fileId = (await pool.query("INSERT INTO files(collection_id,path,created_by_type,created_by_id,mime,size) VALUES($1,$2,'user','sync-user','text/plain',$3) RETURNING id", [collectionId, path, content.length])).rows[0].id;
    const versionId = (await pool.query(`INSERT INTO file_versions(file_id,chunk_collection_id,manifest_hash,size,created_by_type,created_by_id,device_id)
      VALUES($1,$2,$3,$4,'user','sync-user',$5) RETURNING id`, [fileId, collectionId, sha256(`m:${ content }`), content.length, deviceId])).rows[0].id;
    await pool.query('UPDATE files SET current_version_id=$2 WHERE id=$1', [fileId, versionId]);
    await pool.query("INSERT INTO journal(collection_id,file_id,version_id,op) VALUES($1,$2,$3,'put')", [collectionId, fileId, versionId]);
    return { fileId, versionId, chunk };
  }
  const cursor = async() => (await pool.query('SELECT last_seq,last_push_seq FROM file_sync_cursors WHERE collection_id=$1 AND device_id=$2', [collectionId, deviceId])).rows[0];

  // risk: data accuracy — every unpushed local version is uploaded once (missing chunks only), committed, and the push cursor advances.
  it('pushes unpushed local versions with their missing chunks and advances the push cursor', async() => {
    const local = await localVersion('a.txt', 'hello server');
    server.prepareReply = { missing: [local.chunk] };
    await sync.syncNow();
    expect(server.uploaded).toEqual([local.chunk]);
    const commit = server.calls.find(call => call.path === '/v1/versions/commit');
    expect(commit?.body).toMatchObject({ collectionId, file: { id: local.fileId }, version: { id: local.versionId } });
    expect((await pool.query('SELECT base_server_version_id FROM file_versions WHERE id=$1', [local.versionId])).rows[0].base_server_version_id).toBe(local.versionId);
    expect(Number((await cursor()).last_push_seq)).toBeGreaterThan(0);
    server.calls.length = 0;
    await sync.syncNow();
    expect(server.calls.some(call => call.path === '/v1/versions/commit')).toBe(false);
    expect(progress.lastSyncAt).toBeDefined();
  });

  // risk: tenant isolation — entries for a collection this device doesn't have are quarantined, never applied, but the cursor moves on.
  it('quarantines journal entries for unknown collections and skips this device\'s own entries', async() => {
    server.journal = [
      { seq: 7, op: 'put', file: { id: randomUUID(), collection_id: randomUUID(), path: 'x.txt' }, version: { device_id: 'other' }, syncAuthority: { canMaterialize: true } },
      { seq: 9, op: 'put', file: { id: randomUUID(), collection_id: collectionId, path: 'mine.txt' }, version: { device_id: deviceId }, syncAuthority: { canMaterialize: true } },
    ];
    await sync.syncNow();
    expect(Number((await cursor()).last_seq)).toBe(9);
    expect((await pool.query('SELECT 1 FROM files WHERE collection_id=$1', [collectionId])).rowCount).toBe(0);
  });

  // risk: data loss — a replicated delete moves local bytes to .sulla-trash and records a delete version; nothing is unlinked.
  it('applies a replicated delete by trashing the local bytes', async() => {
    const local = await localVersion('doc.txt', 'keep me safe');
    await writeFile(join(root.path, 'doc.txt'), 'keep me safe');
    await pool.query("INSERT INTO watched_folder_state(collection_id,path,file_id,content_hash,size,mtime_ms,root_id) VALUES($1,'doc.txt',$2,$3,12,1,'default')", [collectionId, local.fileId, sha256('keep me safe')]);
    const deleteVersion = randomUUID();
    await puller.pull({ op: 'delete', syncAuthority: { canMaterialize: true }, file: { id: local.fileId, collection_id: collectionId, path: 'doc.txt' },
      version: { id: deleteVersion, deleted: true, chunk_collection_id: collectionId, parent_version_id: local.versionId, created_by_type: 'user', created_by_id: 'sync-user', created_at: new Date().toISOString(), message: 'Moved to Trash', device_id: 'other' } });
    expect(await access(join(root.path, 'doc.txt')).then(() => true, () => false)).toBe(false);
    const trashed = await readdir(join(root.path, '.sulla-trash', local.fileId));
    expect(trashed).toHaveLength(1);
    const file = (await pool.query('SELECT current_version_id,deleted_at FROM files WHERE id=$1', [local.fileId])).rows[0];
    expect(file.current_version_id).toBe(deleteVersion);
    expect(file.deleted_at).not.toBeNull();
    expect((await pool.query('SELECT 1 FROM watched_folder_state WHERE file_id=$1', [local.fileId])).rowCount).toBe(0);
  });

  /** A remote device's version as the legacy server journals it: encrypted chunks plus its manifest. */
  async function remoteVersion(path:string, parts:string[], fileId:string = randomUUID()) {
    const chunks = await Promise.all(parts.map(async part => {
      const plain = Buffer.from(part); const id = chunkId(plain, dedupKey);
      return { id, plain, encrypted: await encryptChunk(plain, dataKey, id) };
    }));
    const chunkIds = chunks.map(chunk => chunk.id);
    const content = parts.join(''); const manifestHash = sha256(`remote:${ chunkIds.join(',') }`);
    const versionId = randomUUID();
    const entry = {
      seq: 1, op: 'put', syncAuthority: { canMaterialize: true },
      file: { id: fileId, collection_id: collectionId, path, created_by_type: 'user', created_by_id: 'sync-user', mime: 'text/plain', size: content.length, lifecycle_generation: 0 },
      version: { id: versionId, chunk_collection_id: collectionId, parent_version_id: null, manifest_hash: manifestHash, size: content.length, deleted: false,
        created_by_type: 'user', created_by_id: 'sync-user', created_at: new Date().toISOString(), message: 'Changed on another device', device_id: 'other' },
      manifest: { hash: manifestHash, chunk_ids: chunkIds, total_size: content.length },
    };
    return { entry, chunks, content, fileId, versionId };
  }
  const chunkRows = async(ids:string[]) => (await pool.query('SELECT id,size,stored_size,location,refcount FROM chunks WHERE collection_id=$1 AND id=ANY($2::text[]) ORDER BY id', [collectionId, ids])).rows;

  // risk: data loss (migration 066) — a pulled version whose chunks this device has never seen must register those chunks
  // before its version row; otherwise the 066 guard refuses it (23503) and the remote change never lands.
  it('pulls a remote version whose chunks are new: chunk rows are registered before the version, refcounted once', async() => {
    // 'alpha-' repeats non-adjacently: one chunk row, one reference from this version.
    const remote = await remoteVersion('notes/new.txt', ['alpha-', 'beta-', 'alpha-']);
    for (const chunk of remote.chunks) server.served.set(chunk.id, chunk.encrypted);
    await puller.pull(remote.entry);

    expect(await readFile(join(root.path, 'notes/new.txt'), 'utf8')).toBe(remote.content);
    const file = (await pool.query('SELECT current_version_id,deleted_at FROM files WHERE id=$1', [remote.fileId])).rows[0];
    expect(file.current_version_id).toBe(remote.versionId);
    const distinct = [...new Set(remote.chunks.map(chunk => chunk.id))];
    const rows = await chunkRows(distinct);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      const chunk = remote.chunks.find(candidate => candidate.id === row.id)!;
      expect(row).toMatchObject({ size: chunk.plain.length, stored_size: chunk.encrypted.byteLength, location: `chunks/${ collectionId }/${ chunk.id }` });
      expect(Number(row.refcount)).toBe(1);
      expect(await store.has(collectionId, chunk.id)).toBe(true);
    }

    // Re-pulling the same journal entry is idempotent: no second reference.
    await puller.pull(remote.entry);
    expect((await chunkRows(distinct)).map(row => Number(row.refcount))).toEqual([1, 1]);
  });

  // risk: data accuracy — chunks this device already holds and has registered are reused, not duplicated or downloaded.
  it('pulls a remote version whose chunks already exist locally and adds one reference', async() => {
    const remote = await remoteVersion('shared.txt', ['already here']);
    const [chunk] = remote.chunks;
    await store.put(collectionId, chunk.id, chunk.encrypted);
    await pool.query('INSERT INTO chunks(collection_id,id,size,stored_size,location,refcount) VALUES($1,$2,$3,$4,$5,1)', [collectionId, chunk.id, chunk.plain.length, chunk.encrypted.byteLength, `chunks/${ collectionId }/${ chunk.id }`]);
    await puller.pull(remote.entry);

    expect(server.downloaded).toEqual([]);
    expect(await readFile(join(root.path, 'shared.txt'), 'utf8')).toBe('already here');
    expect((await pool.query('SELECT current_version_id FROM files WHERE id=$1', [remote.fileId])).rows[0].current_version_id).toBe(remote.versionId);
    expect((await chunkRows([chunk.id])).map(row => Number(row.refcount))).toEqual([2]);
  });

  // risk: data accuracy — a chunk that fails to decrypt (wrong bytes from the server) must not register metadata or a version.
  it('rolls back without chunk rows or a version when a downloaded chunk fails verification', async() => {
    const remote = await remoteVersion('bad.txt', ['tampered']);
    server.served.set(remote.chunks[0].id, Buffer.from('not the encrypted chunk'));
    await expect(puller.pull(remote.entry)).rejects.toThrow();
    expect(await chunkRows([remote.chunks[0].id])).toHaveLength(0);
    expect((await pool.query('SELECT 1 FROM file_versions WHERE id=$1', [remote.versionId])).rowCount).toBe(0);
  });
});
