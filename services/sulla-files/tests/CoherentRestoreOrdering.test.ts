// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Characterizes coherent restore ordering on a real filesystem with a recording fake database:
// lock → recover leftovers → extract → isolated validation → journal → publish (ciphertext then
// rows) → cleanup → unlock, and what is preserved when publication fails or its outcome is unknown.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CoherentRestoreService } from '../src/backup/CoherentRestoreService.js';
import { BackupContainer, BackupFileDigest, type BackupManifest, type BackupObject } from '../src/backup/container.js';
import { PublicationOutcomeUnknownError, type BackupDatabaseOperations, type PublicationIdentity, type SchemaEvidence } from '../src/backup/database.js';
import type { Config } from '../src/config.js';

const COLLECTION = '0b6f8c3e-4a1d-4c2b-9e7f-1a2b3c4d5e6f';
const CHUNK = Buffer.from('restored-ciphertext');
const CHUNK_ID = createHash('sha256').update(CHUNK).digest('hex');
const PREFIX = '.sulla-files-restore-';

class RecordingDatabase implements BackupDatabaseOperations {
  readonly events:string[] = [];
  readonly committed = new Map<string, string>();
  mode:'commit' | 'fail-after-chunks' | 'outcome-unknown' = 'commit';
  journalDuringPublish:any;
  constructor(private readonly parent:string) {}
  async createSnapshot():Promise<never> { throw new Error('not used by restore') }
  async restoreIsolated() {
    this.events.push('isolated');
    return { database: 'staging', url: 'postgres://staging', pool: {} as any, cleanup: async() => { this.events.push('isolated-cleanup') } };
  }
  async acquireRestoreLock() { this.events.push('lock'); return { release: async() => { this.events.push('unlock') } } }
  async publish(_url:string, _rows:string, _expected:SchemaEvidence, publication:PublicationIdentity, publishChunks:()=>Promise<()=>Promise<void>>) {
    this.events.push('publish');
    const rollback = await publishChunks();
    this.events.push('chunks-published');
    const workspace = (await readdir(this.parent)).find(name => name.startsWith(PREFIX))!;
    this.journalDuringPublish = JSON.parse(await readFile(join(this.parent, workspace, 'publication.json'), 'utf8'));
    if (this.mode === 'outcome-unknown') throw new PublicationOutcomeUnknownError(new Error('commit result lost'));
    if (this.mode === 'fail-after-chunks') { await rollback(); throw new Error('row load failed') }
    this.committed.set(publication.snapshotId, publication.archiveSha256); this.events.push('commit');
  }
  async publicationCommitted(_url:string, publication:PublicationIdentity) {
    this.events.push('probe');
    const archive = this.committed.get(publication.snapshotId);
    if (archive === undefined) return false;
    if (archive !== publication.archiveSha256) throw new Error('conflict');
    return true;
  }
}

