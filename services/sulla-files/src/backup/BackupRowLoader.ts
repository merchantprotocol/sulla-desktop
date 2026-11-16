// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { createReadStream } from 'node:fs';

import { BackupSchemaRepository } from '../Repositories/BackupSchemaRepository.js';
import { BackupTableDataRepository } from '../Repositories/BackupTableDataRepository.js';
import { MAX_ROW_BYTES } from './BackupRowExporter.js';
import { SchemaEvidenceComparison } from './SchemaEvidence.js';

import type { SchemaEvidence } from './SchemaEvidence.js';
import type pg from 'pg';

/** Loads exported rows into an empty Files schema inside the caller's transaction, then proves integrity. */
export class BackupRowLoader {
  constructor(
    private readonly data = new BackupTableDataRepository(),
    private readonly schema = new BackupSchemaRepository(),
  ) {}

  async loadAndValidate(client:pg.PoolClient, rowsPath:string, expected:SchemaEvidence):Promise<void> {
    await this.loadRows(client, rowsPath, expected); await this.validateForeignKeys(client, expected.tables.map(table => table.name)); await this.resetSequences(client, expected);
  }

  async loadRows(client:pg.PoolClient, rowsPath:string, expected:SchemaEvidence):Promise<void> {
    const restorable = new Set(SchemaEvidenceComparison.restorableTables(expected.tables.map(table => table.name)));
    const tables = new Map(expected.tables.filter(table => restorable.has(table.name)).map(table => [table.name, table]));
    await this.data.replicaReplication(client);
    const insert = async(line:string) => {
      const separator = line.indexOf('\t'); if (separator < 1) throw new Error('Backup database row is malformed');
      const name = line.slice(0, separator); const table = tables.get(name); if (!table) throw new Error('Backup database row targets an unowned table');
      const json = line.slice(separator + 1); if (!json.startsWith('{') || !json.endsWith('}')) throw new Error('Backup database row is not an object');
      const columns = table.columns.filter(column => column.generated === 'NEVER').map(column => column.name);
      await this.data.insertRow(client, name, columns, json);
    };
    const input = createReadStream(rowsPath);
    let fragments:Buffer[] = []; let bytes = 0;
    const append = (value:Buffer) => {
      bytes += value.length;
      if (bytes > MAX_ROW_BYTES) throw new Error('Backup database row exceeds the safe size limit');
      if (value.length) fragments.push(value);
    };
    const flush = async() => {
      const line = Buffer.concat(fragments, bytes).toString('utf8'); fragments = []; bytes = 0;
      await insert(line);
    };
    for await (const value of input) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value); let offset = 0;
      for (;;) {
        const newline = chunk.indexOf(0x0a, offset);
        if (newline < 0) { append(chunk.subarray(offset)); break }
        append(chunk.subarray(offset, newline)); await flush(); offset = newline + 1;
      }
    }
    if (bytes || fragments.length) await flush();
    await this.data.originReplication(client);
  }

  async validateForeignKeys(client:pg.PoolClient, tableNames:string[]):Promise<void> {
    for (const constraint of await this.schema.foreignKeys(client, tableNames)) {
      const childColumns = BackupRowLoader.columnArray(constraint.child_columns); const parentColumns = BackupRowLoader.columnArray(constraint.parent_columns);
      if (!childColumns.length || childColumns.length !== parentColumns.length) throw new Error('Files foreign-key metadata is invalid');
      if (await this.data.violatesForeignKey(client, constraint, childColumns, parentColumns)) {
        throw new Error(`Backup violates foreign key ${ constraint.name }`);
      }
    }
  }

  async resetSequences(client:pg.PoolClient, expected:SchemaEvidence):Promise<void> {
    for (const table of expected.tables) {
      for (const column of table.columns) {
        if (!column.default?.startsWith('nextval(')) continue;
        const sequence = await this.schema.serialSequence(client, table.name, column.name);
        if (sequence) await this.schema.resetSequence(client, sequence, table.name, column.name);
      }
    }
  }

  /** pg returns name[] either parsed or as a `{a,b}` literal depending on type parsers. */
  static columnArray(value:unknown):string[] {
    return Array.isArray(value)
      ? value.map(String)
      : typeof value === 'string' && /^\{[a-z0-9_,]+\}$/.test(value) ? value.slice(1, -1).split(',') : [];
  }
}
