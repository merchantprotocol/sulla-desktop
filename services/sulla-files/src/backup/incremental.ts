// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BackupInventoryRepository } from '../Repositories/BackupInventoryRepository.js';
import { BackupFileDigest, type BackupEntry } from './container.js';
import { BackupDatabase, EPHEMERAL_TABLE_DATA, type BackupDatabaseOperations, type SchemaEvidence } from './database.js';

import { CapabilityKeyCandidates } from '../CapabilityKeyCandidates.js';

import type { BackupObjectStore } from './destinations.js';
import type { Config } from '../config.js';

export interface IncrementalManifest {
  format:'sulla-files-incremental-backup'; version:1; id:string; createdAt:string; tier:'hourly'|'daily'|'weekly'|'manual';
  postgresVersion:string; snapshotId:string; migrations:string[]; tables:unknown[]; excludedTableData:Record<string,string>;
  entries:(BackupEntry & { objectKey:string })[];
}
export interface SignedIncrementalManifest { manifest:IncrementalManifest; signature:{ algorithm:'hmac-sha256'; value:string } }
export interface IncrementalBackupResult { key:string; manifest:SignedIncrementalManifest; uploaded:number; reused:number }

/** HMAC over the manifest's JSON and the content-addressed object layout. */
export class IncrementalManifestSigner {
  constructor(private readonly key:string | Buffer) {}

  sign(manifest:IncrementalManifest):string { return createHmac('sha256', this.key).update(JSON.stringify(manifest)).digest('hex') }

  signed(manifest:IncrementalManifest):SignedIncrementalManifest { return { manifest, signature: { algorithm: 'hmac-sha256', value: this.sign(manifest) } } }

  /** Constant-time check of a hex signature against this key. */
  verifies(manifest:IncrementalManifest, value:string):boolean {
    const expected = Buffer.from(this.sign(manifest), 'hex'); const actual = Buffer.from(value, 'hex');
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  static objectKey(digest:string):string { return `objects/sha256/${ digest.slice(0, 2) }/${ digest }` }

  static manifestKey(manifest:IncrementalManifest):string { return `snapshots/${ manifest.createdAt.slice(0, 10) }/${ manifest.id }.json` }
}

/**
 * Content-addressed incremental backups: each object is stored once under its SHA-256, so a run
 * uploads only objects the destination does not already hold; a signed manifest ties them together.
 */
export class IncrementalBackupService {
  private readonly signer:IncrementalManifestSigner;
  private readonly verifiers:readonly IncrementalManifestSigner[];

  /** New manifests are signed with the current key; verification also accepts the pre-#2369 key. */
  constructor(
    private readonly config:Config,
    private readonly database:BackupDatabaseOperations = new BackupDatabase(),
    private readonly inventory = new BackupInventoryRepository(),
    private readonly digest = new BackupFileDigest(),
    keys:CapabilityKeyCandidates = CapabilityKeyCandidates.fromConfig(config),
  ) {
    this.signer = new IncrementalManifestSigner(keys.current);
    this.verifiers = keys.all.map(key => new IncrementalManifestSigner(key));
  }

  async create(store:BackupObjectStore, tier:IncrementalManifest['tier'] = 'manual'):Promise<IncrementalBackupResult> {
    const workspace = await mkdtemp(join(tmpdir(), 'sulla-files-incremental-'));
    try {
      const rowsPath = join(workspace, 'rows.jsonl');
      const snapshot = await this.database.createSnapshot(this.config.databaseUrl, this.config.chunkRoot, join(workspace, 'chunks'), rowsPath);
      const evidencePath = join(workspace, 'schema-evidence.json'); await writeFile(evidencePath, JSON.stringify(snapshot.evidence), { mode: 0o600 });
      const sources:{ path:string; type:BackupEntry['type']; source:string }[] = [
        { path: 'database/rows.jsonl', type: 'postgres-rows', source: rowsPath },
        { path: 'schema/evidence.json', type: 'schema-evidence', source: evidencePath },
        ...snapshot.chunks.map(chunk => ({ path: `chunks/${ chunk.collection_id }/${ chunk.id.slice(0, 2) }/${ chunk.id }`, type: 'encrypted-chunk' as const, source: chunk.backupPath })),
      ];
      let uploaded = 0, reused = 0; const entries:IncrementalManifest['entries'] = [];
      for (const source of sources) {
        const digest = await this.digest.sha256(source.source); const key = IncrementalManifestSigner.objectKey(digest.sha256);
        if (await store.has(key)) reused++; else { await store.putFileImmutable(key, source.source); uploaded++ }
        entries.push({ path: source.path, type: source.type, ...digest, objectKey: key });
      }
      const manifest:IncrementalManifest = {
        format: 'sulla-files-incremental-backup', version: 1, id: randomUUID(), createdAt: new Date().toISOString(), tier,
        postgresVersion: snapshot.evidence.postgresVersion, snapshotId: snapshot.snapshotId, migrations: snapshot.evidence.migrations,
        tables: snapshot.evidence.tables, excludedTableData: Object.fromEntries(Object.entries(EPHEMERAL_TABLE_DATA).filter(([name]) => snapshot.evidence.tables.some(table => table.name === name))), entries,
      };
      const signed = this.signer.signed(manifest);
      const key = IncrementalManifestSigner.manifestKey(manifest);
      await store.putImmutable(key, JSON.stringify(signed));
      await this.verifyManifest(store, key);
      return { key, manifest: signed, uploaded, reused };
    } finally { await rm(workspace, { recursive: true, force: true }) }
  }

