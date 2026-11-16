// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { BackupSchemaRepository } from '../Repositories/BackupSchemaRepository.js';
import { MigrationCatalog } from './MigrationCatalog.js';

import type { OwnedTables, SchemaEvidence, TableEvidence } from './SchemaEvidence.js';
import type pg from 'pg';

/** Describes the Files-owned part of a database: applied migrations, tables, columns, constraints, counts. */
export class SchemaEvidenceReader {
  constructor(
    private readonly catalog = new MigrationCatalog(),
    private readonly schema = new BackupSchemaRepository(),
  ) {}

  async ownedTables(client:pg.PoolClient):Promise<OwnedTables> {
    const applied = await this.schema.appliedMigrations(client);
    const installed = await this.catalog.installed();
    const tables = new Set<string>(['files_schema_migrations']); const extensions = new Set<string>(); const migrationHashes:Record<string, string> = {};
    for (const migration of applied) {
      const source = installed.get(migration);
      if (!source) throw new Error(`Applied Files migration source is unavailable: ${ migration }`);
      migrationHashes[migration] = source.hash;
      for (const table of source.tables) tables.add(table);
      for (const extension of source.extensions) extensions.add(extension);
    }
    const existing = await this.schema.existingTables(client, [...tables]);
    if (!['collections', 'chunks', 'file_versions', 'files_collection_key_bundles'].every(name => existing.includes(name))) {
      throw new Error('Files schema is incomplete; migrate and recovery-enroll it before backup');
    }
    return { migrations: applied, migrationHashes, tables: existing, extensions: [...extensions].sort() };
  }

  async evidence(client:pg.PoolClient, owned:OwnedTables):Promise<SchemaEvidence> {
    const result:TableEvidence[] = [];
    for (const table of owned.tables) {
      const columns = await this.schema.columns(client, table);
      const constraints = await this.schema.constraints(client, table);
      const rows = await this.schema.rowCount(client, table);
      result.push({ name: table, rows, columns, constraints });
    }
    const extensions = owned.extensions.length ? await this.schema.installedExtensions(client, owned.extensions) : [];
    const postgresVersion = await this.schema.serverVersion(client);
    return { migrations: owned.migrations, migrationHashes: owned.migrationHashes, tables: result, extensions, postgresVersion };
  }

  /** Owned tables, then their evidence, read on one client. */
  async describe(client:pg.PoolClient):Promise<SchemaEvidence> {
    return this.evidence(client, await this.ownedTables(client));
  }
}
