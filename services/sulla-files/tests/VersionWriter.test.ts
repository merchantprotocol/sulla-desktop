// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Runs VersionWriter + VersionWriteRepository (moved from app.ts insertVersion) and AutomergeTextStore +
// AutomergeDocumentRepository against a real Postgres schema with every Files migration applied.
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { editTextDocument, newTextDocument } from '../src/automergeText.js';
import { chunkId, encryptChunk } from '../src/crypto.js';
import { migrate } from '../src/db.js';
import { TransactionRunner } from '../src/FilesTransaction.js';
import { FilesAccessGate } from '../src/Http/FilesAccessGate.js';
import { ManifestChunkRegistry } from '../src/ManifestChunkRegistry.js';
import { AutomergeDocumentRepository } from '../src/Repositories/AutomergeDocumentRepository.js';
import { VersionWriteRepository } from '../src/Repositories/VersionWriteRepository.js';
import { AutomergeTextStore } from '../src/Services/AutomergeTextStore.js';
import { VersionWriter } from '../src/Services/VersionWriter.js';
import { Store } from '../src/store.js';
import { CachingStore } from '../src/chunkCache/index.js';
import { VersionContentStager } from '../src/VersionContentStager.js';

const databaseUrl = process.env.SULLA_FILES_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('VersionWriter and Automerge text store (real Postgres)', () => {
  const schema = `files_version_writer_${ randomUUID().replaceAll('-', '') }`;
  const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  let pool:pg.Pool; let store:Store; let root = ''; let writer:VersionWriter; let transactions:TransactionRunner;
  const collectionId = randomUUID(); const otherCollectionId = randomUUID();
  const actor = { userId: 'writer-user', deviceId: 'device-1', kind: 'capability' as const };

  beforeAll(async() => {
    await admin.query(`CREATE SCHEMA "${ schema }"`);
    pool = new pg.Pool({ connectionString: databaseUrl, max: 2, options: `-csearch_path=${ schema },public` });
    await migrate(pool);
    for (const [id, path] of [[collectionId, 'a'], [otherCollectionId, 'b']]) {
      await pool.query(`INSERT INTO collections(id,owner_user_id,name,kind,home,encrypted_data_key,dedup_key_ciphertext,retention_policy,published,legacy_source,explorer_path)
        VALUES($1,'writer-user','Files','knowledge','desktop-only','{}','{}','{}',TRUE,FALSE,$2)`, [id, `spec-${ path }`]);
    }
    root = await mkdtemp(join(tmpdir(), 'sulla-version-writer-'));
    const keys = { keys: async() => ({ data: Buffer.alloc(32, 1), dedup: Buffer.alloc(32, 2) }) };
    store = new CachingStore({ db: pool, root, keyring: keys as any, source: {
      verifiedCopy: async() => null, reverify: async() => false, fetchPlain: async() => Buffer.alloc(0),
    } });
    const config:any = { deviceId: 'local-device', keyring: keys };
    writer = new VersionWriter(config, new FilesAccessGate(pool), store, new VersionContentStager(keys, store, { chunkId, encryptChunk }), new ManifestChunkRegistry(), new VersionWriteRepository());
    transactions = new TransactionRunner(pool);
  }, 30_000);
  afterAll(async() => {
    await pool?.end(); await admin.query(`DROP SCHEMA IF EXISTS "${ schema }" CASCADE`); await admin.end();
    if (root) await rm(root, { recursive: true, force: true });
  });

  const write = async(path:string, text:string, input:Record<string, unknown> = {}) => {
    const bytes = Buffer.from(text); const staged = await writer.stage(collectionId, bytes);
    return transactions.run('spec-write', client => writer.insert(client, { collectionId, path, mime: 'text/plain', bytes, staged, actor, message: 'spec', ...input }));
  };

  it('creates a file with its first version, manifest, referenced chunks and a put journal entry', async() => {
    // risk: data accuracy — every metadata row of a version write must agree on the same manifest and size.
    const file = await write('docs/one.txt', 'hello');
    const version = (await pool.query('SELECT * FROM file_versions WHERE id=$1', [file.current_version_id])).rows[0];
    expect(version).toMatchObject({ file_id: file.id, parent_version_id: null, size: '5', message: 'spec', device_id: 'device-1', created_by_type: 'user', created_by_id: 'writer-user' });
    expect((await pool.query('SELECT current_version_id,size FROM files WHERE id=$1', [file.id])).rows[0]).toEqual({ current_version_id: version.id, size: '5' });
    const manifest = (await pool.query('SELECT chunk_ids,total_size FROM manifests WHERE hash=$1', [version.manifest_hash])).rows[0];
    expect(manifest.total_size).toBe('5');
    expect((await pool.query('SELECT refcount FROM chunks WHERE collection_id=$1 AND id=ANY($2::text[])', [collectionId, manifest.chunk_ids])).rows.map(row => Number(row.refcount))).toEqual([1]);
    expect((await pool.query("SELECT op FROM journal WHERE file_id=$1 AND version_id=$2", [file.id, version.id])).rows).toEqual([{ op: 'put' }]);
    expect(version.manifest_hash).toBe(await writer.manifestHashFor(collectionId, Buffer.from('hello')));
    expect((await pool.query('SELECT state,stored_bytes FROM files_chunk_cache WHERE collection_id=$1 AND chunk_id=ANY($2::text[])', [collectionId, manifest.chunk_ids])).rows)
      .toEqual([{ state: 'resident', stored_bytes: '21' }]);
  });

  it('rolls cache residency back with an aborted version transaction', async() => {
    // risk: cache consistency — a rolled-back version must not leave a phantom resident cache entry.
    const bytes = Buffer.from(`rollback-${randomUUID()}`); const staged = await writer.stage(collectionId, bytes);
    await expect(transactions.run('spec-cache-rollback', async client => {
      await writer.insert(client, { collectionId, path: 'docs/cache-rollback.txt', mime: 'text/plain', bytes, staged, actor, message: 'spec' });
      throw new Error('force rollback');
    })).rejects.toThrow('force rollback');
    expect((await pool.query('SELECT 1 FROM files_chunk_cache WHERE collection_id=$1 AND chunk_id=ANY($2::text[])', [collectionId, staged.chunkIds])).rowCount).toBe(0);
    expect((await pool.query("SELECT 1 FROM files WHERE collection_id=$1 AND path='docs/cache-rollback.txt'", [collectionId])).rowCount).toBe(0);
  });

  it('appends a version to an existing file, revives it from Trash and chains the parent', async() => {
    // risk: data accuracy — history must chain to the previous current version and a trashed file must come back.
    const first = await write('docs/two.txt', 'v1');
    await pool.query('UPDATE files SET deleted_at=NOW() WHERE id=$1', [first.id]);
    const second = await write('docs/two.txt', 'v2', { fileId: first.id });
    expect((await pool.query('SELECT parent_version_id FROM file_versions WHERE id=$1', [second.current_version_id])).rows[0].parent_version_id).toBe(first.current_version_id);
    expect((await pool.query('SELECT deleted_at,current_version_id FROM files WHERE id=$1', [first.id])).rows[0]).toEqual({ deleted_at: null, current_version_id: second.current_version_id });
    const explicit = await write('docs/two.txt', 'v3', { fileId: first.id, baseVersionId: null });
    expect((await pool.query('SELECT parent_version_id FROM file_versions WHERE id=$1', [explicit.current_version_id])).rows[0].parent_version_id).toBeNull();
  });

  it('creates a caller-chosen file id and refuses a file of another collection', async() => {
    // risk: tenant isolation — a write must never append to another collection's file.
    const fileId = randomUUID();
    expect((await write('docs/chosen.txt', 'x', { fileId, createFileId: true })).id).toBe(fileId);
    const foreign = await (async() => { const bytes = Buffer.from('f'); const staged = await writer.stage(otherCollectionId, bytes);
      return transactions.run('spec-foreign', client => writer.insert(client, { collectionId: otherCollectionId, path: 'f.txt', mime: 'text/plain', bytes, staged, actor, message: 'x' })) })();
    await expect(write('docs/steal.txt', 'y', { fileId: foreign.id })).rejects.toMatchObject({ status: 404, message: 'file not found' });
  });

  it('refuses content staged for other bytes and a chunk reclaimed after staging', async() => {
    // risk: chunk integrity — a version must never point at content that is not durable in the store.
    const staged = await writer.stage(collectionId, Buffer.from('abc'));
    await expect(transactions.run('spec-mismatch', client => writer.insert(client, { collectionId, path: 'docs/bad.txt', mime: 'text/plain', bytes: Buffer.from('abcd'), staged, actor, message: 'x' })))
      .rejects.toThrow('staged content does not match the version being written');
    const unique = Buffer.from(`reclaimed ${ randomUUID() }`); const reclaimed = await writer.stage(collectionId, unique);
    for (const chunk of reclaimed.chunks) await store.delete(collectionId, chunk.id);
    await expect(transactions.run('spec-reclaimed', client => writer.insert(client, { collectionId, path: 'docs/gone.txt', mime: 'text/plain', bytes: unique, staged: reclaimed, actor, message: 'x' })))
      .rejects.toMatchObject({ status: 503, code: 'FILES_DB_RETRYABLE' });
    expect((await pool.query("SELECT 1 FROM files WHERE collection_id=$1 AND path='docs/gone.txt'", [collectionId])).rowCount).toBe(0);
  });

  it('saves a text document per file and keeps each version\'s heads without its payload', async() => {
    // risk: data accuracy — stale-base merges depend on per-version heads; the current document must load back.
    const documents = new AutomergeDocumentRepository(pool); const texts = new AutomergeTextStore(documents);
    const file = await write('docs/text.md', 'one');
    const document = editTextDocument(newTextDocument('one'), 'one two');
    await transactions.run('spec-automerge', client => texts.save(client, file.id, file.current_version_id, document));
    expect((await texts.current(pool, file.id, file.current_version_id))?.text).toBe('one two');
    const heads = await documents.versionHeads(pool, file.current_version_id, file.id);
    expect(heads?.heads).toEqual(JSON.parse(JSON.stringify((await import('@automerge/automerge')).getHeads(document))));
    expect(await documents.legacyVersionDocument(pool, file.current_version_id, file.id)).toBeUndefined();
    const latest = await documents.latest(file.id);
    expect(await transactions.run('spec-stamp', client => documents.stamp(client, file.id))).toBe(latest?.stamp);
  });
});
