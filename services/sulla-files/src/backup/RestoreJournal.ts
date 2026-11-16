// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { lstat, mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { RestoreDirectories, type DirectoryIdentity } from './RestoreDirectories.js';

import type { BackupDatabaseOperations, PublicationIdentity } from './database.js';
import type { Config } from '../config.js';

export const RESTORE_WORKSPACE_PREFIX = '.sulla-files-restore-';

export interface RestoreState extends PublicationIdentity {
  version:          1;
  phase:            'validated' | 'publishing' | 'chunks-published';
  publicationToken: string;
  stagedIdentity:   DirectoryIdentity;
  targetBefore?:    DirectoryIdentity | null;
}

/**
 * The durable `publication.json` each restore workspace keeps, and the reconciliation that runs
 * before a new restore: a prior process may have died after publishing ciphertext or while
 * COMMIT's result was ambiguous.
 */
export class RestoreJournal {
  constructor(
    private readonly database:Pick<BackupDatabaseOperations, 'publicationCommitted'>,
    private readonly directories = new RestoreDirectories(),
  ) {}

  async write(workspace:string, state:RestoreState):Promise<void> {
    const temporary = join(workspace, `.publication-${ process.pid }-${ Date.now() }.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(state)); await handle.sync() } finally { await handle.close() }
    await rename(temporary, join(workspace, 'publication.json'));
    const directory = await open(workspace, 'r'); try { await directory.sync() } finally { await directory.close() }
  }

  static parse(value:unknown):RestoreState {
    const state = value as Partial<RestoreState>;
    const identity = state.stagedIdentity;
    const target = state.targetBefore;
    const validIdentity = (candidate:DirectoryIdentity | null | undefined) => candidate == null || Boolean(/^\d+$/.test(candidate.device) && /^\d+$/.test(candidate.inode));
    if (state?.version !== 1 || !['validated', 'publishing', 'chunks-published'].includes(state.phase ?? '') ||
        typeof state.snapshotId !== 'string' || !/^[a-f0-9]{64}$/.test(state.archiveSha256 ?? '') ||
        !/^[0-9a-f-]{36}$/.test(state.publicationToken ?? '') || !identity ||
        !/^\d+$/.test(identity.device) || !/^\d+$/.test(identity.inode) || !validIdentity(target) ||
        (state.phase !== 'validated' && target === undefined)) {
      throw new Error('Files restore recovery state is malformed; it was preserved for inspection');
    }
    return state as RestoreState;
  }

  /** Reconciles every leftover workspace; true when the selected archive was already published. */
  async recoverInterrupted(config:Config, selectedArchiveSha256:string):Promise<boolean> {
    const parent = dirname(config.chunkRoot);
    for (const name of (await readdir(parent)).filter(value => value.startsWith(RESTORE_WORKSPACE_PREFIX)).sort()) {
      const workspace = join(parent, name); const info = await lstat(workspace);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Files restore recovery path has an unsafe type');
      const statePath = join(workspace, 'publication.json');
      if (!(await this.directories.exists(statePath))) throw new Error('Files restore workspace has no durable publication state; it was preserved for inspection');
      const state = RestoreJournal.parse(JSON.parse(await readFile(statePath, 'utf8')));
      if (await this.database.publicationCommitted(config.databaseUrl, state)) {
        await rm(workspace, { recursive: true, force: true });
        if (state.archiveSha256 === selectedArchiveSha256) return true;
        continue;
      }
      const stagedChunks = join(workspace, 'validated', 'chunks');
      if (await this.directories.exists(stagedChunks)) {
        if (!RestoreDirectories.sameIdentity(await this.directories.identity(stagedChunks), state.stagedIdentity)) {
          throw new Error('Files restore staged ciphertext identity changed; recovery artifacts were preserved');
        }
        await rm(workspace, { recursive: true, force: true });
        continue;
      }
      if (state.phase === 'validated') {
        throw new Error('Files restore validated stage is missing; the target was preserved for inspection');
      }
      if (!(await this.directories.exists(config.chunkRoot)) || !RestoreDirectories.sameIdentity(await this.directories.identity(config.chunkRoot), state.stagedIdentity)) {
        throw new Error('Files restore target is not the ciphertext directory owned by the recovery journal; it was preserved');
      }
      await mkdir(dirname(stagedChunks), { recursive: true, mode: 0o700 });
      await rename(config.chunkRoot, stagedChunks);
      await rm(workspace, { recursive: true, force: true });
    }
    return false;
  }
}
