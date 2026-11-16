// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, rmdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { BackupRecoverabilityCheck } from './BackupRecoverabilityCheck.js';
import { BACKUP_ARCHIVE_EXTENSION } from './CoherentBackupService.js';
import { BackupContainer, BackupFileDigest, type ExtractedBackup } from './container.js';
import { BackupDatabase, PublicationOutcomeUnknownError, type BackupDatabaseOperations, type PublicationIdentity, type SchemaEvidence, type StagedDatabase } from './database.js';
import { RestoreDirectories } from './RestoreDirectories.js';
import { RESTORE_WORKSPACE_PREFIX, RestoreJournal } from './RestoreJournal.js';

import type { Config } from '../config.js';

/**
 * Restores a coherent archive onto an empty Files store: validate in an isolated database,
 * journal the staged ciphertext, then publish rows and ciphertext together.
 */
export class CoherentRestoreService {
  private readonly journal:RestoreJournal;

  constructor(
    private readonly database:BackupDatabaseOperations = new BackupDatabase(),
    private readonly recoverability:Pick<BackupRecoverabilityCheck, 'assertStagedInventory'> = new BackupRecoverabilityCheck(),
    private readonly container = new BackupContainer(),
    private readonly digest = new BackupFileDigest(),
    private readonly directories = new RestoreDirectories(),
  ) { this.journal = new RestoreJournal(database, directories) }

  async restore(config:Config, archive?:string):Promise<string> {
    await mkdir(dirname(config.chunkRoot), { recursive: true, mode: 0o700 });
    const lock = await this.database.acquireRestoreLock(config.databaseUrl, config.chunkRoot);
    try { return await this.restoreLocked(config, archive) } finally { await lock.release() }
  }

  /** The named archive, or the newest one in the backup target. */
  async selectedArchive(config:Config, archive?:string):Promise<string> {
    if (archive) return resolve(archive);
    if (!config.backupTarget) throw new Error('SULLA_FILES_BACKUP_TARGET or an archive path is required');
    const candidates = (await readdir(config.backupTarget)).filter(name => name.endsWith(BACKUP_ARCHIVE_EXTENSION)).sort();
    if (!candidates.length) throw new Error('No coherent Files backup found');
    return join(config.backupTarget, candidates.at(-1)!);
  }

  private async restoreLocked(config:Config, archive?:string):Promise<string> {
    const selected = await this.selectedArchive(config, archive);
    await mkdir(dirname(config.chunkRoot), { recursive: true, mode: 0o700 });
    const archiveDigest = await this.digest.sha256(selected);
    let publication:PublicationIdentity | undefined;
    // A prior process may have died after publishing ciphertext or while COMMIT's
    // result was ambiguous. Reconcile its durable marker before creating a new stage.
    const recovered = await this.journal.recoverInterrupted(config, archiveDigest.sha256);
    if (recovered) return selected;
    // The validated ciphertext stage must share a filesystem with chunkRoot so
    // publication and rollback use atomic rename even when /tmp is another volume.
    const workspace = await mkdtemp(join(dirname(config.chunkRoot), RESTORE_WORKSPACE_PREFIX));
    let extracted:ExtractedBackup | undefined;
    let database:StagedDatabase | undefined;
    let preserveWorkspace = false;
    try {
      extracted = await this.container.extract(selected, join(workspace, 'validated'));
      const evidence = JSON.parse(await readFile(extracted.path('schema/evidence.json'), 'utf8')) as SchemaEvidence;
      if (JSON.stringify(evidence.tables) !== JSON.stringify(extracted.manifest.tables) ||
          JSON.stringify(evidence.migrations) !== JSON.stringify(extracted.manifest.migrations) ||
          evidence.postgresVersion !== extracted.manifest.postgresVersion) throw new Error('Backup schema evidence is inconsistent');
      database = await this.database.restoreIsolated(config.databaseUrl, extracted.path('database/rows.jsonl'), evidence);
      await this.recoverability.assertStagedInventory(database.pool, evidence, extracted.manifest);
      await mkdir(extracted.path('chunks'), { recursive: true, mode: 0o700 });
      publication = { snapshotId: extracted.manifest.snapshotId, archiveSha256: archiveDigest.sha256 };
      const baseState = {
        version:          1 as const,
        publicationToken: randomUUID(),
        stagedIdentity:   await this.directories.identity(extracted.path('chunks')),
        ...publication,
      };
      await this.journal.write(workspace, { ...baseState, phase: 'validated' });
      const staged = extracted;
      await this.database.publish(config.databaseUrl, staged.path('database/rows.jsonl'), evidence, publication, async() => {
        if (!(await this.directories.isEmpty(config.chunkRoot))) throw new Error('Files restore target contains data; existing content was preserved');
        const targetBefore = await this.directories.exists(config.chunkRoot) ? await this.directories.identity(config.chunkRoot) : null;
        await this.journal.write(workspace, { ...baseState, phase: 'publishing', targetBefore });
        try { await rmdir(config.chunkRoot) } catch (error:any) { if (error?.code !== 'ENOENT') throw error; }
        await rename(staged.path('chunks'), config.chunkRoot);
        if (!RestoreDirectories.sameIdentity(await this.directories.identity(config.chunkRoot), baseState.stagedIdentity)) throw new Error('Published ciphertext directory identity changed unexpectedly');
        try { await this.journal.write(workspace, { ...baseState, phase: 'chunks-published', targetBefore }) } catch (error) { await rename(config.chunkRoot, staged.path('chunks')); throw error }
        return () => rename(config.chunkRoot, staged.path('chunks'));
      });
      console.log(`[SullaFiles] coherent backup restored from ${ selected }; complete fresh-device key recovery through Vault before starting Files`);
      return selected;
    } catch (error) {
      preserveWorkspace = error instanceof PublicationOutcomeUnknownError;
      throw error;
    } finally {
      await database?.cleanup().catch(() => undefined);
      if (!preserveWorkspace) {
        await extracted?.cleanup().catch(() => undefined);
        await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }
}
