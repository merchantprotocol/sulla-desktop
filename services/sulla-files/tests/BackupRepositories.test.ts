// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Runs the personal-backup and restore-publication repositories against real Postgres. Point
// SULLA_FILES_TEST_DATABASE_URL at a throwaway database (e.g. `docker run --rm -e POSTGRES_PASSWORD=x
// -p 55432:5432 postgres:16-alpine`). Each run creates and drops its own schema and applies the real
// 016/039/040 migrations; the chunk-inventory tables are minimal fixtures with the columns the SQL reads.
// BackupSchemaRepository/BackupTableDataRepository address `public.` explicitly by design, so they are
// exercised by the isolated-restore path rather than this schema-scoped spec.
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BackupDestinationRepository } from '../src/Repositories/BackupDestinationRepository.js';
import { BackupGcObjectRepository } from '../src/Repositories/BackupGcObjectRepository.js';
import { BackupInventoryRepository } from '../src/Repositories/BackupInventoryRepository.js';
import { BackupRunRepository } from '../src/Repositories/BackupRunRepository.js';
import { BackupSnapshotRepository } from '../src/Repositories/BackupSnapshotRepository.js';
import { RestorePublicationRepository } from '../src/Repositories/RestorePublicationRepository.js';

const databaseUrl = process.env.SULLA_FILES_TEST_DATABASE_URL;
const migration = (name:string) => readFileSync(new URL(`../migrations/${ name }`, import.meta.url), 'utf8');

