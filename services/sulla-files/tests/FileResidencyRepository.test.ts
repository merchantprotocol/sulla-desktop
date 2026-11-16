// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Runs the real residency SQL against Postgres. Point SULLA_FILES_TEST_DATABASE_URL at a throwaway
// database (e.g. `docker run --rm -e POSTGRES_PASSWORD=x -p 55432:5432 postgres:16-alpine`). Each run
// creates and drops its own schema with the minimal Files tables and the real 017 residency migration.
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { TransactionRunner } from '../src/FilesTransaction.js';
import { FileResidencyRepository } from '../src/Repositories/FileResidencyRepository.js';
import { ResidencySyncBundleRepository } from '../src/Repositories/ResidencySyncBundleRepository.js';
import { FileResidencyManager } from '../src/residency.js';
import { ResidencySyncBundleLoader } from '../src/residencyHttp.js';
import { FilesMutationCoordinator } from '../src/safeFilesystem.js';

const databaseUrl = process.env.SULLA_FILES_TEST_DATABASE_URL;
const migration = (name:string) => readFileSync(new URL(`../migrations/${ name }`, import.meta.url), 'utf8');
const hex = (seed:string) => createHash('sha256').update(seed).digest('hex');

describe.skipIf(!databaseUrl)('file residency state and remote proofs (real Postgres)', () => {
  const schema = `files_residency_spec_${ randomUUID().replaceAll('-', '') }`;
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1, idleTimeoutMillis: 0 });
  const rows = new FileResidencyRepository(pool);
  const transactions = new TransactionRunner(pool);
  let collectionId = '';

  beforeAll(async() => {
    await pool.query(`CREATE SCHEMA ${ schema }`);
    await pool.query(`SET search_path TO ${ schema }`);
    await pool.query('CREATE TABLE collections(id uuid PRIMARY KEY,system_area text,name text)');
    await pool.query('CREATE TABLE manifests(hash text PRIMARY KEY,chunk_ids jsonb NOT NULL,total_size bigint NOT NULL)');
    await pool.query(`CREATE TABLE chunks(collection_id uuid NOT NULL REFERENCES collections(id),id text NOT NULL,size integer NOT NULL,
      stored_size integer NOT NULL,location text NOT NULL DEFAULT 'local',PRIMARY KEY(collection_id,id))`);
    await pool.query(`CREATE TABLE files(id uuid PRIMARY KEY,collection_id uuid NOT NULL REFERENCES collections(id),path text NOT NULL,current_version_id uuid,
      deleted_at timestamptz,expires_at timestamptz,created_by_type text NOT NULL DEFAULT 'user',created_by_id text NOT NULL DEFAULT 'u1',mime text,size bigint,
      created_at timestamptz NOT NULL DEFAULT NOW(),updated_at timestamptz NOT NULL DEFAULT NOW(),extraction_status text,draft_version_id uuid,published_version_id uuid,
      versioning_enabled boolean,major_minor_enabled boolean,require_approval boolean,require_checkout boolean,retention_mode text,retain_until timestamptz,
      record_lock_type text,lifecycle_generation bigint,operation_revision bigint,private_note text,UNIQUE(collection_id,path))`);
    await pool.query(`CREATE TABLE file_versions(id uuid PRIMARY KEY,file_id uuid NOT NULL REFERENCES files(id),chunk_collection_id uuid NOT NULL REFERENCES collections(id),
      manifest_hash text REFERENCES manifests(hash),size bigint NOT NULL,deleted boolean NOT NULL DEFAULT FALSE,parent_version_id uuid,base_server_version_id uuid)`);
    await pool.query('CREATE TABLE file_roots(id text PRIMARY KEY,collection_id uuid NOT NULL,enabled boolean NOT NULL DEFAULT TRUE)');
    await pool.query(`CREATE TABLE watched_folder_state(collection_id uuid NOT NULL,path text NOT NULL,file_id uuid NOT NULL,content_hash text NOT NULL,
      size bigint NOT NULL,mtime_ms bigint NOT NULL,root_id text NOT NULL,PRIMARY KEY(collection_id,path))`);
    await pool.query('CREATE TABLE files_protected_files(file_id uuid PRIMARY KEY)');
    await pool.query(migration('017_file_residency.sql'));
  });
  afterAll(async() => { await pool.query(`DROP SCHEMA IF EXISTS ${ schema } CASCADE`); await pool.end() });
  beforeEach(async() => {
    await pool.query(`TRUNCATE file_residency,file_remote_chunk_proofs,file_remote_version_proofs,files_remote_key_recovery,watched_folder_state,
      files_protected_files,file_roots,file_versions,files,chunks,manifests,collections CASCADE`);
    collectionId = randomUUID();
    await pool.query('INSERT INTO collections(id) VALUES($1)', [collectionId]);
    await pool.query("INSERT INTO file_roots(id,collection_id) VALUES('default',$1)", [collectionId]);
  });

  /** One current version of `path` whose manifest lists `chunks` (plaintext sizes must match geometry). */
  async function seedFile(path:string, chunks:{ id:string; size:number; storedSize?:number }[] = [{ id: hex(`${ path }:0`), size: 3 }]) {
    const fileId = randomUUID(); const versionId = randomUUID();
    const size = chunks.reduce((sum, chunk) => sum + chunk.size, 0);
    const manifestHash = hex(`${ versionId }:manifest`);
    await pool.query('INSERT INTO manifests(hash,chunk_ids,total_size) VALUES($1,$2,$3)', [manifestHash, JSON.stringify(chunks.map(chunk => chunk.id)), size]);
    for (const chunk of chunks) {
      await pool.query('INSERT INTO chunks(collection_id,id,size,stored_size) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING', [collectionId, chunk.id, chunk.size, chunk.storedSize ?? chunk.size + 64]);
    }
    await pool.query('INSERT INTO files(id,collection_id,path,size,private_note) VALUES($1,$2,$3,$4,$5)', [fileId, collectionId, path, size, 'never published']);
    await pool.query('INSERT INTO file_versions(id,file_id,chunk_collection_id,manifest_hash,size) VALUES($1,$2,$3,$4,$5)', [versionId, fileId, collectionId, manifestHash, size]);
    await pool.query('UPDATE files SET current_version_id=$2 WHERE id=$1', [fileId, versionId]);
    return { fileId, versionId, manifestHash, chunks, size, path };
  }
  const residency = async(fileId:string) => (await pool.query('SELECT * FROM file_residency WHERE file_id=$1', [fileId])).rows[0];
  const proofChunks = (chunks:{ id:string; size:number }[]) => chunks.map(chunk => ({ id: chunk.id, size: chunk.size, storedSize: chunk.size + 64, ciphertextSha256: hex(`ct:${ chunk.id }`) }));
  const saveProof = (file:{ versionId:string; manifestHash:string; chunks:{ id:string; size:number }[] }, keyVersion = 1, keyEpoch = 1, chunks = proofChunks(file.chunks)) =>
    transactions.run('spec.proof', client => rows.saveRemoteProof(client, {
      versionId: file.versionId, collectionId, manifestHash: file.manifestHash, remoteRevision: 'rev-1',
      chunksDigest: hex(JSON.stringify(chunks)), keyVersion, keyEpoch, chunks,
    }));

  describe('state transitions', () => {
    // risk: data accuracy — each begin is a new generation and clears the previous failure.
    it('begin records the operation and bumps the generation on every retry', async() => {
      const file = await seedFile('docs/a.txt');
      expect(await rows.findStatus(file.fileId)).toBeUndefined();
      const first = randomUUID(); const second = randomUUID();
      await rows.begin(file.fileId, file.versionId, first, 'online-only', 'evicting');
      await rows.recordFailure(file.fileId, first, false, 'remote down');
      expect(await rows.findStatus(file.fileId)).toEqual({ desired_state: 'online-only', state: 'error', last_error: 'remote down' });
      await rows.begin(file.fileId, file.versionId, second, 'local', 'hydrating');
      expect(await residency(file.fileId)).toMatchObject({ desired_state: 'local', state: 'hydrating', operation_id: second, generation: '2', last_error: null });
    });

    // risk: data loss — a failure that must stay pending (eviction not rolled back) keeps its state.
    it('recordFailure keeps a pending state when asked and ignores a stale operation id', async() => {
      const file = await seedFile('docs/a.txt');
      const operation = randomUUID();
      await rows.begin(file.fileId, file.versionId, operation, 'online-only', 'evicting');
      await rows.recordFailure(file.fileId, operation, true, 'restore failed');
      expect(await residency(file.fileId)).toMatchObject({ state: 'evicting', last_error: 'restore failed' });
      await rows.recordFailure(file.fileId, randomUUID(), false, 'from an old run');
      expect(await residency(file.fileId)).toMatchObject({ state: 'evicting', last_error: 'restore failed' });
    });

    // risk: data loss — work for an old version or a superseded operation must not commit.
    it('isOperationCurrent is false once the file moves to a new version or the operation is superseded', async() => {
      const file = await seedFile('docs/a.txt');
      const operation = randomUUID();
      await rows.begin(file.fileId, file.versionId, operation, 'online-only', 'evicting');
      expect(await rows.isOperationCurrent(file.fileId, file.versionId, operation, 'evicting')).toBe(true);
      expect(await rows.isOperationCurrent(file.fileId, file.versionId, operation, 'hydrating')).toBe(false);
      expect(await rows.isOperationCurrent(file.fileId, file.versionId, randomUUID(), 'evicting')).toBe(false);
      const next = await seedFile('docs/b.txt');
      await pool.query('UPDATE file_versions SET file_id=$1 WHERE id=$2', [file.fileId, next.versionId]);
      await pool.query('UPDATE files SET current_version_id=$2 WHERE id=$1', [file.fileId, next.versionId]);
      expect(await rows.isOperationCurrent(file.fileId, file.versionId, operation, 'evicting')).toBe(false);
    });

    // risk: data loss — eviction commits only with a stored remote proof; the watcher row is dropped atomically.
    it('finishes an eviction: online-only, operation cleared, watched row removed', async() => {
      const file = await seedFile('docs/a.txt');
      const operation = randomUUID();
      await pool.query("INSERT INTO watched_folder_state VALUES($1,'docs/a.txt',$2,'h',3,1,'default')", [collectionId, file.fileId]);
      await rows.begin(file.fileId, file.versionId, operation, 'online-only', 'evicting');
      const finish = () => transactions.run('spec.evict', async client => {
        if (!await rows.lockOperation(client, file.fileId, file.versionId, operation, 'evicting')) throw new Error('stale');
        if (!await rows.hasRemoteVersionProof(client, file.versionId, collectionId, file.manifestHash)) throw new Error('no proof');
        await rows.deleteWatchedState(client, collectionId, file.fileId, file.path);
        await rows.markOnlineOnly(client, file.fileId);
      });
      await expect(finish()).rejects.toThrow('no proof');
      expect(await rows.findWatchedState(collectionId, file.fileId, file.path)).toBeDefined();
      await saveProof(file);
      await finish();
      expect(await residency(file.fileId)).toMatchObject({ desired_state: 'online-only', state: 'online-only', operation_id: null, last_error: null });
      expect(await rows.findWatchedState(collectionId, file.fileId, file.path)).toBeUndefined();
      await expect(finish()).rejects.toThrow('stale');
    });

    // risk: data accuracy — hydration rewrites the watcher row to the verified local bytes.
    it('finishes a hydration: local state and the verified watched row', async() => {
      const file = await seedFile('docs/a.txt');
      const operation = randomUUID();
      await pool.query("INSERT INTO watched_folder_state VALUES($1,'docs/a.txt',$2,'old',1,1,'default')", [collectionId, file.fileId]);
      await rows.begin(file.fileId, file.versionId, operation, 'local', 'hydrating');
      await transactions.run('spec.hydrate', async client => {
        expect(await rows.lockOperation(client, file.fileId, file.versionId, operation, 'hydrating')).toBe(true);
        await rows.upsertWatchedState(client, { collectionId, path: file.path, fileId: file.fileId, contentHash: 'new', size: 3, mtimeMs: 42 });
        await rows.markLocal(client, file.fileId);
      });
      expect(await rows.findWatchedState(collectionId, file.fileId, file.path)).toEqual({ content_hash: 'new', size: '3', mtime_ms: '42' });
      expect(await rows.findStatus(file.fileId)).toEqual({ desired_state: 'local', state: 'local', last_error: null });
    });

    // risk: availability — crash recovery sees only in-flight operations, oldest first.
    it('lists only evicting and hydrating operations in update order', async() => {
      const a = await seedFile('a.txt'); const b = await seedFile('b.txt'); const c = await seedFile('c.txt');
      const opA = randomUUID(); const opB = randomUUID();
      await rows.begin(b.fileId, b.versionId, opB, 'local', 'hydrating');
      await rows.begin(a.fileId, a.versionId, opA, 'online-only', 'evicting');
      await rows.begin(c.fileId, c.versionId, randomUUID(), 'online-only', 'evicting');
      await pool.query("UPDATE file_residency SET state='error' WHERE file_id=$1", [c.fileId]);
      await pool.query("UPDATE file_residency SET updated_at=NOW()-interval '1 hour' WHERE file_id=$1", [b.fileId]);
      expect(await rows.listPending()).toEqual([
        { file_id: b.fileId, state: 'hydrating', operation_id: opB },
        { file_id: a.fileId, state: 'evicting', operation_id: opA },
      ]);
    });
  });

  describe('current version and proofs', () => {
    // risk: data accuracy — only the live current version in the enabled default root is eligible.
    it('findCurrentVersion excludes deleted files, deleted versions and a disabled root', async() => {
      const file = await seedFile('docs/a.txt');
      expect(await rows.findCurrentVersion(file.fileId)).toMatchObject({ file_id: file.fileId, version_id: file.versionId, path: 'docs/a.txt', chunk_ids: [file.chunks[0].id] });
      await pool.query("UPDATE file_roots SET enabled=FALSE WHERE id='default'");
      expect(await rows.findCurrentVersion(file.fileId)).toBeUndefined();
      await pool.query("UPDATE file_roots SET enabled=TRUE WHERE id='default'");
      await pool.query('UPDATE file_versions SET deleted=TRUE WHERE id=$1', [file.versionId]);
      expect(await rows.findCurrentVersion(file.fileId)).toBeUndefined();
      await pool.query('UPDATE file_versions SET deleted=FALSE WHERE id=$1', [file.versionId]);
      await pool.query('UPDATE files SET deleted_at=NOW() WHERE id=$1', [file.fileId]);
      expect(await rows.findCurrentVersion(file.fileId)).toBeUndefined();
    });

    // risk: data accuracy — a re-verified proof replaces every chunk row; reads come back in ordinal order.
    it('saveRemoteProof replaces the chunk list and findRemoteProof returns it in order', async() => {
      const file = await seedFile('big.bin', [{ id: hex('c0'), size: 4 * 1024 * 1024 }, { id: hex('c1'), size: 7 }]);
      await saveProof(file, 1, 1, proofChunks([...file.chunks].reverse()));
      await saveProof(file, 2, 3);
      const proof = await rows.findRemoteProof(file.versionId, collectionId, file.manifestHash);
      expect(proof).toMatchObject({ key_version: 2, key_epoch: 3 });
      expect(proof!.chunks).toEqual(proofChunks(file.chunks));
      expect(await rows.findRemoteProof(file.versionId, collectionId, hex('other manifest'))).toBeUndefined();
    });

    // risk: security — crash recovery may only trust a proof made under the collection's current key.
    it('findRecoverableRemoteProof and isKeyRecoveryCurrent require the current recovery key', async() => {
      const file = await seedFile('docs/a.txt');
      await saveProof(file, 1, 1);
      const context = { collectionId, principalId: 'principal-1', keyVersion: 1, epoch: 1 };
      expect(await rows.findRecoverableRemoteProof(file.versionId, collectionId, file.manifestHash)).toBeUndefined();
      expect(await rows.isKeyRecoveryCurrent(context)).toBe(false);
      await pool.query("INSERT INTO files_remote_key_recovery VALUES($1,'principal-1',1,1,'authority',NOW())", [collectionId]);
      expect(await rows.isKeyRecoveryCurrent(context)).toBe(true);
      expect(await rows.isKeyRecoveryCurrent({ ...context, principalId: 'someone-else' })).toBe(false);
      expect((await rows.findRecoverableRemoteProof(file.versionId, collectionId, file.manifestHash))?.chunks).toEqual(proofChunks(file.chunks));
      await pool.query('UPDATE files_remote_key_recovery SET key_epoch=2 WHERE collection_id=$1', [collectionId]);
      expect(await rows.findRecoverableRemoteProof(file.versionId, collectionId, file.manifestHash)).toBeUndefined();
    });

    // risk: data loss — cached ciphertext is kept while any version lacks a proof or any current file is local.
    it('findChunkHolds keeps chunks needed by unproven history or a local current file', async() => {
      const shared = { id: hex('shared'), size: 3 };
      const a = await seedFile('a.txt', [shared]);
      expect(await rows.findChunkHolds(collectionId, shared.id)).toEqual({ unbacked_history: true, locally_required: true });
      await saveProof(a);
      await rows.begin(a.fileId, a.versionId, randomUUID(), 'online-only', 'evicting');
      await pool.query("UPDATE file_residency SET state='online-only' WHERE file_id=$1", [a.fileId]);
      expect(await rows.findChunkHolds(collectionId, shared.id)).toEqual({ unbacked_history: false, locally_required: false });
      await seedFile('b.txt', [shared]);
      expect(await rows.findChunkHolds(collectionId, shared.id)).toEqual({ unbacked_history: true, locally_required: true });
    });
  });

  describe('sync bundle for remote publication', () => {
    const loader = new ResidencySyncBundleLoader(new ResidencySyncBundleRepository(pool));
    const expected = (file:Awaited<ReturnType<typeof seedFile>>) => ({
      fileId: file.fileId, versionId: file.versionId, collectionId, chunkCollectionId: collectionId, manifestHash: file.manifestHash,
      size: file.size, chunks: proofChunks(file.chunks), keyContext: { collectionId, principalId: 'p', keyVersion: 1, epoch: 1 },
    });

    // risk: privacy — the published file row carries only the listed sync columns, chunks in manifest order.
    it('loads the current version with chunks in manifest order and no unlisted file columns', async() => {
      const file = await seedFile('big.bin', [{ id: hex('b0'), size: 4 * 1024 * 1024 }, { id: hex('b1'), size: 9 }]);
      const bundle = await loader.load(expected(file));
      expect(bundle.chunks.map(chunk => chunk.id)).toEqual(file.chunks.map(chunk => chunk.id));
      expect(bundle.file).toMatchObject({ id: file.fileId, path: 'big.bin', current_version_id: file.versionId });
      expect(bundle.file).not.toHaveProperty('private_note');
      expect(bundle.baseServerVersionId).toBeNull();
    });

    // risk: data accuracy — a version that stopped being current is never published.
    it('refuses a version that is no longer current or whose chunk metadata changed', async() => {
      const file = await seedFile('a.txt');
      await pool.query('UPDATE chunks SET stored_size=stored_size+1 WHERE id=$1', [file.chunks[0].id]);
      await expect(loader.load(expected(file))).rejects.toThrow('Chunk metadata changed before remote publication');
      await pool.query('UPDATE files SET current_version_id=NULL WHERE id=$1', [file.fileId]);
      await expect(loader.load(expected(file))).rejects.toThrow('Current database version changed before remote publication');
    });
  });

  describe.skipIf(process.platform !== 'linux')('FileResidencyManager refusals', () => {
    let root = '';
    let manager:FileResidencyManager;
    beforeEach(async() => {
      root = join(await realpath(await mkdtemp(join(tmpdir(), 'sulla-residency-'))), 'root');
      await mkdir(join(root, 'docs'), { recursive: true });
      vi.spyOn(FilesMutationCoordinator, 'requireAtomicRename').mockResolvedValue(undefined);
      const unused = {} as any;
      manager = new FileResidencyManager(pool, unused, unused, unused, { authenticated: true } as any, new FilesMutationCoordinator(root));
    });
    afterEach(async() => { vi.restoreAllMocks(); await rm(join(root, '..'), { recursive: true, force: true }) });

    // risk: security — online-only requires an authenticated remote transport.
    it('refuses an unauthenticated transport', () => {
      expect(() => new FileResidencyManager(pool, {} as any, {} as any, {} as any, { authenticated: false } as any, new FilesMutationCoordinator(root)))
        .toThrow('Online-only requires an authenticated remote transport');
    });

    // risk: data loss — a file the watcher has not recorded may have pending edits and is never evicted.
    it('makeOnlineOnly records an error and keeps the file when the local state is untracked', async() => {
      const file = await seedFile('docs/a.txt');
      await writeFile(join(root, 'docs/a.txt'), 'abc');
      await expect(manager.makeOnlineOnly(file.fileId)).rejects.toThrow('pending or untracked state');
      expect(await manager.status(file.fileId)).toEqual({ desiredState: 'online-only', state: 'error', lastError: 'Online-only refused because the local file has pending or untracked state' });
      expect(await readFile(join(root, 'docs/a.txt'), 'utf8')).toBe('abc');
    });

    // risk: data loss — hydration never overwrites a local file.
    it('keepOnComputer refuses to overwrite an existing local file', async() => {
      const file = await seedFile('docs/a.txt');
      await writeFile(join(root, 'docs/a.txt'), 'user edit');
      await expect(manager.keepOnComputer(file.fileId)).rejects.toThrow('Hydration will not overwrite an existing local file');
      expect(await manager.status(file.fileId)).toMatchObject({ desiredState: 'local', state: 'error' });
      expect(await readFile(join(root, 'docs/a.txt'), 'utf8')).toBe('user edit');
    });

    // risk: security — protected files are refused before any residency state is written.
    it('refuses protected files without recording an operation', async() => {
      const file = await seedFile('vault/keys.txt');
      await expect(manager.makeOnlineOnly(file.fileId)).rejects.toMatchObject({ status: 403 });
      const flagged = await seedFile('docs/flagged.txt');
      await pool.query('INSERT INTO files_protected_files(file_id) VALUES($1)', [flagged.fileId]);
      await expect(manager.keepOnComputer(flagged.fileId)).rejects.toMatchObject({ status: 403 });
      expect(await residency(file.fileId)).toBeUndefined();
      expect(await residency(flagged.fileId)).toBeUndefined();
    });

    // risk: data accuracy — inconsistent chunk metadata stops the operation before any state change.
    it('refuses a version whose chunk metadata does not match the manifest geometry', async() => {
      const file = await seedFile('docs/a.txt');
      await pool.query('UPDATE chunks SET size=4 WHERE id=$1', [file.chunks[0].id]);
      await expect(manager.makeOnlineOnly(file.fileId)).rejects.toThrow(`Missing or invalid chunk metadata for ${ file.chunks[0].id }`);
      await pool.query('UPDATE manifests SET total_size=99 WHERE hash=$1', [file.manifestHash]);
      await expect(manager.makeOnlineOnly(file.fileId)).rejects.toThrow('File manifest has invalid chunk geometry');
      expect(await residency(file.fileId)).toBeUndefined();
    });

    // risk: data accuracy — a file with no residency row reports the local default.
    it('status defaults to local for a file never moved', async() => {
      const file = await seedFile('docs/a.txt');
      expect(await manager.status(file.fileId)).toEqual({ desiredState: 'local', state: 'local', lastError: null });
    });
  });
});
