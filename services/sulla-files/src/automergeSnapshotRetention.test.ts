// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';
import { AutomergeSnapshotRetention } from './automergeSnapshotRetention.js';

describe('AutomergeSnapshotRetention', () => {
  it('prunes restart-safe payload batches under a row and time budget without touching restore history', async () => {
    // risk: restore correctness and unbounded database results
    const calls:{sql:string;values:unknown[]}[]=[];
    let batch=0;
    const db={connect:async()=>({
      query:async(sql:string,values:unknown[]=[])=>{
        calls.push({sql,values});
        if(sql==='BEGIN'||sql==='COMMIT'||sql==='ROLLBACK') return {rows:[],rowCount:0};
        if(sql.includes('set_config')) return {rows:[],rowCount:1};
        batch++;
        return {rows:Array.from({length:batch===1?100:7},(_,index)=>({version_id:String(index)})),rowCount:batch===1?100:7};
      },release:()=>undefined,
    })} as any;
    const retention=new AutomergeSnapshotRetention(db,50,30,100,10_000);

    expect(await retention.prune()).toBe(107);
    const updates=calls.filter(call=>call.sql.includes('UPDATE file_automerge_versions'));
    expect(updates).toHaveLength(2);
    expect(updates[0].sql).toContain('LIMIT $3 FOR UPDATE SKIP LOCKED');
    expect(updates[0].values).toEqual([50,30,100]);
    expect(updates[0].sql).toContain('current_version_id=av.version_id');
    expect(updates[0].sql).toContain("created_at::date=av.created_at::date");
    expect(updates[0].sql).toContain('SET document=NULL');
    expect(updates.some(call=>/DELETE\s+FROM\s+file_versions/i.test(call.sql))).toBe(false);
  });
});