  /** Restores the manifest's rows into an isolated database and checks every chunk object it names. */
  async verifyRestore(store:BackupObjectStore, key:string):Promise<SignedIncrementalManifest> {
    const signed = await this.verifyManifest(store, key);
    const workspace = await mkdtemp(join(tmpdir(), 'sulla-files-restore-proof-'));
    try {
      const byPath = new Map(signed.manifest.entries.map(entry => [entry.path, entry]));
      const rows = byPath.get('database/rows.jsonl'); const schema = byPath.get('schema/evidence.json');
      if (!rows || !schema) throw new Error('Backup restore proof requires database rows and schema evidence');
      const rowsPath = join(workspace, 'rows.jsonl'); const schemaPath = join(workspace, 'schema.json');
      await writeFile(rowsPath, await store.get(rows.objectKey), { mode: 0o600 }); await writeFile(schemaPath, await store.get(schema.objectKey), { mode: 0o600 });
      for (const [entry, path] of [[rows, rowsPath], [schema, schemaPath]] as const) if ((await this.digest.sha256(path)).sha256 !== entry.sha256) throw new Error(`Backup object digest mismatch: ${ entry.path }`);
      const evidence = JSON.parse(await readFile(schemaPath, 'utf8')) as SchemaEvidence;
      const isolated = await this.database.restoreIsolated(this.config.databaseUrl, rowsPath, evidence);
      try {
        const inventory = await this.inventory.chunkSizes(isolated.pool);
        const chunks = new Map(signed.manifest.entries.filter(entry => entry.type === 'encrypted-chunk').map(entry => [entry.path, entry]));
        if (chunks.size !== inventory.length) throw new Error('Backup restore proof found a chunk inventory mismatch');
        for (const chunk of inventory) {
          const path = `chunks/${ chunk.collection_id }/${ chunk.id.slice(0, 2) }/${ chunk.id }`; const entry = chunks.get(path);
          if (!entry || entry.size !== Number(chunk.stored_size)) throw new Error(`Backup restore proof found invalid chunk metadata: ${ path }`);
          const bytes = await store.get(entry.objectKey); if (bytes.byteLength !== entry.size) throw new Error(`Backup restore proof found truncated ciphertext: ${ path }`);
          const digest = createHash('sha256').update(bytes).digest('hex');
          if (digest !== entry.sha256) throw new Error(`Backup restore proof found corrupt ciphertext: ${ path }`);
        }
      } finally { await isolated.cleanup() }
      return signed;
    } finally { await rm(workspace, { recursive: true, force: true }) }
  }

  async verifyManifest(store:BackupObjectStore, key:string):Promise<SignedIncrementalManifest> {
    const signed = JSON.parse((await store.get(key)).toString('utf8')) as SignedIncrementalManifest;
    if (signed?.manifest?.format !== 'sulla-files-incremental-backup' || signed.manifest.version !== 1 || signed.signature?.algorithm !== 'hmac-sha256') throw new Error('Backup manifest format is invalid');
    const value = typeof signed.signature.value === 'string' ? signed.signature.value : '';
    if (!this.verifiers.some(verifier => verifier.verifies(signed.manifest, value))) throw new Error('Backup manifest signature is invalid');
    for (const entry of signed.manifest.entries) {
      if (entry.objectKey !== IncrementalManifestSigner.objectKey(entry.sha256) || !(await store.has(entry.objectKey))) throw new Error(`Backup object is missing: ${ entry.path }`);
    }
    return signed;
  }

  /** A daily/weekly copy re-signs the same verified objects under a new manifest id. */
  async promote(store:BackupObjectStore, source:SignedIncrementalManifest, tier:'daily' | 'weekly'):Promise<{ key:string; manifest:SignedIncrementalManifest }> {
    const manifest:IncrementalManifest = { ...source.manifest, id: randomUUID(), tier };
    const signed = this.signer.signed(manifest);
    const path = IncrementalManifestSigner.manifestKey(manifest);
    await store.putImmutable(path, JSON.stringify(signed));
    await this.verifyManifest(store, path);
    return { key: path, manifest: signed };
  }
}
