// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { createHash, randomUUID } from 'node:crypto';

import { BackupDestinationRepository } from '../Repositories/BackupDestinationRepository.js';
import { BackupGcObjectRepository } from '../Repositories/BackupGcObjectRepository.js';
import { BackupRunRepository } from '../Repositories/BackupRunRepository.js';
import { BackupSnapshotRepository } from '../Repositories/BackupSnapshotRepository.js';
import { TransactionControlRepository } from '../Repositories/TransactionControlRepository.js';
import { BackupRetentionPolicy } from './BackupRetentionPolicy.js';
import { IncrementalBackupService, type IncrementalManifest, type SignedIncrementalManifest } from './incremental.js';

import type { BackupDestinationConfig, BackupObjectStore } from './destinations.js';
import type { Config } from '../config.js';
import type pg from 'pg';

const HOUR=60*60_000;
export interface BackupFailureAlert { firstFailure(input:{destinationId:string;message:string}):Promise<void> }
export interface PersonalBackupDependencies {
  open:(id:string,destination:BackupDestinationConfig)=>Promise<BackupObjectStore>;
  alerts?:BackupFailureAlert;
  ready?:()=>boolean;
}
export interface PersonalBackupCollaborators {
  incremental:Pick<IncrementalBackupService,'create'|'verifyRestore'|'verifyManifest'|'promote'>;
  retention:BackupRetentionPolicy;
  destinations:BackupDestinationRepository;
  runs:BackupRunRepository;
  snapshots:BackupSnapshotRepository;
  gcObjects:BackupGcObjectRepository;
  control:TransactionControlRepository;
}

