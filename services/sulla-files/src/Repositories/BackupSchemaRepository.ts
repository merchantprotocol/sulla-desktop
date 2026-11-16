// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { SqlIdentifier } from '../backup/SqlIdentifier.js';

import type { ColumnEvidence, ConstraintEvidence } from '../backup/SchemaEvidence.js';
import type pg from 'pg';

type Queryable = pg.Pool | pg.PoolClient;

export interface ForeignKeyMetadata {
  name: string; child_table: string; parent_table: string; child_columns: unknown; parent_columns: unknown; match_type: string;
}

/** Reads and installs the Files schema that a coherent backup describes. */
export class BackupSchemaRepository {
  async appliedMigrations(client:Queryable):Promise<string[]> {
    return ((await client.query('SELECT version FROM files_schema_migrations ORDER BY version')).rows as { version:string }[]).map(row => row.version);
  }

  async existingTables(client:Queryable, names:string[]):Promise<string[]> {
    return ((await client.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name=ANY($1) ORDER BY table_name`, [names],
    )).rows as { table_name:string }[]).map(row => row.table_name);
  }

  async columns(client:Queryable, table:string):Promise<ColumnEvidence[]> {
    return (await client.query(
      `SELECT column_name AS name,udt_schema||'.'||udt_name AS type,is_nullable='YES' AS nullable,column_default AS default,is_generated AS generated
         FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`, [table],
    )).rows as ColumnEvidence[];
  }

  async constraints(client:Queryable, table:string):Promise<ConstraintEvidence[]> {
    return (await client.query(
      `SELECT c.conname AS name,c.contype AS type,pg_get_constraintdef(c.oid,true) AS definition
         FROM pg_constraint c JOIN pg_class r ON r.oid=c.conrelid JOIN pg_namespace n ON n.oid=r.relnamespace
        WHERE n.nspname='public' AND r.relname=$1 ORDER BY c.conname`, [table],
    )).rows as ConstraintEvidence[];
  }

  async rowCount(client:Queryable, table:string):Promise<string> {
    return ((await client.query(`SELECT count(*)::text AS count FROM ${ SqlIdentifier.publicTable(table) }`)).rows as { count:string }[])[0].count;
  }

  async installedExtensions(client:Queryable, names:string[]):Promise<string[]> {
    return ((await client.query('SELECT extname FROM pg_extension WHERE extname=ANY($1) ORDER BY extname', [names])).rows as { extname:string }[]).map(row => row.extname);
  }

  async serverVersion(client:Queryable):Promise<string> {
    return ((await client.query("SELECT current_setting('server_version') AS version")).rows as { version:string }[])[0].version;
  }

  async createMigrationLedger(client:Queryable):Promise<void> {
    await client.query('CREATE TABLE files_schema_migrations(version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
  }

  /** Runs one installed migration's SQL; the caller owns the surrounding transaction. */
  async runMigration(client:pg.PoolClient, sql:string):Promise<void> { await client.query(sql) }

  async recordMigration(client:pg.PoolClient, version:string):Promise<void> {
    await client.query('INSERT INTO files_schema_migrations(version) VALUES($1)', [version]);
  }

  async foreignKeys(client:Queryable, tableNames:string[]):Promise<ForeignKeyMetadata[]> {
    return (await client.query(`SELECT c.conname AS name,child.relname AS child_table,parent.relname AS parent_table,c.confmatchtype AS match_type,
      ARRAY(SELECT a.attname FROM unnest(c.conkey) WITH ORDINALITY k(attnum,ord) JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum ORDER BY k.ord) AS child_columns,
      ARRAY(SELECT a.attname FROM unnest(c.confkey) WITH ORDINALITY k(attnum,ord) JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.attnum ORDER BY k.ord) AS parent_columns
     FROM pg_constraint c JOIN pg_class child ON child.oid=c.conrelid JOIN pg_class parent ON parent.oid=c.confrelid
     JOIN pg_namespace n ON n.oid=child.relnamespace WHERE c.contype='f' AND n.nspname='public' AND child.relname=ANY($1)`, [tableNames])).rows as ForeignKeyMetadata[];
  }

  async serialSequence(client:Queryable, table:string, column:string):Promise<string | null> {
    return ((await client.query('SELECT pg_get_serial_sequence($1,$2) AS sequence', [`public.${ table }`, column])).rows as { sequence:string | null }[])[0].sequence;
  }

  async resetSequence(client:Queryable, sequence:string, table:string, column:string):Promise<void> {
    await client.query('SELECT setval($1::regclass,COALESCE((SELECT max(' + SqlIdentifier.quote(column) + ') FROM public.' + SqlIdentifier.quote(table) + '),1),EXISTS(SELECT 1 FROM public.' + SqlIdentifier.quote(table) + '))', [sequence]);
  }
}
