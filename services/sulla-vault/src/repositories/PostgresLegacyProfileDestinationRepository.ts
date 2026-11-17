// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import type pg from 'pg';
import type { Database, Queryable } from '../db.js';
import { VaultMigrator } from '../database/VaultMigrator.js';
import { PgTransactionRunner, type TransactionPool } from './PgTransactionRunner.js';
import type { LegacySequenceState } from './PostgresLegacyProfileSourceRepository.js';

const DATABASE_IDENTIFIER = /^sulla_vault_[a-f0-9]{48}$/;
const TABLE_IDENTIFIER = /^[_a-zA-Z][a-zA-Z0-9_]{0,62}$/;

/** Per-profile database operations. Pools, admin access, and migration path are injected. */
export class PostgresLegacyProfileDestinationRepository {
  constructor(
    private readonly databaseFor: (identifier: string) => Database,
    private readonly admin: Queryable,
    private readonly migrationsDirectory: string,
    private readonly transactions = new PgTransactionRunner(),
    private readonly maxParameters = 60_000,
  ) {}

  async assertFresh(dbIdentifier: string): Promise<void> {
    this.assertDatabaseIdentifier(dbIdentifier);
    const exists = await this.admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [dbIdentifier]);
    if (!exists.rowCount) return; // Provisioning creates the new DB after this preflight.
    const result = await this.transactions.run(this.database(dbIdentifier) as unknown as TransactionPool, client =>
      client.query("SELECT table_name FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') AND table_type='BASE TABLE' LIMIT 1"));
    if (result.rowCount) throw new Error('Profile database is not fresh');
  }

  async prepareSchema(dbIdentifier: string): Promise<void> {
    await new VaultMigrator(this.migrationsDirectory).migrate(this.database(dbIdentifier));
  }

  async withTransaction<T>(dbIdentifier: string, operation: (writer: { prepare(tables: readonly string[], sequences: readonly LegacySequenceState[]): Promise<readonly string[]>; copy(table: string, rows: readonly Record<string, unknown>[]): Promise<void> }) => Promise<T>): Promise<T> {
    return this.transactions.run(this.database(dbIdentifier) as unknown as TransactionPool, async client => {
      const disabled: string[] = [];
      const result = await operation({
        prepare: (tables, sequences) => this.prepareCopy(client, tables, sequences, disabled), copy: (table, rows) => this.copyWith(client, table, rows),
      });
      // Success path only: on failure the runner's ROLLBACK reverts both the DISABLE and the copy.
      await this.enableUserTriggers(client, disabled);
      return result;
    });
  }

  async rows(dbIdentifier: string, table: string): Promise<readonly Record<string, unknown>[]> {
    this.assertTable(table);
    return (await this.database(dbIdentifier).query(`SELECT * FROM public.\"${table}\"`)).rows;
  }

  async drop(dbIdentifier: string): Promise<void> {
    this.assertDatabaseIdentifier(dbIdentifier);
    await this.admin.query(`DROP DATABASE IF EXISTS \"${dbIdentifier}\"`);
  }

  private async prepareCopy(client: pg.PoolClient, source: readonly string[], sequences: readonly LegacySequenceState[], disabled: string[]): Promise<readonly string[]> {
    const names = [...new Set(source)]; if (names.some(name => !TABLE_IDENTIFIER.test(name))) throw new Error('Invalid source table identifier');
    const sequenceStates = this.validatedSequences(sequences);
    const result = await client.query<{table_name:string}>("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name");
    const dest = result.rows.map(row => row.table_name).filter(name => name !== 'vault_profile_catalog' && name !== 'vault_profile_active');
    if (names.length !== dest.length || [...names].sort().some((name,i) => name !== dest[i])) throw new Error('Legacy and profile table sets differ');
    const fk = await client.query<{table_name:string; foreign_table_name:string; deferrable:boolean}>("SELECT tc.table_name,ccu.table_name AS foreign_table_name,tc.is_deferrable='YES' AS deferrable FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON tc.constraint_name=kcu.constraint_name AND tc.constraint_schema=kcu.constraint_schema JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name=tc.constraint_name AND ccu.constraint_schema=tc.constraint_schema WHERE tc.constraint_type='FOREIGN KEY' AND tc.table_schema='public'");
    const pending = new Set(names), deps = new Map(names.map(n=>[n,new Set<string>()]));
    for (const edge of fk.rows) if(pending.has(edge.table_name)&&pending.has(edge.foreign_table_name)) deps.get(edge.table_name)!.add(edge.foreign_table_name);
    const ordered:string[]=[];
    while(pending.size){ const ready=[...pending].filter(n=>[...deps.get(n)!].every(d=>!pending.has(d))).sort();
      if(!ready.length){ await client.query('SET CONSTRAINTS ALL DEFERRED');
        const cycleEdges = fk.rows.filter(edge => pending.has(edge.table_name) && pending.has(edge.foreign_table_name) && this.isInCycle(edge.table_name, edge.foreign_table_name, deps));
        if(cycleEdges.some(edge => !edge.deferrable)) throw new Error('Foreign key dependency cycle contains a non-deferrable constraint');
        ordered.push(...[...pending].sort()); break; }
      for(const n of ready){pending.delete(n);ordered.push(n);}
    }
    for(const n of names)this.assertTable(n);
    const destSequences = (await client.query<{sequencename:string}>("SELECT sequencename FROM pg_sequences WHERE schemaname='public'")).rows.map(row => row.sequencename).sort();
    const sourceSequences = sequenceStates.map(state => state.name).sort();
    if (destSequences.length !== sourceSequences.length || destSequences.some((name, i) => name !== sourceSequences[i])) throw new Error('Legacy and profile sequence sets differ');
    // User triggers (e.g. items_change_seq) would rewrite copied values; FK constraint triggers stay enabled.
    for (const n of names) { await client.query(`ALTER TABLE public."${n}" DISABLE TRIGGER USER`); disabled.push(n); }
    if(names.length)await client.query(`TRUNCATE ${names.map(n=>`public."${n}"`).join(',')} RESTART IDENTITY CASCADE`);
    for (const state of sequenceStates) await client.query('SELECT setval($1::regclass,$2::bigint,$3::boolean)', [`public."${state.name}"`, String(state.lastValue), state.isCalled]);
    return ordered;
  }
  private validatedSequences(sequences: readonly LegacySequenceState[]): readonly LegacySequenceState[] {
    const seen = new Set<string>();
    for (const state of sequences) {
      if (!TABLE_IDENTIFIER.test(state.name) || seen.has(state.name)) throw new Error('Invalid sequence identifier');
      if (!/^-?\d+$/.test(String(state.lastValue))) throw new Error('Invalid sequence value');
      seen.add(state.name);
    }
    return sequences;
  }
  private async enableUserTriggers(client: pg.PoolClient, tables: readonly string[]): Promise<void> {
    for (const table of tables) { this.assertTable(table); await client.query(`ALTER TABLE public."${table}" ENABLE TRIGGER USER`); }
  }
  private isInCycle(from: string, to: string, dependencies: ReadonlyMap<string, ReadonlySet<string>>): boolean {
    const visited = new Set<string>(); const stack = [to];
    while (stack.length) { const node = stack.pop()!; if (node === from) return true; if (visited.has(node)) continue; visited.add(node); stack.push(...(dependencies.get(node) ?? [])); }
    return false;
  }
  private async copyWith(client: pg.PoolClient, table: string, rows: readonly Record<string, unknown>[]): Promise<void> {
    this.assertTable(table); if(!rows.length)return;
    const columns=[...new Set(rows.flatMap(r=>Object.keys(r)))].sort(); if(!columns.length||columns.some(c=>!TABLE_IDENTIFIER.test(c)))throw new Error('Invalid row column');
    const info=await client.query<{column_name:string;data_type:string;is_identity:string;is_generated:string}>("SELECT column_name,data_type,is_identity,is_generated FROM information_schema.columns WHERE table_schema='public' AND table_name=$1",[table]);
    const meta=new Map(info.rows.map(c=>[c.column_name,c])); const cols=columns.filter(c=>meta.get(c)?.is_generated!=='ALWAYS');
    const identity=cols.some(c=>meta.get(c)?.is_identity==='YES'); const batch=Math.max(1,Math.floor(this.maxParameters/Math.max(1,cols.length)));
    for(let off=0;off<rows.length;off+=batch){const values:unknown[]=[], tuples=rows.slice(off,off+batch).map(row=>`(${cols.map(c=>{let v=row[c]??null;const type=meta.get(c)?.data_type;if(v!==null&&(type==='json'||type==='jsonb'))v=JSON.stringify(v);values.push(v);return `$${values.length}${type==='jsonb'?'::jsonb':type==='json'?'::json':''}`}).join(',')})`);
      if(cols.length)await client.query(`INSERT INTO public."${table}" (${cols.map(c=>`"${c}"`).join(',')}) ${identity?'OVERRIDING SYSTEM VALUE ':''}VALUES ${tuples.join(',')}`,values);
    }
  }

  private database(identifier: string): Database { this.assertDatabaseIdentifier(identifier); return this.databaseFor(identifier); }
  private assertDatabaseIdentifier(identifier: string): void { if (!DATABASE_IDENTIFIER.test(identifier)) throw new Error('Invalid profile database identifier'); }
  private assertTable(identifier: string): void { if (!TABLE_IDENTIFIER.test(identifier)) throw new Error('Invalid SQL table identifier'); }
}
