import { createHash, randomUUID } from 'node:crypto';

import { createIncrementalBackup, verifyIncrementalRestore, type IncrementalManifest } from './incremental.js';
import { openBackupDestination, type S3BackupClient, type VmNasMountHelper } from './destinations.js';

import type { Config } from '../config.js';
import type pg from 'pg';

const HOUR=60*60_000;

export interface BackupFailureAlert { firstFailure(input:{destinationId:string;message:string}):Promise<void> }

export class PersonalBackupScheduler {
  private timer?:NodeJS.Timeout; private stopped=false;
  constructor(private readonly db:pg.Pool,private readonly config:Config,private readonly dependencies:{nas?:VmNasMountHelper;s3?:S3BackupClient;alerts?:BackupFailureAlert}={}) {}
  start():void { if(!this.timer&&!this.stopped) this.timer=setTimeout(()=>void this.tick(),HOUR) }
  stop():void { this.stopped=true; if(this.timer) clearTimeout(this.timer); this.timer=undefined }
  private async tick():Promise<void>{
    this.timer=undefined;
    try { const rows=(await this.db.query('SELECT id,config FROM files_backup_destinations WHERE enabled=TRUE ORDER BY id')).rows; for(const row of rows) await this.run(row.id,row.config,'hourly') }
    finally { if(!this.stopped) this.timer=setTimeout(()=>void this.tick(),HOUR) }
  }
  async run(destinationId:string,destination:any,tier:IncrementalManifest['tier']):Promise<void>{
    const runId=randomUUID(); await this.db.query(`INSERT INTO files_backup_runs(id,destination_id,state) VALUES($1,$2,'running')`,[runId,destinationId]);
    try {
      const store=await openBackupDestination(destination,this.dependencies);
      try {
        const created=await createIncrementalBackup(this.config,store,tier); await verifyIncrementalRestore(this.config,store,created.key);
        await this.db.query(`INSERT INTO files_backup_snapshots(id,destination_id,tier,manifest_key,manifest_sha256,created_at,verified_at,restore_verified_at)
          VALUES($1,$2,$3,$4,$5,$6,NOW(),NOW())`,[created.manifest.manifest.id,destinationId,tier,created.key,createHash('sha256').update(JSON.stringify(created.manifest)).digest('hex'),created.manifest.manifest.createdAt]);
        await this.db.query(`UPDATE files_backup_runs SET state='verified',finished_at=NOW(),snapshot_id=$2 WHERE id=$1`,[runId,created.manifest.manifest.id]);
      } finally { await store.close() }
    } catch(error:any) {
      const previous=(await this.db.query(`SELECT 1 FROM files_backup_runs WHERE destination_id=$1 AND state='failed' AND id<>$2 LIMIT 1`,[destinationId,runId])).rowCount;
      const message=String(error?.message??'Backup failed').slice(0,1000); await this.db.query(`UPDATE files_backup_runs SET state='failed',finished_at=NOW(),error_code=$2,error_message=$3 WHERE id=$1`,[runId,error?.code??'backup-failed',message]);
      if(!previous) await this.dependencies.alerts?.firstFailure({destinationId,message});
    }
  }
}
