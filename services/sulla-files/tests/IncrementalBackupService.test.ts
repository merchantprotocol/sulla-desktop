// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Characterizes content-addressed incremental backups with an in-memory destination and a fake
// database (no Postgres, no S3 SDK): which objects a run uploads, how manifests are signed and
// verified, how promotion re-signs, and how the restore proof catches corrupt ciphertext.
import { createHash, createHmac } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IncrementalBackupService, IncrementalManifestSigner, type SignedIncrementalManifest } from '../src/backup/incremental.js';
import type { BackupDatabaseOperations } from '../src/backup/database.js';
import type { BackupObjectStore } from '../src/backup/destinations.js';
import type { Config } from '../src/config.js';

const COLLECTION = '0b6f8c3e-4a1d-4c2b-9e7f-1a2b3c4d5e6f';
const KEY = 'k'.repeat(32);
const sha = (value:Buffer | string) => createHash('sha256').update(value).digest('hex');

class MemoryStore implements BackupObjectStore {
  readonly description = 'memory';
  readonly objects = new Map<string, Buffer>();
  readonly uploads:string[] = [];
  async has(key:string) { return this.objects.has(key) }
  async putImmutable(key:string, value:Buffer | string) { if (!this.objects.has(key)) this.objects.set(key, Buffer.from(value)) }
  async putFileImmutable(key:string, source:string) { this.uploads.push(key); if (!this.objects.has(key)) this.objects.set(key, await readFile(source)) }
  async get(key:string) { const value = this.objects.get(key); if (!value) throw new Error(`missing ${ key }`); return Buffer.from(value) }
  async remove(key:string) { this.objects.delete(key) }
  async close() {}
}

/** Stands in for Postgres: the snapshot is whatever chunk payloads the test sets. */
class FakeDatabase implements Pick<BackupDatabaseOperations, 'createSnapshot' | 'restoreIsolated'> {
  chunks:Buffer[] = [];
  rows = 'collections\t{"id":"1"}\n';
  async createSnapshot(_url:string, _root:string, stage:string, rowsPath:string) {
    await writeFile(rowsPath, this.rows);
    const chunks = [];
    for (const bytes of this.chunks) {
      const id = sha(bytes); const backupPath = join(stage, COLLECTION, id.slice(0, 2), id);
      await mkdir(join(stage, COLLECTION, id.slice(0, 2)), { recursive: true }); await writeFile(backupPath, bytes);
      chunks.push({ collection_id: COLLECTION, id, size: bytes.length, stored_size: bytes.length, location: `chunks/${ COLLECTION }/${ id }`, refcount: '1', backupPath });
    }
    return { snapshotId: '10:10:', rowsPath, chunks, evidence: { migrations: ['001_init.sql'], migrationHashes: {}, tables: [{ name: 'chunks', rows: String(chunks.length), columns: [], constraints: [] }], extensions: [], postgresVersion: '16.4' } };
  }
  cleaned = 0;
  async restoreIsolated() {
    return { database: 'staging', url: 'postgres://staging', pool: {} as any, cleanup: async() => { this.cleaned++ } };
  }
}