export class PersonalBackupScheduler {
  private timer?:NodeJS.Timeout; private stopped=false;
  private readonly active=new Map<string,Promise<void>>();
  private readonly parts:PersonalBackupCollaborators;
  constructor(private readonly db:pg.Pool,private readonly config:Config,private readonly dependencies:PersonalBackupDependencies,collaborators:Partial<PersonalBackupCollaborators>={}) {
    this.parts={
      incremental:collaborators.incremental ?? new IncrementalBackupService(config),
      retention:collaborators.retention ?? new BackupRetentionPolicy(),
      destinations:collaborators.destinations ?? new BackupDestinationRepository(),
      runs:collaborators.runs ?? new BackupRunRepository(),
      snapshots:collaborators.snapshots ?? new BackupSnapshotRepository(),
      gcObjects:collaborators.gcObjects ?? new BackupGcObjectRepository(),
      control:collaborators.control ?? new TransactionControlRepository(),
    };
  }
  start():void { if(!this.timer&&!this.stopped) { this.timer=setTimeout(()=>void this.tick(),3*60_000);this.timer.unref() } }
  stop():void { this.stopped=true; if(this.timer) clearTimeout(this.timer); this.timer=undefined }
  private async tick():Promise<void>{
    this.timer=undefined; const started=Date.now();
    try {
      if(this.config.keyring?.unlocked && (this.dependencies.ready?.()??true)) {
        const rows=await this.parts.destinations.listEnabled(this.db);
        for(const row of rows) {
          if(this.stopped) break;
          await this.enqueue(row.id,row.config,'hourly').catch(()=>undefined);
          await this.active.get(row.id);
        }
      }
    } catch { /* Database/service unavailable: retry at the next tick. */ }
    finally { if(!this.stopped) { this.timer=setTimeout(()=>void this.tick(),Math.max(1_000,HOUR-(Date.now()-started)));this.timer.unref() } }
  }
  /** Reserve the destination before returning; all work after the row insert is background work. */
  async enqueue(destinationId:string,destination:BackupDestinationConfig,tier:IncrementalManifest['tier']):Promise<string> {
    if(this.stopped) throw new Error('Backup scheduler is stopping');
    const { destinations, runs }=this.parts;
    const client=await this.db.connect(); let locked=false;
    try {
      locked=await destinations.tryLock(client,destinationId);
      if(!locked) throw new Error('A backup is already running for this destination');
      if(!(await destinations.isEnabled(client,destinationId))) throw new Error('Backup destination is unavailable');
      // A previous process may have died with an unfinished run. Holding the lock proves it is gone.
      await runs.failInterrupted(client,destinationId);
      const runId=randomUUID();
      await runs.start(client,runId,destinationId);
      const work=this.run(client,runId,destinationId,destination,tier).finally(async()=>{
        this.active.delete(destinationId);
        try { await destinations.unlock(client,destinationId);client.release() } catch { client.release(true) }
      }).catch(()=>undefined);
      this.active.set(destinationId,work);
      return runId;
    } catch(error) {
      if(locked) await destinations.unlock(client,destinationId).catch(()=>undefined);
      client.release();throw error;
    }
  }
  private async saveSnapshot(client:pg.PoolClient,id:string,key:string,signed:SignedIncrementalManifest):Promise<void> {
    await this.parts.snapshots.insertVerified(client,{id:signed.manifest.id,destinationId:id,tier:signed.manifest.tier,manifestKey:key,manifestSha256:createHash('sha256').update(JSON.stringify(signed)).digest('hex'),createdAt:signed.manifest.createdAt});
  }
  private async run(client:pg.PoolClient,runId:string,destinationId:string,destination:BackupDestinationConfig,tier:IncrementalManifest['tier']):Promise<void>{
    const { incremental, retention, runs, snapshots }=this.parts;
    try {
      const store=await this.dependencies.open(destinationId,destination);
      try {
        const created=await incremental.create(store,tier); await incremental.verifyRestore(store,created.key);
        await this.saveSnapshot(client,destinationId,created.key,created.manifest);
        // Promotions reuse the already restore-verified bytes, with independently signed manifests.
        for(const [promoted,since] of retention.promotionWindows(new Date(created.manifest.manifest.createdAt))) {
          if(!(await snapshots.hasRestoreVerifiedSince(client,destinationId,promoted,since))) { const copy=await incremental.promote(store,created.manifest,promoted); await this.saveSnapshot(client,destinationId,copy.key,copy.manifest) }
        }
        await runs.markVerified(client,runId,created.manifest.manifest.id);
        // A retention failure must never relabel a verified backup as failed. Retry at the next success.
        await this.prune(client,destinationId,store,created.manifest).catch(()=>undefined);
      } finally { await store.close() }
    } catch {
      // Transport errors may contain signed URLs or credentials: never persist their text.
      const previous=await runs.previousState(client,destinationId,runId);
      const message='Backup failed. Check destination availability and Vault credentials.';
      await runs.markFailed(client,runId,message);
      if(previous!=='failed') await this.dependencies.alerts?.firstFailure({destinationId,message});
    }
  }
  private async prune(client:pg.PoolClient,id:string,store:BackupObjectStore,newer:SignedIncrementalManifest):Promise<void> {
    const { incremental, retention, runs, snapshots, gcObjects, control }=this.parts;
    const rows=await snapshots.listForDestination(client,id);
    const manifests=await Promise.all(rows.map(row=>row.prune_manifest??incremental.verifyManifest(store,row.manifest_key)));
    const alreadyPruning=new Set(rows.filter(row=>row.prune_manifest).map(row=>row.id));
    const victims=[...new Map([...retention.victims(manifests),...manifests.filter(item=>alreadyPruning.has(item.manifest.id))].map(item=>[item.manifest.id,item])).values()]
      .filter(item=>retention.mayPrune(item,{manifest:newer,verifiedAt:new Date().toISOString(),restoreVerifiedAt:new Date().toISOString()}));
    const ids=new Set(victims.map(item=>item.manifest.id));
    const survivors=manifests.filter(item=>!ids.has(item.manifest.id));
    const objects=retention.unreferencedObjects(victims,survivors);
    await control.begin(client);
    try {
      for(const manifest of victims) await snapshots.markPruning(client,manifest.manifest.id,manifest);
      for(const key of objects) await gcObjects.enqueue(client,id,key);
      await control.commit(client);
    } catch(error) {await control.rollback(client);throw error}
    // Saved tombstones make both a missing manifest and a repeated deletion safe after a crash.
    for(const row of rows.filter(row=>ids.has(row.id))) {
      await store.remove(row.manifest_key);
      await control.begin(client);
      try {
        await runs.detachSnapshot(client,row.id);
        await snapshots.delete(client,row.id);
        await control.commit(client);
      } catch(error) { await control.rollback(client);throw error }
    }
    const referenced=new Set(survivors.flatMap(item=>item.manifest.entries.map(entry=>entry.objectKey)));
    for(const key of await gcObjects.pending(client,id)) {
      if(!referenced.has(key)) await store.remove(key);
      await gcObjects.remove(client,id,key);
    }
  }
}
