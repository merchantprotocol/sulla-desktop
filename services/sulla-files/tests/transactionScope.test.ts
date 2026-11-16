// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';
import { TransactionScope, TransactionScopeViolation } from '../src/TransactionScope.js';
import { TransactionRunner } from '../src/FilesTransaction.js';
import { VersionContentStager } from '../src/VersionContentStager.js';
import { filesPoolMax } from '../src/db.js';

describe('Files transaction resource guard',()=>{
  it('rejects an indirect nested pool acquire before it can wait for the only client',async()=>{
    let acquired=0;const statements:string[]=[];
    const pool=TransactionScope.guardPool({connect:async()=>{acquired++;return {query:async(sql:string)=>{statements.push(sql)},release:()=>undefined}},query:async()=>undefined} as any,'throw');
    const runner=new TransactionRunner(pool);
    const requireCollection=async()=>{await Promise.resolve();return pool.query('SELECT 1')};
    await expect(runner.run('deliberate-regression',async()=>requireCollection())).rejects.toBeInstanceOf(TransactionScopeViolation);
    expect(acquired).toBe(1);expect(statements).toEqual(['BEGIN','ROLLBACK']);
    expect(TransactionScope.current()).toBeUndefined();
    await pool.connect();expect(acquired).toBe(2);
  });
  it('rejects nested runners and staging even with an unwrapped pool',async()=>{
    const runner=new TransactionRunner({connect:async()=>({query:async()=>undefined,release:()=>undefined})} as any);
    await expect(runner.run('outer',()=>runner.run('inner',async()=>undefined))).rejects.toBeInstanceOf(TransactionScopeViolation);
    const stager=new VersionContentStager({keys:async()=>{throw new Error('must not reach vault')}} as any,{} as any,{} as any);
    await expect(runner.run('stage-regression',()=>stager.stage('collection',Buffer.alloc(0)))).rejects.toBeInstanceOf(TransactionScopeViolation);
  });
  it('keeps unrelated concurrent staging outside the transaction context',async()=>{
    let release!:()=>void;const gate=new Promise<void>(r=>release=r);
    const open=TransactionScope.within('other-request',async()=>{await gate});
    expect(()=>TransactionScope.assertOutside('independent-request','throw')).not.toThrow();release();await open;
  });
  // risk: data loss — only derived index state may acknowledge before its WAL flush; file content and audit spool remain synchronous.
  it('disables synchronous commit only inside explicitly reconstructible indexing transactions',async()=>{
    const calls:string[]=[];
    const runner=new TransactionRunner({connect:async()=>({query:async(sql:string)=>{calls.push(sql)},release:()=>undefined})} as any);
    await runner.run('index-content-commit',async()=>undefined);
    expect(calls).toEqual(['BEGIN','SET LOCAL synchronous_commit = off','COMMIT']);
    calls.length=0;
    await runner.run('fuse-write',async()=>undefined);
    expect(calls).toEqual(['BEGIN','COMMIT']);
    calls.length=0;
    await runner.run('audit-spool-insert',async()=>undefined);
    expect(calls).toEqual(['BEGIN','COMMIT']);
  });
  it('bounds the configured backend budget',()=>{
    expect(filesPoolMax(undefined)).toBe(12);expect(filesPoolMax('24')).toBe(24);
    for(const bad of ['0','65','NaN','1.5',''])expect(()=>filesPoolMax(bad)).toThrow();
  });
});