describe('incremental backups', () => {
  let chunkRoot = '';
  let database:FakeDatabase; let store:MemoryStore; let service:IncrementalBackupService;
  const inventory = { chunkSizes: async() => database.chunks.map(bytes => ({ collection_id: COLLECTION, id: sha(bytes), stored_size: bytes.length })) };

  beforeEach(async() => {
    chunkRoot = await mkdtemp(join(tmpdir(), 'sulla-incremental-spec-'));
    database = new FakeDatabase(); store = new MemoryStore();
    const config = { databaseUrl: 'postgres://files', chunkRoot, capabilitySigningKey: KEY } as unknown as Config;
    service = new IncrementalBackupService(config, database as unknown as BackupDatabaseOperations, inventory as any);
  });
  afterEach(async() => { await rm(chunkRoot, { recursive: true, force: true }) });

  // risk: cost/data accuracy — an unchanged object must never be uploaded twice; only new content moves.
  it('uploads only objects the destination does not already hold', async() => {
    database.chunks = [Buffer.from('chunk-a'), Buffer.from('chunk-b')];
    const first = await service.create(store, 'hourly');
    expect({ uploaded: first.uploaded, reused: first.reused }).toEqual({ uploaded: 4, reused: 0 });

    const second = await service.create(store, 'hourly');
    expect({ uploaded: second.uploaded, reused: second.reused }).toEqual({ uploaded: 0, reused: 4 });

    database.chunks = [Buffer.from('chunk-a'), Buffer.from('chunk-c')];
    const third = await service.create(store, 'hourly');
    // Rows/evidence are identical, chunk-a is reused; only chunk-c is new.
    expect({ uploaded: third.uploaded, reused: third.reused }).toEqual({ uploaded: 1, reused: 3 });
    expect(store.uploads.at(-1)).toBe(`objects/sha256/${ sha('chunk-c').slice(0, 2) }/${ sha('chunk-c') }`);
  });

  // risk: integrity — manifest key, object keys and HMAC must keep today's exact layout so old snapshots verify.
  it('stores a manifest signed with HMAC-SHA256 over its JSON under snapshots/<date>/<id>.json', async() => {
    database.chunks = [Buffer.from('chunk-a')];
    const created = await service.create(store, 'manual');
    const { manifest, signature } = created.manifest;
    expect(created.key).toBe(`snapshots/${ manifest.createdAt.slice(0, 10) }/${ manifest.id }.json`);
    expect(signature).toEqual({ algorithm: 'hmac-sha256', value: createHmac('sha256', KEY).update(JSON.stringify(manifest)).digest('hex') });
    expect(manifest.entries.map(entry => entry.path)).toEqual(['database/rows.jsonl', 'schema/evidence.json', `chunks/${ COLLECTION }/${ sha('chunk-a').slice(0, 2) }/${ sha('chunk-a') }`]);
    for (const entry of manifest.entries) expect(entry.objectKey).toBe(IncrementalManifestSigner.objectKey(entry.sha256));
    expect(JSON.parse((await store.get(created.key)).toString())).toEqual(created.manifest);
  });

  // risk: tampering — a manifest edited after signing, or one whose objects vanished, must be refused.
  it('rejects a tampered manifest and a manifest whose object is missing', async() => {
    database.chunks = [Buffer.from('chunk-a')];
    const created = await service.create(store, 'manual');
    const tampered:SignedIncrementalManifest = JSON.parse(JSON.stringify(created.manifest)); tampered.manifest.tier = 'weekly';
    store.objects.set('snapshots/tampered.json', Buffer.from(JSON.stringify(tampered)));
    await expect(service.verifyManifest(store, 'snapshots/tampered.json')).rejects.toThrow(/signature is invalid/);

    await store.remove(created.manifest.manifest.entries[2].objectKey);
    await expect(service.verifyManifest(store, created.key)).rejects.toThrow(/Backup object is missing/);
  });

  // risk: retention — a promoted daily/weekly copy must reuse the same verified objects under a fresh, valid signature.
  it('promotes by re-signing the same entries under a new id and tier', async() => {
    database.chunks = [Buffer.from('chunk-a')];
    const created = await service.create(store, 'hourly');
    const promoted = await service.promote(store, created.manifest, 'daily');
    expect(promoted.manifest.manifest.id).not.toBe(created.manifest.manifest.id);
    expect(promoted.manifest.manifest.tier).toBe('daily');
    expect(promoted.manifest.manifest.entries).toEqual(created.manifest.manifest.entries);
    expect(await service.verifyManifest(store, promoted.key)).toEqual(promoted.manifest);
  });

  // risk: unrecoverable backup — the restore proof must catch corrupt ciphertext and still drop the staging database.
  it('restore proof passes for intact objects and fails on corrupt ciphertext', async() => {
    database.chunks = [Buffer.from('chunk-a')];
    const created = await service.create(store, 'hourly');
    await expect(service.verifyRestore(store, created.key)).resolves.toEqual(created.manifest);
    expect(database.cleaned).toBe(1);

    const chunkKey = created.manifest.manifest.entries[2].objectKey;
    store.objects.set(chunkKey, Buffer.from('chunk-x'));
    await expect(service.verifyRestore(store, created.key)).rejects.toThrow(/corrupt ciphertext/);
    expect(database.cleaned).toBe(2);
  });
});
