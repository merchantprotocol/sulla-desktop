// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

// Real-Postgres specs for the Files write path under load. Point SULLA_FILES_TEST_DATABASE_URL at a
// throwaway Postgres 16 started with a short idle-in-transaction timeout, e.g.
//   docker run --rm -e POSTGRES_PASSWORD=x -p 55432:5432 postgres:16-alpine -c idle_in_transaction_session_timeout=3000
// Each run creates and drops its own schema.
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RetryableDatabaseError, TransactionRunner } from '../src/FilesTransaction.js';
import { VersionContentStager } from '../src/VersionContentStager.js';
import { connect } from '../src/db.js';
import { TransactionScope, TransactionScopeViolation } from '../src/TransactionScope.js';
import { FileAuditWriter } from '../src/fileAudit.js';

const databaseUrl = process.env.SULLA_FILES_TEST_DATABASE_URL;
const sleep = (ms:number) => new Promise(resolve => setTimeout(resolve, ms));

/** A chunk store whose fsync'd write takes as long as a saturated VM's does. */
class SlowChunkStore {
  readonly blobs = new Map<string, Uint8Array>();
  constructor(private readonly delayMs:number) {}
  async storedSize(collectionId:string, id:string) { return this.blobs.get(`${ collectionId }/${ id }`)?.length }
  async put(collectionId:string, id:string, bytes:Uint8Array) { await sleep(this.delayMs); this.blobs.set(`${ collectionId }/${ id }`, bytes); return true }
}
const testCrypto = {
  chunkId: (plain:Uint8Array) => createHash('sha256').update(plain).digest('hex'),
  encryptChunk: async(plain:Uint8Array) => Buffer.concat([Buffer.from('enc:'), Buffer.from(plain)]),
};
const testKeyring = { keys: async() => ({ data: new Uint8Array(32), dedup: new Uint8Array(32) }) };

/** Samples pg_stat_activity for this spec's connections while a write runs: any transaction left waiting. */
class TransactionWatcher {
  readonly idleInTransaction:string[] = [];
  private running = true;
  private loop?:Promise<void>;
  constructor(private readonly admin:pg.Pool, private readonly applicationName:string) {}
  start() {
    this.loop = (async() => {
      while (this.running) {
        // A short transaction is briefly "idle in transaction" between its own statements; one that
        // waits on other work stays there. Count only waits longer than a statement round trip.
        const rows = (await this.admin.query(`SELECT state FROM pg_stat_activity WHERE application_name=$1 AND state LIKE 'idle in transaction%'
          AND clock_timestamp()-state_change > interval '250 milliseconds'`, [this.applicationName])).rows;
        for (const row of rows) this.idleInTransaction.push(row.state);
        await sleep(25);
      }
    })();
  }
  async stop() { this.running = false; await this.loop }
}

