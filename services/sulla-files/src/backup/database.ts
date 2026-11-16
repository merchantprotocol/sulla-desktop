// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { CoherentSnapshotService } from './CoherentSnapshotService.js';
import { DatabasePublisher } from './DatabasePublisher.js';
import { IsolatedRestoreService, type StagedDatabase } from './IsolatedRestoreService.js';

import type { CoherentSnapshot, PublicationIdentity, RestoreLock, SchemaEvidence } from './SchemaEvidence.js';

export { EPHEMERAL_TABLE_DATA } from './SchemaEvidence.js';
export type { ChunkRow, ColumnEvidence, CoherentSnapshot, ConstraintEvidence, PublicationIdentity, RestoreLock, SchemaEvidence, TableEvidence } from './SchemaEvidence.js';
export { PublicationOutcomeUnknownError } from './DatabasePublisher.js';
export type { StagedDatabase } from './IsolatedRestoreService.js';

/** Everything backup and restore need from PostgreSQL; specs substitute a fake. */
export interface BackupDatabaseOperations {
  createSnapshot(databaseUrl:string, chunkRoot:string, chunkStageRoot:string, rowsPath:string):Promise<CoherentSnapshot>;
  restoreIsolated(databaseUrl:string, rowsPath:string, expected:SchemaEvidence):Promise<StagedDatabase>;
  acquireRestoreLock(databaseUrl:string, chunkRoot:string):Promise<RestoreLock>;
  publish(databaseUrl:string, rowsPath:string, expected:SchemaEvidence, publication:PublicationIdentity, publishChunks:()=>Promise<()=>Promise<void>>):Promise<void>;
  publicationCommitted(databaseUrl:string, publication:PublicationIdentity):Promise<boolean>;
}

/** Composition of the snapshot, isolated-restore and publication services. */
export class BackupDatabase implements BackupDatabaseOperations {
  constructor(
    private readonly snapshots = new CoherentSnapshotService(),
    private readonly isolated = new IsolatedRestoreService(),
    private readonly publisher = new DatabasePublisher(),
  ) {}

  createSnapshot(databaseUrl:string, chunkRoot:string, chunkStageRoot:string, rowsPath:string):Promise<CoherentSnapshot> {
    return this.snapshots.create(databaseUrl, chunkRoot, chunkStageRoot, rowsPath);
  }

  restoreIsolated(databaseUrl:string, rowsPath:string, expected:SchemaEvidence):Promise<StagedDatabase> {
    return this.isolated.restore(databaseUrl, rowsPath, expected);
  }

  acquireRestoreLock(databaseUrl:string, chunkRoot:string):Promise<RestoreLock> { return this.publisher.acquireRestoreLock(databaseUrl, chunkRoot) }

  publish(databaseUrl:string, rowsPath:string, expected:SchemaEvidence, publication:PublicationIdentity, publishChunks:()=>Promise<()=>Promise<void>>):Promise<void> {
    return this.publisher.publish(databaseUrl, rowsPath, expected, publication, publishChunks);
  }

  publicationCommitted(databaseUrl:string, publication:PublicationIdentity):Promise<boolean> { return this.publisher.publicationCommitted(databaseUrl, publication) }
}
