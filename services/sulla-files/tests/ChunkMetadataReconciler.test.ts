// Sulla Desktop · https://sulladesktop.com.
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ChunkMetadataReconciler } from '../src/ChunkMetadataReconciler.js';
import { chunkId, decryptAndVerifyChunk, encryptChunk } from '../src/crypto.js';
import { Store } from '../src/store.js';

const databaseUrl = process.env.SULLA_FILES_TEST_DATABASE_URL;
const migration = readFileSync(new URL('../migrations/066_chunk_metadata_integrity.sql', import.meta.url), 'utf8');

describe.skipIf(!databaseUrl)('chunk metadata integrity (real Postgres)', () => {
  const schema = `files_chunk_integrity_${randomUUID().replaceAll('-', '')}`;
  const pool = new pg.Pool({ connectionString:databaseUrl, options:`-c search_path=${schema}`, max:4 });
  let root = '';
  let store:Store;
  let collectionId = randomUUID();
  const data = Buffer.alloc(4096, 71);
  const dataKey = Buffer.alloc(32, 8), dedupKey = Buffer.alloc(32, 9);
  const keyring = { keys:async() => ({ data:dataKey, dedup:dedupKey }) } as any;

  beforeAll(async() => {
    await pool.query(`CREATE SCHEMA ${schema}`);
    await pool.query(`CREATE TABLE manifests(hash text PRIMARY KEY, chunk_ids jsonb NOT NULL, total_size bigint NOT NULL)`);
    await pool.query(`CREATE TABLE chunks(collection_id uuid NOT NULL,id text NOT NULL,size int NOT NULL,stored_size int NOT NULL,location text NOT NULL,refcount bigint NOT NULL,PRIMARY KEY(collection_id,id))`);
    await pool.query(`CREATE TABLE file_versions(id uuid PRIMARY KEY,chunk_collection_id uuid NOT NULL,manifest_hash text,deleted boolean NOT NULL DEFAULT false)`);
    await pool.query(migration);
    await mkdir('/mnt/worktrees/_scratch/agent-job-1794800404714-91', { recursive:true });
    root = await mkdtemp('/mnt/worktrees/_scratch/agent-job-1794800404714-91/chunk-integrity-');
    store = new Store(root);
  });
  afterAll(async() => { await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await pool.end(); if (root) await rm(root, { recursive:true, force:true }) });
  beforeEach(async() => { await pool.query('TRUNCATE file_versions,manifests,chunks'); collectionId = randomUUID() });

  async function seedChunk() {
    const id = chunkId(data, dedupKey), envelope = await encryptChunk(data, dataKey, id);
    await store.put(collectionId, id, envelope);
    const manifestHash = randomUUID();
    await pool.query('INSERT INTO manifests(hash,chunk_ids,total_size) VALUES($1,$2,$3)', [manifestHash, JSON.stringify([id]), data.length]);
    return { id, envelope, manifestHash };
  }

  async function seedVersions(manifestHash:string, count:number, allowMissingMetadata = false) {
    if (allowMissingMetadata) await pool.query('ALTER TABLE file_versions DISABLE TRIGGER files_guard_version_chunks');
    try {
      for (let index = 0; index < count; index++) await pool.query('INSERT INTO file_versions(id,chunk_collection_id,manifest_hash) VALUES($1,$2,$3)', [randomUUID(),collectionId,manifestHash]);
    } finally { if (allowMissingMetadata) await pool.query('ALTER TABLE file_versions ENABLE TRIGGER files_guard_version_chunks') }
  }

  // risk: data loss — a backend killed after version insertion must roll back the version and chunk metadata atomically.
  it('leaves no version or missing metadata after a connection dies mid-transaction', async() => {
    const { id, manifestHash } = await seedChunk();
    const client = await pool.connect();
    const killer = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('INSERT INTO chunks(collection_id,id,size,stored_size,location,refcount) VALUES($1,$2,$3,$4,$5,1)', [collectionId,id,data.length,1,`chunks/${collectionId}/${id}`]);
      await client.query('INSERT INTO file_versions(id,chunk_collection_id,manifest_hash) VALUES($1,$2,$3)', [randomUUID(),collectionId,manifestHash]);
      const pid = (await client.query('SELECT pg_backend_pid() pid')).rows[0].pid;
      await killer.query('SELECT pg_terminate_backend($1)', [pid]);
      await expect(client.query('COMMIT')).rejects.toThrow();
    } finally { client.release(true); killer.release() }
    expect(Number((await pool.query('SELECT count(*) FROM file_versions')).rows[0].count)).toBe(0);
    expect(Number((await pool.query('SELECT count(*) FROM chunks')).rows[0].count)).toBe(0);
  });

  // risk: data loss — GC cannot remove a chunk still referenced by any restorable version.
  it('refuses to delete a shared chunk while any version retains it', async() => {
    const { id, manifestHash } = await seedChunk();
    await pool.query('INSERT INTO chunks(collection_id,id,size,stored_size,location,refcount) VALUES($1,$2,$3,$4,$5,2)', [collectionId,id,data.length,100,`chunks/${collectionId}/${id}`]);
    await seedVersions(manifestHash,2);
    await expect(pool.query('DELETE FROM chunks WHERE collection_id=$1 AND id=$2', [collectionId,id])).rejects.toThrow(/referenced by a restorable file version/);
    expect(Number((await pool.query('SELECT refcount FROM chunks WHERE collection_id=$1 AND id=$2', [collectionId,id])).rows[0].refcount)).toBe(2);
  });

  // risk: data loss — repair restores only authenticated chunk metadata and makes subsequent reads byte-identical.
  it('repairs a verified on-disk chunk and the normal decrypt/read path returns original bytes', async() => {
    const { id, envelope, manifestHash } = await seedChunk();
    await seedVersions(manifestHash,2,true);
    const report = await new ChunkMetadataReconciler(pool,store,keyring).run({ apply:true });
    expect(report.restored).toEqual([expect.objectContaining({ collectionId,id,size:data.length,storedSize:envelope.length,refcount:2 })]);
    const row = (await pool.query('SELECT size,stored_size FROM chunks WHERE collection_id=$1 AND id=$2', [collectionId,id])).rows[0];
    const bytes = await store.getBounded(collectionId,id,16_000,Number(row.stored_size));
    expect(await decryptAndVerifyChunk(bytes,dataKey,dedupKey,id,Number(row.size))).toEqual(data);
  });

  // risk: data loss — a default reconciliation is read-only and leaves a broken row absent until explicit apply.
  it('dry-run reports repair candidates without changing database or chunk files', async() => {
    const { id, manifestHash } = await seedChunk();
    await seedVersions(manifestHash,1,true);
    const before = (await pool.query('SELECT count(*) FROM chunks')).rows[0].count;
    const report = await new ChunkMetadataReconciler(pool,store,keyring).run();
    expect(report.dryRun).toBe(true);
    expect(report.missingMetadata.map(item => item.id)).toEqual([id]);
    expect(report.restored).toEqual([]);
    expect((await pool.query('SELECT count(*) FROM chunks')).rows[0].count).toBe(before);
    expect(await store.has(collectionId,id)).toBe(true);
  });

  // risk: data loss — the database-level guard rejects a version whose manifest chunk metadata is absent.
  it('rejects an attempt to commit a manifest-backed version with a missing chunk row', async() => {
    const { manifestHash } = await seedChunk();
    await expect(pool.query('INSERT INTO file_versions(id,chunk_collection_id,manifest_hash) VALUES($1,$2,$3)', [randomUUID(),collectionId,manifestHash])).rejects.toThrow(/missing chunk metadata/);
  });
});