describe.skipIf(!databaseUrl)('Files write path transactions (real Postgres)', () => {
  const schema = `files_write_spec_${ randomUUID().replaceAll('-', '') }`;
  const applicationName = `files-write-spec-${ randomUUID().slice(0, 8) }`;
  const options = { connectionString: databaseUrl, options: `-c search_path=${ schema }`, application_name: applicationName };
  const admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  let pool:pg.Pool;

  beforeAll(async() => {
    await admin.query(`CREATE SCHEMA ${ schema }`);
    await admin.query(`CREATE TABLE ${ schema }.file_versions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), path text NOT NULL, manifest_hash text NOT NULL)`);
    await admin.query(`CREATE TABLE ${ schema }.collections(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), system_area text)`);
    await admin.query(`CREATE TABLE ${ schema }.files(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), collection_id uuid NOT NULL, path text NOT NULL, current_version_id uuid, content text NOT NULL DEFAULT '')`);
    await admin.query(`CREATE TABLE ${ schema }.files_audit_spool(id bigserial PRIMARY KEY, event jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT NOW(), last_error text)`);
  });
  afterAll(async() => { await pool?.end(); await admin.query(`DROP SCHEMA IF EXISTS ${ schema } CASCADE`); await admin.end() });
  beforeEach(async() => {
    await pool?.end();
    pool = new pg.Pool({ ...options, max: 4 });
    pool.on('error', () => undefined);
    pool.on('connect', client => client.on('error', () => undefined));
    await admin.query(`TRUNCATE ${ schema }.file_versions, ${ schema }.files, ${ schema }.files_audit_spool, ${ schema }.collections`);
  });

  it('sets a deliberate backend session budget on real connections',async()=>{
    const configured=await connect(databaseUrl!,1);
    try{
      expect((await configured.query('SHOW idle_in_transaction_session_timeout')).rows[0].idle_in_transaction_session_timeout).toBe('15s');
      expect((await configured.query('SHOW statement_timeout')).rows[0].statement_timeout).toBe('30s');
    }finally{await configured.end()}
  });

  it('rejects an indirect nested acquire against real Postgres instead of waiting for the pool',async()=>{
    TransactionScope.guardPool(pool,'throw');
    const runner=new TransactionRunner(pool);
    await expect(runner.run('reintroduced-regression',async()=>{
      await Promise.resolve();await pool.query('SELECT 1');
    })).rejects.toBeInstanceOf(TransactionScopeViolation);
    expect((await pool.query('SELECT 1 AS ok')).rows[0].ok).toBe(1);
  });

  // risk: data loss under load — a create held BEGIN while its chunk write fsync'd, sat idle in
  // transaction and was terminated by Postgres (the iMac torture run: p95 89 s, EIO).
  it('commits a create whose chunk write is slow without ever holding an idle transaction', async() => {
    const stager = new VersionContentStager(testKeyring, new SlowChunkStore(3_500), testCrypto);
    const held:number[] = [];
    const runner = new TransactionRunner(pool, undefined, { slowTransaction: () => undefined }, 0);
    const timed = new TransactionRunner(pool, undefined, { slowTransaction: (_name, ms) => held.push(ms) }, 0);
    const watcher = new TransactionWatcher(admin, applicationName); watcher.start();
    const collectionId = randomUUID();
    // The production order: stage (slow) first, then a short transaction that records the version.
    const staged = await stager.stage(collectionId, Buffer.from('x'.repeat(2048)));
    const version = await timed.run('create', async client =>
      (await client.query('INSERT INTO file_versions(path,manifest_hash) VALUES($1,$2) RETURNING id', ['Stress/f0001.txt', staged.manifestHash])).rows[0]);
    await watcher.stop();
    expect(version.id).toBeTruthy();
    expect(watcher.idleInTransaction).toEqual([]);
    expect(held).toHaveLength(1);
    expect(held[0]).toBeLessThan(500);
    expect((await runner.run('read', client => client.query('SELECT count(*)::int n FROM file_versions'))).rows[0].n).toBe(1);
  }, 20_000);

  // risk: partial writes — a connection terminated mid-commit must leave no version and answer a retryable 503.
  it('rolls back a write whose connection is terminated mid-transaction and lets the retry succeed', async() => {
    const runner = new TransactionRunner(pool, undefined, { slowTransaction: () => undefined });
    const attempt = () => runner.run('write', async client => {
      await client.query('INSERT INTO file_versions(path,manifest_hash) VALUES($1,$2)', ['Stress/f0002.txt', 'm1']);
      const pid = (await client.query('SELECT pg_backend_pid() pid')).rows[0].pid;
      if (!terminated) { terminated = true; await admin.query('SELECT pg_terminate_backend($1)', [pid]); await sleep(50) }
      await client.query("UPDATE file_versions SET manifest_hash='m2' WHERE path='Stress/f0002.txt'");
    });
    let terminated = false;
    const failure = await attempt().catch(error => error);
    expect(failure).toBeInstanceOf(RetryableDatabaseError);
    expect(failure.status).toBe(503);
    expect(failure.code).toBe('FILES_DB_RETRYABLE');
    expect((await admin.query(`SELECT count(*)::int n FROM ${ schema }.file_versions`)).rows[0].n).toBe(0);
    await attempt();
    const rows = (await admin.query(`SELECT manifest_hash FROM ${ schema }.file_versions`)).rows;
    expect(rows).toEqual([{ manifest_hash: 'm2' }]);
    // The dead client was evicted, not returned to the pool for the next request to trip on.
    for (let i = 0; i < 4; i++) expect((await pool.query('SELECT 1 ok')).rows[0].ok).toBe(1);
  }, 20_000);

  // risk: a statement error (not a lost connection) must keep its own error and not be retried as 503.
  it('keeps a real statement error as-is and leaves the pool healthy', async() => {
    const runner = new TransactionRunner(pool, undefined, { slowTransaction: () => undefined });
    const failure = await runner.run('bad', client => client.query('INSERT INTO file_versions(path) VALUES($1)', ['p'])).catch(error => error);
    expect(failure).not.toBeInstanceOf(RetryableDatabaseError);
    expect(failure.code).toBe('23502');
    expect((await pool.query('SELECT 1 ok')).rows[0].ok).toBe(1);
  });

  async function auditFixture() {
    const logs = (await admin.query(`INSERT INTO ${ schema }.collections(system_area) VALUES('logs') RETURNING id`)).rows[0].id;
    await admin.query(`INSERT INTO ${ schema }.files_audit_spool(event) VALUES($1),($2)`, [
      { subjectKind: 'file', subjectId: 'f1', action: 'fuse-write', actor: 'agent', result: 'ok' },
      { subjectKind: 'file', subjectId: 'f1', action: 'fuse-write', actor: 'agent', result: 'ok' },
    ]);
    return logs as string;
  }
  function auditWriter(options:{ stageDelayMs:number; onWrite?:(client:pg.PoolClient) => Promise<void> }) {
    const contents = new Map<string, string>();
    return {
      contents,
      writer: new FileAuditWriter<{ collectionId:string; size:number; text:string }>(pool,
        async(id) => Buffer.from(contents.get(id) ?? ''),
        async(collectionId, bytes) => { await sleep(options.stageDelayMs); return { collectionId, size: bytes.length, text: bytes.toString() } },
        async(client, collectionId, path, _bytes, staged, fileId) => {
          await options.onWrite?.(client);
          const versionId = randomUUID();
          const row = fileId
            ? (await client.query('UPDATE files SET current_version_id=$2 WHERE id=$1 RETURNING id', [fileId, versionId])).rows[0]
            : (await client.query('INSERT INTO files(collection_id,path,current_version_id) VALUES($1,$2,$3) RETURNING id', [collectionId, path, versionId])).rows[0];
          contents.set(row.id, staged.text);
        },
        new TransactionRunner(pool, undefined, { slowTransaction: () => undefined })),
    };
  }

  // risk: audit loss — the drain read and encrypted the log inside BEGIN, idled past the timeout and
  // then appended on the terminated client ("Client has encountered a connection error").
  it('delivers audit events in order without holding a transaction across the slow append work', async() => {
    await auditFixture();
    const { writer, contents } = auditWriter({ stageDelayMs: 3_500 });
    const watcher = new TransactionWatcher(admin, applicationName); watcher.start();
    await writer.drain();
    await watcher.stop();
    expect(watcher.idleInTransaction).toEqual([]);
    expect((await admin.query(`SELECT count(*)::int n FROM ${ schema }.files_audit_spool`)).rows[0].n).toBe(0);
    const lines = [...contents.values()][0].trim().split('\n').map(line => JSON.parse(line));
    expect(lines).toHaveLength(2);
    expect(lines[1].prevHash).toBe(lines[0].hash);
  }, 30_000);

  // risk: audit loss — an append whose connection dies must keep the event and retry on a fresh client.
  it('keeps the audit event when its connection dies mid-append and delivers it exactly once on retry', async() => {
    await auditFixture();
    let killed = false;
    const { writer, contents } = auditWriter({ stageDelayMs: 0, onWrite: async client => {
      if (killed) return;
      killed = true;
      const pid = (await client.query('SELECT pg_backend_pid() pid')).rows[0].pid;
      await admin.query('SELECT pg_terminate_backend($1)', [pid]); await sleep(50);
    } });
    await writer.drain();
    const retained = (await admin.query(`SELECT last_error FROM ${ schema }.files_audit_spool ORDER BY id`)).rows;
    expect(retained).toHaveLength(2);
    expect(retained[0].last_error).toBe('Audit append failed; retry pending');
    await writer.drain();
    expect((await admin.query(`SELECT count(*)::int n FROM ${ schema }.files_audit_spool`)).rows[0].n).toBe(0);
    expect([...contents.values()][0].trim().split('\n')).toHaveLength(2);
  }, 30_000);
});
