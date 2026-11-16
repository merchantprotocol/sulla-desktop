// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { SqlIdentifier } from '../backup/SqlIdentifier.js';

import type { ForeignKeyMetadata } from './BackupSchemaRepository.js';
import type pg from 'pg';

/** Row-level access to the Files tables while a backup is taken or a snapshot is loaded. */
export class BackupTableDataRepository {
  async beginRepeatableRead(client:pg.PoolClient):Promise<void> { await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ') }

  async lockShared(client:pg.PoolClient, tables:string[]):Promise<void> {
    await client.query(`LOCK TABLE ${ tables.map(name => SqlIdentifier.publicTable(name)).join(',') } IN SHARE MODE`);
  }

  async lockExclusive(client:pg.PoolClient, tables:string[]):Promise<void> {
    await client.query(`LOCK TABLE ${ tables.map(name => SqlIdentifier.publicTable(name)).join(',') } IN ACCESS EXCLUSIVE MODE`);
  }

  async currentSnapshotId(client:pg.PoolClient):Promise<string> {
    return ((await client.query('SELECT txid_current_snapshot()::text AS id')).rows as { id:string }[])[0].id;
  }

  async openRowCursor(client:pg.PoolClient, table:string):Promise<void> {
    await client.query(`DECLARE files_backup_rows NO SCROLL CURSOR FOR SELECT to_jsonb(value)::text AS row_json FROM ${ SqlIdentifier.publicTable(table) } value`);
  }

  async fetchRows(client:pg.PoolClient, batch:number):Promise<string[]> {
    return ((await client.query(`FETCH FORWARD ${ batch } FROM files_backup_rows`)).rows as { row_json:string }[]).map(row => row.row_json);
  }

  async closeRowCursor(client:pg.PoolClient):Promise<void> { await client.query('CLOSE files_backup_rows') }

  async replicaReplication(client:pg.PoolClient):Promise<void> { await client.query("SET LOCAL session_replication_role='replica'") }

  async originReplication(client:pg.PoolClient):Promise<void> { await client.query("SET LOCAL session_replication_role='origin'") }

  /** Inserts one exported row; only the listed (non-generated) columns are populated. */
  async insertRow(client:pg.PoolClient, table:string, columns:string[], json:string):Promise<void> {
    const list = columns.map(column => SqlIdentifier.quote(column)).join(',');
    const target = SqlIdentifier.publicTable(table);
    await client.query(`INSERT INTO ${ target }(${ list }) SELECT ${ list } FROM jsonb_populate_record(NULL::${ target },$1::jsonb)`, [json]);
  }

  async truncate(client:pg.PoolClient, tables:string[]):Promise<void> {
    await client.query(`TRUNCATE ${ tables.map(name => SqlIdentifier.publicTable(name)).join(',') }`);
  }

  async hasAnyRow(client:pg.PoolClient, table:string):Promise<boolean> {
    return Boolean((await client.query(`SELECT 1 FROM ${ SqlIdentifier.publicTable(table) } LIMIT 1`)).rowCount);
  }

  /** True when a child row breaks the foreign key (MATCH FULL or MATCH SIMPLE semantics). */
  async violatesForeignKey(client:pg.PoolClient, constraint:ForeignKeyMetadata, childColumns:string[], parentColumns:string[]):Promise<boolean> {
    const column = (name:string) => `c.${ SqlIdentifier.quote(name) }`;
    const nonnull = childColumns.map(name => `${ column(name) } IS NOT NULL`).join(' AND ');
    const any = childColumns.map(name => `${ column(name) } IS NOT NULL`).join(' OR ');
    const partial = childColumns.map(name => `${ column(name) } IS NULL`).join(' OR ');
    const match = childColumns.map((name, index) => `${ column(name) }=p.${ SqlIdentifier.quote(parentColumns[index]) }`).join(' AND ');
    const parent = SqlIdentifier.publicTable(constraint.parent_table);
    const predicate = constraint.match_type === 'f'
      ? `((${ any }) AND ((${ partial }) OR NOT EXISTS(SELECT 1 FROM ${ parent } p WHERE ${ match })))`
      : `((${ nonnull }) AND NOT EXISTS(SELECT 1 FROM ${ parent } p WHERE ${ match }))`;
    return Boolean((await client.query(`SELECT 1 FROM ${ SqlIdentifier.publicTable(constraint.child_table) } c WHERE ${ predicate } LIMIT 1`)).rowCount);
  }
}
