// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

// Real Postgres: audit spool delivery through AuditSpoolRepository, hash-chain order, the delivery
// lock and the per-connection audit identity. Own schema, real 031 spool migration.
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { appendAuditLine, type AuditEventLine } from '../src/auditChain.js';
import { auditContext, PoolAuditContext } from '../src/auditContext.js';
import { FileAuditWriter } from '../src/fileAudit.js';
import { TransactionRunner } from '../src/FilesTransaction.js';
import { AuditSpoolRepository } from '../src/Repositories/AuditSpoolRepository.js';

const databaseUrl = process.env.SULLA_FILES_TEST_DATABASE_URL;
const migration = (name:string) => readFileSync(new URL(`../migrations/${ name }`, import.meta.url), 'utf8');

describe.skipIf(!databaseUrl)('audit spool delivery (real Postgres)', () => {
  const schema = `files_audit_spec_${ randomUUID().replaceAll('-', '') }`;
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 3, options: `-c search_path=${ schema }` });
  const repository = new AuditSpoolRepository(pool);
  let logsId = '';

  beforeAll(async() => {
    await pool.query(`CREATE SCHEMA ${ schema }`);
    await pool.query('CREATE TABLE collections(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),system_area text)');
    await pool.query(`CREATE TABLE files(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),collection_id uuid NOT NULL,path text NOT NULL,
      current_version_id uuid,deleted_at timestamptz,UNIQUE(collection_id,path))`);
    await pool.query('CREATE TABLE files_protected_files(file_id uuid PRIMARY KEY)');
    await pool.query('CREATE TABLE file_folders(collection_id uuid NOT NULL,path text NOT NULL)');
    await pool.query(migration('031_file_audit_spool.sql'));
    // The writer now takes the same scoped namespace lock as normal file writes. Keep this
    // focused fixture aligned with the production function introduced by migration 067.
    await pool.query(migration('067_scoped_namespace_trigger.sql'));
  });
  afterAll(async() => { await pool.query(`DROP SCHEMA IF EXISTS ${ schema } CASCADE`); await pool.end() });
  beforeEach(async() => {
    await pool.query('TRUNCATE files, files_audit_spool, collections');
    logsId = (await pool.query("INSERT INTO collections(system_area) VALUES('logs') RETURNING id")).rows[0].id;
  });

  const event = (action:string, subjectId = 'f1') => ({ subjectKind: 'file', subjectId, action, actor: 'agent', result: 'ok' });
  async function spool(...events:object[]) { for (const item of events) await pool.query('INSERT INTO files_audit_spool(event) VALUES($1)', [item]) }

  function writer(failFirstAppend = false) {
    const contents = new Map<string, string>();
    let writes = 0;
    let failNext = failFirstAppend;
    const audit = new FileAuditWriter(pool,
      async id => Buffer.from(contents.get(id) ?? ''),
      async(collectionId, bytes) => ({ collectionId, size: bytes.length }),
      async(client, collectionId, path, bytes, _staged, fileId) => {
        const versionId = randomUUID();
        const id = fileId
          ? (await client.query('UPDATE files SET current_version_id=$2 WHERE id=$1 RETURNING id', [fileId, versionId])).rows[0].id
          : (await client.query('INSERT INTO files(collection_id,path,current_version_id) VALUES($1,$2,$3) RETURNING id', [collectionId, path, versionId])).rows[0].id;
        contents.set(id, bytes.toString('utf8'));
        writes++;
        if (failNext) { failNext = false; throw new Error('simulated crash before commit') }
      },
      new TransactionRunner(pool, undefined, { slowTransaction: () => undefined }));
    const lines = async(path:string) => {
      const file = (await pool.query('SELECT id FROM files WHERE collection_id=$1 AND path=$2', [logsId, path])).rows[0];
      return (contents.get(file?.id) ?? '').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as AuditEventLine);
    };
    return { audit, lines, writes: () => writes };
  }

  function expectValidChain(lines:AuditEventLine[]) {
    lines.forEach((line, index) => {
      const { hash, prevHash: _prev, ts, ...input } = line;
      expect(line.prevHash).toBe(index ? lines[index - 1].hash : '');
      expect(hash).toBe(appendAuditLine(input, index ? lines[index - 1] : undefined, ts).hash);
    });
  }

  // risk: audit integrity — events must land in spool order with an unbroken hash chain, also across drains.
  it('appends spooled events in spool order with a verifiable hash chain that continues across drains', async() => {
    await spool(event('create'), event('write'), event('trash'));
    const { audit, lines } = writer();
    await audit.drain();
    expect((await pool.query('SELECT count(*)::int n FROM files_audit_spool')).rows[0].n).toBe(0);
    await spool(event('restore'));
    await audit.drain();
    const chain = await lines('audit/files/f1.jsonl');
    expect(chain.map(line => line.action)).toEqual(['create', 'write', 'trash', 'restore']);
    expectValidChain(chain);
  });

  // risk: audit integrity — rows on both sides of a batch boundary remain ordered and chained.
  it('appends more than one batch in order with one log version per batch', async() => {
    const actions=Array.from({length:205},(_value,index)=>`event-${index}`);
    await spool(...actions.map(action=>event(action,'multi-batch')));
    const {audit,lines,writes}=writer();
    await audit.drain();
    const chain=await lines('audit/files/multi-batch.jsonl');
    expect(chain.map(line=>line.action)).toEqual(actions);
    expectValidChain(chain);
    expect(writes()).toBe(3);
    expect((await pool.query('SELECT count(*)::int n FROM files_audit_spool')).rows[0].n).toBe(0);
  });

  // risk: audit loss/duplicates — a failed batch commit must leave every selected event for retry.
  it('redelivers every event once when a batch write rolls back mid-append', async() => {
    const actions=['create','write','rename','trash','restore'];
    await spool(...actions.map(action=>event(action,'rollback-batch')));
    const {audit,lines,writes}=writer(true);
    await audit.drain();
    expect((await pool.query('SELECT count(*)::int n FROM files_audit_spool')).rows[0].n).toBe(actions.length);
    expect(await lines('audit/files/rollback-batch.jsonl')).toEqual([]);
    await audit.drain();
    const chain=await lines('audit/files/rollback-batch.jsonl');
    expect(chain.map(line=>line.action)).toEqual(actions);
    expect(new Set(chain.map(line=>line.hash)).size).toBe(actions.length);
    expectValidChain(chain);
    expect(writes()).toBe(2);
    expect((await pool.query('SELECT count(*)::int n FROM files_audit_spool')).rows[0].n).toBe(0);
  });

  // risk: audit loss — a vault-secret subject goes to its own log; an invalid event stays queued with an error.
  it('routes vault events to audit/vault and keeps an invalid event queued with a retry error', async() => {
    await spool({ ...event('read', 's1'), subjectKind: 'vault-secret' });
    await spool({ ...event('write', 's1'), meta: { password: 'x' } });
    await spool({ ...event('write', 's1'), subjectKind: 'vault-secret' });
    const { audit, lines } = writer();
    await audit.drain();
    expect((await lines('audit/vault/s1.jsonl')).map(line => line.action)).toEqual(['read','write']);
    const left = (await pool.query('SELECT last_error FROM files_audit_spool')).rows;
    expect(left).toEqual([{ last_error: 'Audit append failed; retry pending' }]);
  });

  // risk: ordering — while another instance holds the delivery lock nothing is appended or dropped.
  it('backs off without delivering while another transaction holds the delivery lock', async() => {
    await spool(event('create'));
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      expect(await repository.tryDeliveryLock(holder)).toBe(true);
      await writer().audit.drain();
      expect((await pool.query('SELECT count(*)::int n FROM files_audit_spool')).rows[0].n).toBe(1);
    } finally { await holder.query('ROLLBACK'); holder.release() }
  });

  // risk: duplicates — a spool row already delivered is reported gone; the oldest pending is next.
  it('returns the oldest pending event and reports a delivered row as gone', async() => {
    await spool(event('a'), event('b'));
    const first = await repository.nextPending();
    expect(first?.event.action).toBe('a');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await repository.deletePending(client, first!.id);
      expect(await repository.lockPending(client, first!.id)).toBe(false);
      await client.query('COMMIT');
    } finally { client.release() }
    expect((await repository.nextPending())?.event.action).toBe('b');
    expect(await repository.findLogsCollectionId()).toBe(logsId);
  });

  // risk: audit attribution — each checked-out connection carries the request's actor.
  it('tags each checked-out connection with the async context identity', async() => {
    const tagged = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    try {
      new PoolAuditContext(tagged).install();
      const read = () => tagged.query("SELECT current_setting('sulla.audit_actor',true) actor,current_setting('sulla.audit_request_id',true) req");
      expect((await auditContext.run({ actor: 'agent-7', requestId: 'r-1' }, read)).rows[0]).toEqual({ actor: 'agent-7', req: 'r-1' });
      expect((await read()).rows[0]).toEqual({ actor: 'sulla-files', req: '' });
    } finally { await tagged.end() }
  });
});