describe('coherent restore ordering', () => {
  let root = ''; let parent = ''; let chunkRoot = ''; let backups = ''; let archive = '';
  let database:RecordingDatabase; let service:CoherentRestoreService; let config:Config;

  beforeEach(async() => {
    root = await mkdtemp(join(tmpdir(), 'sulla-restore-spec-'));
    parent = join(root, 'store'); chunkRoot = join(parent, 'chunks'); backups = join(root, 'backups');
    await mkdir(backups, { recursive: true });
    const tables = [{ name: 'chunks', rows: '1', columns: [], constraints: [] }];
    const evidence:SchemaEvidence = { migrations: ['001_init.sql'], migrationHashes: { '001_init.sql': 'h' }, tables, extensions: [], postgresVersion: '16.4' };
    const sources = { rows: join(root, 'rows.jsonl'), evidence: join(root, 'evidence.json'), chunk: join(root, 'chunk') };
    await writeFile(sources.rows, 'chunks\t{}\n'); await writeFile(sources.evidence, JSON.stringify(evidence)); await writeFile(sources.chunk, CHUNK);
    const digest = new BackupFileDigest();
    const objects:BackupObject[] = [
      { path: 'database/rows.jsonl', type: 'postgres-rows', sourcePath: sources.rows, ...await digest.sha256(sources.rows) },
      { path: 'schema/evidence.json', type: 'schema-evidence', sourcePath: sources.evidence, ...await digest.sha256(sources.evidence) },
      { path: `chunks/${ COLLECTION }/${ CHUNK_ID.slice(0, 2) }/${ CHUNK_ID }`, type: 'encrypted-chunk', sourcePath: sources.chunk, ...await digest.sha256(sources.chunk) },
    ];
    const manifest:BackupManifest = {
      format: 'sulla-files-coherent-backup', version: 1, createdAt: '2026-11-16T08:00:00.000Z', postgresVersion: '16.4', snapshotId: '42:42:',
      migrations: evidence.migrations, tables, excludedTableData: {}, entries: objects.map(({ sourcePath: _source, ...entry }) => entry),
    };
    archive = join(backups, 'sulla-files-2026-11-16T08-00-00-000Z.sulla-files-backup');
    await new BackupContainer().write(archive, manifest, objects);
    // An older, sorted-earlier name that is not a valid archive: selecting it would fail the restore.
    await writeFile(join(backups, 'sulla-files-2026-01-01T00-00-00-000Z.sulla-files-backup'), 'not an archive');
    database = new RecordingDatabase(parent);
    const recoverability = { assertStagedInventory: async() => { database.events.push('validate') } };
    service = new CoherentRestoreService(database, recoverability);
    config = { databaseUrl: 'postgres://files', chunkRoot, backupTarget: backups } as unknown as Config;
  });
  afterEach(async() => { await rm(root, { recursive: true, force: true }) });

  const leftovers = async() => (await readdir(parent)).filter(name => name.startsWith(PREFIX));

  // risk: data loss — ciphertext is published only after isolated validation, and rows commit after ciphertext is in place.
  it('restores the newest archive in lock → validate → journal → publish → cleanup → unlock order', async() => {
    await expect(service.restore(config)).resolves.toBe(archive);
    expect(database.events).toEqual(['lock', 'isolated', 'validate', 'publish', 'chunks-published', 'commit', 'isolated-cleanup', 'unlock']);
    expect(await readFile(join(chunkRoot, COLLECTION, CHUNK_ID.slice(0, 2), CHUNK_ID))).toEqual(CHUNK);
    expect(database.journalDuringPublish).toMatchObject({ version: 1, phase: 'chunks-published', snapshotId: '42:42:', targetBefore: null });
    expect(await leftovers()).toEqual([]);
  });

  // risk: data loss — a restore must never overwrite a chunk store that already holds data.
  it('refuses a non-empty target and preserves its content', async() => {
    await mkdir(chunkRoot, { recursive: true }); await writeFile(join(chunkRoot, 'existing'), 'keep me');
    await expect(service.restore(config, archive)).rejects.toThrow(/contains data/);
    expect(await readFile(join(chunkRoot, 'existing'), 'utf8')).toBe('keep me');
    expect(database.events).toEqual(['lock', 'isolated', 'validate', 'publish', 'isolated-cleanup', 'unlock']);
    expect(await leftovers()).toEqual([]);
  });

  // risk: half-restored store — when the row load fails, published ciphertext is rolled back out of the target.
  it('rolls ciphertext back out of the target when publication fails', async() => {
    database.mode = 'fail-after-chunks';
    await expect(service.restore(config, archive)).rejects.toThrow('row load failed');
    expect(existsSync(chunkRoot)).toBe(false);
    expect(await leftovers()).toEqual([]);
    expect(database.events.at(-1)).toBe('unlock');
  });

  // risk: data loss — an uncertain COMMIT preserves the journal; the next run reconciles it instead of restaging.
  it('preserves the journal when the outcome is unknown and reconciles it on the next restore', async() => {
    database.mode = 'outcome-unknown';
    await expect(service.restore(config, archive)).rejects.toBeInstanceOf(PublicationOutcomeUnknownError);
    const preserved = await leftovers();
    expect(preserved).toHaveLength(1);
    expect(JSON.parse(await readFile(join(parent, preserved[0], 'publication.json'), 'utf8')).phase).toBe('chunks-published');

    // The commit did land: the marker exists, so the retry must finish without restaging anything.
    database.committed.set('42:42:', (await new BackupFileDigest().sha256(archive)).sha256);
    database.events.length = 0;
    await expect(service.restore(config, archive)).resolves.toBe(archive);
    expect(database.events).toEqual(['lock', 'probe', 'unlock']);
    expect(await leftovers()).toEqual([]);
    expect(await readFile(join(chunkRoot, COLLECTION, CHUNK_ID.slice(0, 2), CHUNK_ID))).toEqual(CHUNK);
  });
});
