// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export const EPHEMERAL_TABLE_DATA:Record<string, string> = {
  file_share_chunk_uploads:   'Short-lived upload authorizations are never restored because replay would revive a capability in a different runtime.',
  file_upload_intents:        'Incomplete unpublished uploads are not Files state; only chunks committed to the chunks table are included.',
  files_restore_publications: 'Restore publication markers are local crash-recovery state and are regenerated when a snapshot is published.',
  generated_previews:         'Generated thumbnails are a disposable cache and are regenerated from authenticated file content.',
};

export interface ColumnEvidence { name: string; type: string; nullable: boolean; default: string | null; generated: string }
export interface ConstraintEvidence { name: string; type: string; definition: string }
export interface TableEvidence { name: string; rows: string; columns: ColumnEvidence[]; constraints: ConstraintEvidence[] }
export interface SchemaEvidence {
  migrations:      string[];
  migrationHashes: Record<string, string>;
  tables:          TableEvidence[];
  extensions:      string[];
  postgresVersion: string;
}
export interface ChunkRow { collection_id: string; id: string; size: number; stored_size: number; location: string; refcount: string; backupPath: string }
export interface ChunkSizeRow { collection_id: string; id: string; stored_size: number }
export interface OwnedTables { migrations: string[]; migrationHashes: Record<string, string>; tables: string[]; extensions: string[] }
export interface CoherentSnapshot { snapshotId: string; evidence: SchemaEvidence; chunks: ChunkRow[]; rowsPath: string }
export interface PublicationIdentity { snapshotId: string; archiveSha256: string }
export interface RestoreLock { release():Promise<void> }

/** Same schema, ignoring row counts. */
export class SchemaEvidenceComparison {
  static sameSchema(actual:SchemaEvidence, expected:SchemaEvidence):boolean {
    return JSON.stringify({ migrations: actual.migrations, migrationHashes: actual.migrationHashes, tables: actual.tables.map(({ rows:_rows, ...table }) => table), extensions: actual.extensions }) ===
      JSON.stringify({ migrations: expected.migrations, migrationHashes: expected.migrationHashes, tables: expected.tables.map(({ rows:_rows, ...table }) => table), extensions: expected.extensions });
  }

  static truncatableTables(expected:SchemaEvidence):string[] {
    return expected.tables.map(table => table.name).filter(name => name !== 'files_schema_migrations');
  }

  static restorableTables(names:string[]):string[] {
    return names.filter(name => name !== 'files_schema_migrations' && !(name in EPHEMERAL_TABLE_DATA));
  }
}
