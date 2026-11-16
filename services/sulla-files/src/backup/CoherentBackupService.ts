// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { BackupRecoverabilityCheck } from './BackupRecoverabilityCheck.js';
import { BackupContainer, BackupFileDigest, type BackupManifest, type BackupObject } from './container.js';
import { BackupDatabase, EPHEMERAL_TABLE_DATA, type BackupDatabaseOperations } from './database.js';
import { RestoreDirectories } from './RestoreDirectories.js';

import type { Config } from '../config.js';

export const BACKUP_ARCHIVE_EXTENSION = '.sulla-files-backup';

/** Writes one self-contained `.sulla-files-backup` archive after proving the snapshot restores. */
export class CoherentBackupService {
  constructor(
    private readonly database:BackupDatabaseOperations = new BackupDatabase(),
    private readonly recoverability:Pick<BackupRecoverabilityCheck, 'assertRecoverable'> = new BackupRecoverabilityCheck(),
    private readonly container = new BackupContainer(),
    private readonly digest = new BackupFileDigest(),
  ) {}

  async backup(config:Config):Promise<string> {
    if (!config.backupTarget) throw new Error('SULLA_FILES_BACKUP_TARGET is required');
    const target = resolve(config.backupTarget);
    if (RestoreDirectories.isWithin(config.chunkRoot, target)) throw new Error('Backup target must not be inside the Files chunk store');
    const chunkRoot = await lstat(config.chunkRoot);
    if (!chunkRoot.isDirectory() || chunkRoot.isSymbolicLink()) throw new Error('Files chunk store must be a real directory');
    await mkdir(target, { recursive: true, mode: 0o700 });
    const workspace = await mkdtemp(join(tmpdir(), 'sulla-files-backup-'));
    try {
      const rowsPath = join(workspace, 'rows.jsonl');
      const snapshot = await this.database.createSnapshot(config.databaseUrl, config.chunkRoot, join(workspace, 'chunks'), rowsPath);
      const validation = await this.database.restoreIsolated(config.databaseUrl, rowsPath, snapshot.evidence);
      try { await this.recoverability.assertRecoverable(validation.pool) } finally { await validation.cleanup() }

      const evidencePath = join(workspace, 'schema-evidence.json');
      await writeFile(evidencePath, JSON.stringify(snapshot.evidence), { mode: 0o600 });
      const objects:BackupObject[] = [];
      objects.push({ path: 'database/rows.jsonl', type: 'postgres-rows', sourcePath: rowsPath, ...await this.digest.sha256(rowsPath) });
      objects.push({ path: 'schema/evidence.json', type: 'schema-evidence', sourcePath: evidencePath, ...await this.digest.sha256(evidencePath) });
      for (const chunk of snapshot.chunks) {
        const digest = await this.digest.sha256(chunk.backupPath);
        if (digest.size !== Number(chunk.stored_size)) throw new Error('Staged chunk size no longer matches database metadata');
        objects.push({ path: `chunks/${ chunk.collection_id }/${ chunk.id.slice(0, 2) }/${ chunk.id }`, type: 'encrypted-chunk', sourcePath: chunk.backupPath, ...digest });
      }
      const manifest:BackupManifest = {
        format:            'sulla-files-coherent-backup',
        version:           1,
        createdAt:         new Date().toISOString(),
        postgresVersion:   snapshot.evidence.postgresVersion,
        snapshotId:        snapshot.snapshotId,
        migrations:        snapshot.evidence.migrations,
        tables:            snapshot.evidence.tables,
        excludedTableData: Object.fromEntries(Object.entries(EPHEMERAL_TABLE_DATA).filter(([name]) => snapshot.evidence.tables.some(table => table.name === name))),
        entries:           objects.map(({ sourcePath: _sourcePath, ...entry }) => entry),
      };
      const destination = join(target, `sulla-files-${ manifest.createdAt.replace(/[:.]/g, '-') }${ BACKUP_ARCHIVE_EXTENSION }`);
      await this.container.write(destination, manifest, objects);
      console.log(`[SullaFiles] coherent backup created ${ destination }`);
      return destination;
    } finally { await rm(workspace, { recursive: true, force: true }) }
  }
}