describe.skipIf(!databaseUrl)('backup repositories (real Postgres)', () => {
  const schema = `files_backup_spec_${ randomUUID().replaceAll('-', '') }`;
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  pool.on('connect', client => { void client.query(`SET search_path TO ${ schema }`) });
  const destinations = new BackupDestinationRepository();
  const runs = new BackupRunRepository();
  const snapshots = new BackupSnapshotRepository();
  const gc = new BackupGcObjectRepository();
  const publications = new RestorePublicationRepository();
  const inventory = new BackupInventoryRepository();

  beforeAll(async() => {
    await pool.query(`CREATE SCHEMA ${ schema }`);
    await pool.query(migration('016_backup_restore.sql'));
    await pool.query(migration('039_personal_backups.sql'));
    await pool.query(migration('040_personal_backup_cleanup.sql'));
    await pool.query(`CREATE TABLE collections(id uuid PRIMARY KEY,owner_user_id text NOT NULL,compatibility_state text NOT NULL DEFAULT 'native')`);
    await pool.query(`CREATE TABLE files_collection_keys(collection_id uuid PRIMARY KEY,key_origin text NOT NULL DEFAULT 'random',key_version int NOT NULL DEFAULT 1,key_epoch int NOT NULL DEFAULT 1)`);
    await pool.query(`CREATE TABLE files_collection_key_bundles(collection_id uuid,principal_id text,key_version int,key_epoch int,authority_registered_at timestamptz)`);
    await pool.query('CREATE TABLE manifests(hash text PRIMARY KEY,chunk_ids jsonb NOT NULL)');
    await pool.query('CREATE TABLE file_versions(id uuid PRIMARY KEY,manifest_hash text NOT NULL,chunk_collection_id uuid NOT NULL)');
    await pool.query('CREATE TABLE chunks(collection_id uuid NOT NULL,id text NOT NULL,size bigint NOT NULL,stored_size bigint NOT NULL,location text NOT NULL,refcount bigint NOT NULL DEFAULT 1,PRIMARY KEY(collection_id,id))');
  });
  afterAll(async() => { await pool.query(`DROP SCHEMA IF EXISTS ${ schema } CASCADE`); await pool.end() });
  beforeEach(async() => {
    await pool.query(`TRUNCATE files_backup_gc_objects, files_backup_runs, files_backup_snapshots, files_backup_destinations, files_restore_publications,
      collections, files_collection_keys, files_collection_key_bundles, manifests, file_versions, chunks`);
  });

  async function destination(enabled = true):Promise<string> {
    const id = randomUUID();
    await pool.query('INSERT INTO files_backup_destinations(id,kind,label,config,enabled) VALUES($1,$2,$3,$4,$5)', [id, 'local', 'Disk', { kind: 'local', root: '/var/lib/sulla-files-backups/a' }, enabled]);
    return id;
  }

  // risk: missed or duplicate backups — only enabled destinations are scheduled, and one run per destination holds the lock.
  it('lists only enabled destinations and serializes runs with a per-destination session lock', async() => {
    const enabled = await destination(); const disabled = await destination(false);
    expect((await destinations.listEnabled(pool)).map(row => row.id)).toEqual([enabled]);
    expect((await destinations.listEnabled(pool))[0].config).toEqual({ kind: 'local', root: '/var/lib/sulla-files-backups/a' });
    expect(await destinations.isEnabled(pool, enabled)).toBe(true);
    expect(await destinations.isEnabled(pool, disabled)).toBe(false);

    const first = await pool.connect(); const second = await pool.connect();
    try {
      expect(await destinations.tryLock(first, enabled)).toBe(true);
      expect(await destinations.tryLock(second, enabled)).toBe(false);
      expect(await destinations.tryLock(second, disabled)).toBe(true);
      await destinations.unlock(first, enabled);
      expect(await destinations.tryLock(second, enabled)).toBe(true);
      await destinations.unlock(second, enabled); await destinations.unlock(second, disabled);
    } finally { first.release(); second.release() }
  });

  // risk: wrong status in Settings — interrupted runs fail only for their destination, and alerts key off the previous run.
  it('records the run lifecycle and fails only this destination\'s interrupted runs', async() => {
    const id = await destination(); const other = await destination();
    const stale = randomUUID(); const otherRun = randomUUID();
    await runs.start(pool, stale, id); await runs.start(pool, otherRun, other);
    await runs.failInterrupted(pool, id);
    const states = (await pool.query('SELECT id,state,error_code FROM files_backup_runs')).rows;
    expect(states.find(row => row.id === stale)).toMatchObject({ state: 'failed', error_code: 'interrupted' });
    expect(states.find(row => row.id === otherRun)).toMatchObject({ state: 'running', error_code: null });

    const current = randomUUID();
    await pool.query("UPDATE files_backup_runs SET started_at=NOW()-interval '1 hour' WHERE id=$1", [stale]);
    await runs.start(pool, current, id);
    expect(await runs.previousState(pool, id, current)).toBe('failed');
    await runs.markFailed(pool, current, 'Backup failed.');
    const failed = (await pool.query('SELECT state,error_code,error_message,finished_at FROM files_backup_runs WHERE id=$1', [current])).rows[0];
    expect(failed).toMatchObject({ state: 'failed', error_code: 'backup-failed', error_message: 'Backup failed.' });
    expect(failed.finished_at).not.toBeNull();
    expect(await runs.previousState(pool, other, otherRun)).toBeUndefined();
  });

  // risk: lost retention history — snapshots are stored verified, promotions dedupe per window, and pruning detaches runs first.
  it('stores verified snapshots, finds promotions per window, and deletes a pruned snapshot', async() => {
    const id = await destination();
    const snapshotId = randomUUID(); const runId = randomUUID();
    await snapshots.insertVerified(pool, { id: snapshotId, destinationId: id, tier: 'daily', manifestKey: 'snapshots/2026-11-16/a.json', manifestSha256: 'a'.repeat(64), createdAt: '2026-11-16T05:00:00.000Z' });
    expect(await snapshots.hasRestoreVerifiedSince(pool, id, 'daily', new Date('2026-11-16T00:00:00Z'))).toBe(true);
    expect(await snapshots.hasRestoreVerifiedSince(pool, id, 'daily', new Date('2026-11-16T05:00:00Z'))).toBe(true);
    expect(await snapshots.hasRestoreVerifiedSince(pool, id, 'daily', new Date('2026-11-17T00:00:00Z'))).toBe(false);
    expect(await snapshots.hasRestoreVerifiedSince(pool, id, 'weekly', new Date('2026-11-16T00:00:00Z'))).toBe(false);

    const [row] = await snapshots.listForDestination(pool, id);
    expect(row).toMatchObject({ id: snapshotId, manifest_key: 'snapshots/2026-11-16/a.json', prune_manifest: null });
    expect(row.verified_at).not.toBeNull(); expect(row.restore_verified_at).not.toBeNull();

    const tombstone = { manifest: { id: snapshotId, entries: [] }, signature: { algorithm: 'hmac-sha256', value: 'x' } } as any;
    await snapshots.markPruning(pool, snapshotId, tombstone);
    expect((await snapshots.listForDestination(pool, id))[0].prune_manifest).toEqual(tombstone);

    await runs.start(pool, runId, id); await runs.markVerified(pool, runId, snapshotId);
    await runs.detachSnapshot(pool, snapshotId); await snapshots.delete(pool, snapshotId);
    expect(await snapshots.listForDestination(pool, id)).toEqual([]);
    expect((await pool.query('SELECT state,snapshot_id FROM files_backup_runs WHERE id=$1', [runId])).rows[0]).toEqual({ state: 'verified', snapshot_id: null });
  });

  // risk: crash during prune — queued deletions are idempotent and scoped to their destination.
  it('queues garbage objects idempotently per destination', async() => {
    const id = await destination(); const other = await destination();
    await gc.enqueue(pool, id, 'objects/sha256/aa/1'); await gc.enqueue(pool, id, 'objects/sha256/aa/1'); await gc.enqueue(pool, other, 'objects/sha256/bb/2');
    expect(await gc.pending(pool, id)).toEqual(['objects/sha256/aa/1']);
    await gc.remove(pool, id, 'objects/sha256/aa/1');
    expect(await gc.pending(pool, id)).toEqual([]);
    expect(await gc.pending(pool, other)).toEqual(['objects/sha256/bb/2']);
  });

  // risk: double restore — the publication marker is the durable proof a snapshot was published.
  it('records and reads the restore publication marker', async() => {
    expect(await publications.publishedArchive(pool, '1:1:')).toBeUndefined();
    const client = await pool.connect();
    try { await publications.record(client, '1:1:', 'b'.repeat(64)) } finally { client.release() }
    expect(await publications.publishedArchive(pool, '1:1:')).toBe('b'.repeat(64));
  });

  // risk: unrecoverable backup — every recovery precondition is detected from metadata.
  it('detects recoverability gaps and unresolved chunk references', async() => {
    const collection = randomUUID(); const chunk = 'c'.repeat(64);
    await pool.query('INSERT INTO collections(id,owner_user_id) VALUES($1,$2)', [collection, 'user-1']);
    await pool.query('INSERT INTO files_collection_keys(collection_id) VALUES($1)', [collection]);
    expect(await inventory.vaultPrincipalCount(pool)).toBe(1);
    expect(await inventory.hasUnsupportedCollection(pool)).toBe(false);
    expect(await inventory.hasCollectionWithoutRecoveryBundle(pool)).toBe(true);
    await pool.query('INSERT INTO files_collection_key_bundles VALUES($1,$2,1,1,NOW())', [collection, 'user-1']);
    expect(await inventory.hasCollectionWithoutRecoveryBundle(pool)).toBe(false);
    await pool.query("UPDATE files_collection_keys SET key_origin='legacy'");
    expect(await inventory.hasUnsupportedCollection(pool)).toBe(true);
    await pool.query('INSERT INTO collections(id,owner_user_id) VALUES($1,$2)', [randomUUID(), 'user-2']);
    expect(await inventory.vaultPrincipalCount(pool)).toBe(2);

    await pool.query('INSERT INTO manifests VALUES($1,$2)', ['m1', JSON.stringify([chunk])]);
    await pool.query('INSERT INTO file_versions VALUES($1,$2,$3)', [randomUUID(), 'm1', collection]);
    expect(await inventory.hasUnresolvedChunkReference(pool)).toBe(true);
    await pool.query('INSERT INTO chunks VALUES($1,$2,10,12,$3,1)', [collection, chunk, `chunks/${ collection }/${ chunk }`]);
    await pool.query('INSERT INTO chunks VALUES($1,$2,1,2,$3,1)', [collection, 'a'.repeat(64), `chunks/${ collection }/${ 'a'.repeat(64) }`]);
    expect(await inventory.hasUnresolvedChunkReference(pool)).toBe(false);
    expect((await inventory.chunkSizes(pool)).map(row => [row.id, Number(row.stored_size)])).toEqual([['a'.repeat(64), 2], [chunk, 12]]);
    expect((await inventory.chunkInventory(pool))[1]).toMatchObject({ collection_id: collection, id: chunk, location: `chunks/${ collection }/${ chunk }`, refcount: '1' });
  });
});
