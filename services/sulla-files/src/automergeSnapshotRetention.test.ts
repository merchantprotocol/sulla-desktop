// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';
import { AutomergeSnapshotRetention } from './automergeSnapshotRetention.js';

describe('AutomergeSnapshotRetention', () => {
  it('prunes one file at a time from a keyset scan, under row and time budgets, without touching restore history', async () => {
    // risk: data loss (keeps the wrong snapshots) and unbounded work per run
    const scans:unknown[][]=[]; const fileCalls:{sql:string;values:unknown[]}[]=[];
    const files=['11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222'];
    const db={
      query:async(sql:string,values:unknown[]=[])=>{
        scans.push(values);
        // First scan returns two files, the next scan (after the cursor) is empty: one full lap.
        return { rows: scans.length===1 ? files.map(file_id=>({file_id})) : [], rowCount:0 };
      },
      connect:async()=>({
        query:async(sql:string,values:unknown[]=[])=>{
          if(sql==='BEGIN'||sql==='COMMIT'||sql==='ROLLBACK'||sql.includes('set_config')) return {rows:[],rowCount:0};
          fileCalls.push({sql,values});
          const n=values[0]===files[0]?100:7;
          return {rows:Array.from({length:n},(_,i)=>({version_id:String(i)})),rowCount:n};
        },
        release:()=>undefined,
      }),
    } as any;
    const retention=new AutomergeSnapshotRetention(db,50,30,100,10_000,2_000);

    expect(await retention.prune()).toBe(107);
    // Bounded discovery: keyset cursor plus an index-row cap, restarting from the first id after a full lap.
    expect(scans[0]).toEqual(['00000000-0000-0000-0000-000000000000',2_000]);
    expect(scans[1]).toEqual([files[1],2_000]);
    expect(AutomergeSnapshotRetention.FILE_SCAN_SQL).toMatch(/ORDER BY file_id LIMIT \$2/);
    // One statement per file with keep-recent, daily days and batch cap.
    expect(fileCalls.map(call=>call.values)).toEqual([[files[0],50,30,100],[files[1],50,30,100]]);
    const sql=AutomergeSnapshotRetention.FILE_PRUNE_SQL;
    // Keep rule: newest N, the LAST snapshot of each day inside the window (day_rank=1), and the current version.
    expect(sql).toContain('r.recent_rank > $2');
    expect(sql).toContain('r.day_rank > 1');
    expect(sql).toContain('PARTITION BY av.created_at::date ORDER BY av.created_at DESC');
    expect(sql).toContain('current_version_id=r.version_id');
    expect(sql).toContain('LIMIT $4');
    // Payload only: rows and heads stay for merges, file_versions stay for restore.
    expect(sql).toContain('SET document=NULL');
    expect(sql).not.toMatch(/DELETE\s+FROM/i);
  });

  it('stops at the time budget and resumes from its cursor next run', async () => {
    // risk: a long table makes one run block the Files event loop or database
    let scans=0; let fileStatements=0;
    const db={
      query:async()=>{ scans++; return { rows: Array.from({length:50},(_,i)=>({file_id:`00000000-0000-0000-0000-${ String(i).padStart(12,'0') }`})) }; },
      connect:async()=>({ query:async(sql:string)=>{ if(!/BEGIN|COMMIT|ROLLBACK|set_config/.test(sql)){ fileStatements++; await new Promise(r=>setTimeout(r,5)); } return {rows:[],rowCount:0}; }, release:()=>undefined }),
    } as any;
    const retention=new AutomergeSnapshotRetention(db,50,30,100,20,2_000);
    await retention.prune();
    expect(scans).toBe(1);
    expect(fileStatements).toBeGreaterThan(0);
    expect(fileStatements).toBeLessThan(50);
  });
});
