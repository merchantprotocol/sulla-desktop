// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RequestAuditLog } from '../src/Http/RequestAuditLog.js';
import { AuditLogRepository } from '../src/Repositories/AuditLogRepository.js';
import { FilesTransactionAbortedError } from '../src/Repositories/TransactionControlRepository.js';
import { TransactionRunner } from '../src/FilesTransaction.js';

const databaseUrl=process.env.SULLA_FILES_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('request audit transaction attachment (real Postgres)',()=>{
  const schema=`files_request_audit_spec_${randomUUID().replaceAll('-','')}`;
  const pool=new pg.Pool({connectionString:databaseUrl,max:2,options:`-c search_path=${schema}`});
  const transactions=new TransactionRunner(pool,undefined,{slowTransaction:()=>undefined});
  const request={} as any;
  const actor={agentId:'agent-1',userId:'user-1',jobId:'job-1',deviceId:'device-1',kind:'capability'};
  const audit=new RequestAuditLog({identity:()=>actor} as any,new AuditLogRepository(pool));

  beforeAll(async()=>{
    await pool.query(`CREATE SCHEMA ${schema}`);
    await pool.query(`CREATE TABLE audit_log(
      id bigserial PRIMARY KEY,who_type text NOT NULL,who_id text NOT NULL,device_or_run_id text,
      file_id uuid,version_id uuid,action text NOT NULL,org_id text,details jsonb NOT NULL DEFAULT '{}'::jsonb)`);
  });
  afterAll(async()=>{await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await pool.end()});

  // risk: audit integrity — the secondary request-audit row must commit or roll back with the file write.
  it('uses the write transaction client rather than autocommitting through the pool',async()=>{
    await expect(transactions.run('fuse-create',async client=>{
      await audit.record(request,'fuse-create',{id:randomUUID(),current_version_id:randomUUID()},{versionId:'v1'},client);
      throw new Error('simulated file-write rollback');
    })).rejects.toThrow('simulated file-write rollback');
    expect(Number((await pool.query('SELECT COUNT(*) n FROM audit_log')).rows[0].n)).toBe(0);

    await transactions.run('fuse-create',async client=>{
      await audit.record(request,'fuse-create',{id:randomUUID(),current_version_id:randomUUID()},{versionId:'v2'},client);
    });
    expect((await pool.query('SELECT action,who_id,device_or_run_id FROM audit_log')).rows).toEqual([
      {action:'fuse-create',who_id:'agent-1',device_or_run_id:'job-1'},
    ]);
  });

  // risk: data loss — a swallowed statement error must not make TransactionRunner report a rollback as success.
  it('rejects when PostgreSQL rolls back a transaction after swallowed statement failure',async()=>{
    await expect(transactions.run('swallowed-statement-failure',async client=>{
      await client.query("INSERT INTO audit_log(who_type,who_id,action,details) VALUES('user','bad','x','not-json'::jsonb)").catch(()=>undefined);
      return 'apparently successful';
    })).rejects.toBeInstanceOf(FilesTransactionAbortedError);
  });
});
