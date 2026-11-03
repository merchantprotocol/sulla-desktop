// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import crypto from 'node:crypto';
import {postgresClient}from'@pkg/agent/database/PostgresClient';
import{SullaSettingsModel}from'@pkg/agent/database/models/SullaSettingsModel';
import{getDesktopDeviceId}from'../../deviceIdentity';import{getCurrentUserId}from'../../sullaCloudAuth';
import{cloudRequest,isCloudSignedIn}from'../cloudFetch';import{getCloudPreferences,isCloudKindEnabled}from'../cloudSettings';
import{FilesSyncContainer,FilesSyncClientError}from'../filesSyncV1/containerClient';
import{advanceMemoryCursor,applyMemoryRecord,decryptMemoryRecord,encryptMemoryRecord,isAuthorityWidening,memoryContentHash,memoryHeadMac,memoryKeySlotWinner,memoryStateHash,verifyMemoryHead,type MemoryStateEntry}from'./protocol';
import Logging from'@pkg/utils/logging';const console=Logging.background;
type WireRecord={id:string;generation:number;seq:number;deleted:boolean;deviceId:string;envelope?:{version:1;nonce:string;ciphertext:string}};
type PendingRow={id:string;generation:number|string;record:Record<string,unknown>;source_device_id:string};
type MemoryTableRow={value:Record<string,unknown>};
type MemoryMetaRow={id:string;generation:number|string;content_hash:string|null;deleted:boolean;source_device_id?:string};
type MemoryStateRow={id:string;generation:number|string;deleted:boolean};
const TABLES=['observations','identity_observations','subject_memory.items','subject_memory.subjects','subject_memory.overviews']as const;
class MemorySyncV1Impl{
 private timer:ReturnType<typeof setInterval>|null=null;private running:Promise<void>|null=null;private status={kind:'memory' as const,lastSyncAt:undefined as string|undefined,lastError:undefined as string|undefined,skipped:undefined as string|undefined,pendingAuthority:0};
 start(){if(this.timer)return;this.timer=setInterval(()=>void this.syncNow(),5*60_000);this.timer.unref?.();void this.syncNow()}
 stop(){if(this.timer)clearInterval(this.timer);this.timer=null}getStatus(){return[this.status]}
 syncNow(){return this.running??=this.run().finally(()=>{this.running=null})}
 async deleteCloudCopy(){const r=await cloudRequest('DELETE','/memory-sync/v1/cloud-copy');if(!r.ok)throw new Error(`memory delete failed (${r.status})`);await SullaSettingsModel.set('memorySyncV1OwnDelete','true','string');await SullaSettingsModel.set('memorySyncV1Cursor','0','string');await SullaSettingsModel.set('memorySyncV1VerifiedSeq','0','string')}
 async pending(){return postgresClient.query<PendingRow>('SELECT id,generation,record,source_device_id FROM memory_sync_v1_pending ORDER BY created_at')}
 async decide(id:string,accept:boolean){if(!/^[\w.:-]{1,512}$/.test(id))throw new Error('invalid_memory_record_id');const rows=await postgresClient.query<{record:Record<string,unknown>}>('SELECT record FROM memory_sync_v1_pending WHERE id=$1',[id]);if(!rows[0])return false;if(accept)await this.apply(rows[0].record);await postgresClient.query('DELETE FROM memory_sync_v1_pending WHERE id=$1',[id]);return true}
 private async key(deviceId:string){
  const response=await cloudRequest('GET','/memory-sync/v1/key-slot');
  if(response.ok){const slot=await response.json()as{wrappedKey:string};return Buffer.from((await FilesSyncContainer.vaultUnwrapMemoryKey(slot.wrappedKey)).memoryKey,'base64')}
  if(response.status!==404)throw new Error(`memory key slot failed (${response.status})`);
  const proposed=crypto.randomBytes(32),wrapped=(await FilesSyncContainer.vaultWrapMemoryKey(proposed.toString('base64'))).wrappedKey;
  const created=await cloudRequest('PUT','/memory-sync/v1/key-slot',{headers:{'Content-Type':'application/json'},body:JSON.stringify({wrappedKey:wrapped,deviceId})});
  if(created.status===201){memoryKeySlotWinner(created.status,wrapped);return proposed}
  proposed.fill(0);
  if(created.status===409){const winner=await created.json()as{wrappedKey:string};return Buffer.from((await FilesSyncContainer.vaultUnwrapMemoryKey(memoryKeySlotWinner(created.status,wrapped,winner.wrappedKey))).memoryKey,'base64')}
  throw new Error(`memory key slot create failed (${created.status})`)
 }
 private async rows(){const out:Array<{id:string;table:string;value:Record<string,unknown>;deleted:boolean}>=[];for(const table of TABLES){const rows=await postgresClient.query<MemoryTableRow>(`SELECT row_to_json(t) value FROM ${table} t`);for(const row of rows){const v=row.value as Record<string,unknown>;const pk=table==='subject_memory.overviews'?`${v.subject}:${v.ts}`:String(v.id??v.slug);out.push({id:`${table}:${pk}`,table,value:v,deleted:v.archived===true||v.status==='archived'||Boolean(v.superseded_by)})}}return out}
 private async run(retryConflicts=true){try{const prefs=await getCloudPreferences();if(!isCloudKindEnabled(prefs,'memory')){this.status={...this.status,skipped:'disabled'};return}if(!await isCloudSignedIn())return;const userId=await getCurrentUserId(),deviceId=await getDesktopDeviceId();if(!userId)return;const key=await this.key(deviceId);
  let cursor=Number(await SullaSettingsModel.get('memorySyncV1Cursor','0')),verified=Number(await SullaSettingsModel.get('memorySyncV1VerifiedSeq','0'));
  if(!Number.isSafeInteger(cursor)||cursor<0)cursor=0;if(!Number.isSafeInteger(verified)||verified<0)verified=0;
  let pulledHead:{seq:number;stateHash:string;mac:string;deviceId:string}|null=null;
  while(true){
   const change=await cloudRequest('GET',`/memory-sync/v1/changes?since=${cursor}&limit=200`);if(!change.ok)throw new Error(`memory pull failed (${change.status})`);
   const pulled=await change.json()as{records:WireRecord[];head:{seq:number;stateHash:string;mac:string;deviceId:string}|null;nextCursor:number|null};pulledHead=pulled.head;
   if(pulled.head){verifyMemoryHead(key,pulled.head,verified);verified=Math.max(verified,pulled.head.seq)}else if(verified>0&&await SullaSettingsModel.get('memorySyncV1OwnDelete','')!=='true')throw new Error('memory_head_missing_confirmation_required');
   for(const rec of pulled.records){
    if(rec.deleted){await this.tombstone(rec.id);await postgresClient.query('INSERT INTO memory_sync_v1_records(id,generation,deleted,source_device_id) VALUES($1,$2,true,$3) ON CONFLICT(id) DO UPDATE SET generation=$2,deleted=true,source_device_id=$3',[rec.id,rec.generation,rec.deviceId]);continue}
    if(!rec.envelope)throw new Error('memory_envelope_missing');
    const plain:Record<string,unknown>={...(decryptMemoryRecord(key,userId,rec.id,rec.generation,rec.envelope)as Record<string,unknown>),generation:rec.generation,sourceDeviceId:rec.deviceId};
    if(isAuthorityWidening({table:String(plain.table),value:plain.value as Record<string,unknown>},rec.deviceId!==deviceId))await postgresClient.query('INSERT INTO memory_sync_v1_pending(id,generation,record,source_device_id) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO UPDATE SET generation=$2,record=$3,source_device_id=$4',[rec.id,rec.generation,plain,rec.deviceId]);else await this.applyWithConflict(plain)
   }
   cursor=advanceMemoryCursor(cursor,pulled.records,pulled.head);
   if(pulled.nextCursor===null)break;cursor=pulled.nextCursor;
  }
  const local=await this.rows(),meta=await postgresClient.query<MemoryMetaRow>('SELECT * FROM memory_sync_v1_records'),byId=new Map(meta.map(r=>[r.id,r])),writes:any[]=[],staged:Array<[string,number,string]>=[];for(const row of local){if(writes.length>=100)break;const hash=memoryContentHash(row.value),old=byId.get(row.id),changed=!old||old.content_hash!==hash||Boolean(old.deleted)!==row.deleted,generation=Number(old?.generation??0)+(changed?1:0);if(changed){const expectedGeneration=Number(old?.generation??0);if(row.deleted)writes.push({id:row.id,expectedGeneration,generation,deleted:true});else{const plain={format:1,table:row.table,id:row.id,value:row.value,sourceDeviceId:deviceId};writes.push({id:row.id,expectedGeneration,generation,deleted:false,envelope:encryptMemoryRecord(key,userId,row.id,generation,plain)})}staged.push([row.id,generation,hash])}}
  const state=await postgresClient.query<MemoryStateRow>('SELECT id,generation,deleted FROM memory_sync_v1_records') as MemoryStateEntry[];for(const[id,generation]of staged){const at=state.findIndex(x=>x.id===id),entry={id,generation,deleted:Boolean(local.find(row=>row.id===id)?.deleted)};if(at<0)state.push(entry);else state.splice(at,1,entry)}if(writes.length){const seq=(pulledHead?.seq??0)+1,stateHash=memoryStateHash(state),mac=memoryHeadMac(key,seq,stateHash,deviceId),commit=await cloudRequest('POST','/memory-sync/v1/commit',{headers:{'Content-Type':'application/json'},body:JSON.stringify({expectedHeadSeq:seq-1,head:{seq,stateHash,mac},deviceId,writes:writes.slice(0,100)})});if(!commit.ok){const conflict=await commit.json().catch(()=>({}))as{error?:string};if(commit.status===409&&retryConflicts&&(conflict.error==='record_conflict'||conflict.error==='head_conflict'))return this.run(false);throw new Error(`memory commit failed (${commit.status})`)}for(const[id,generation,hash]of staged)await postgresClient.query('INSERT INTO memory_sync_v1_records(id,generation,deleted,content_hash,source_device_id) VALUES($1,$2,$5,$3,$4) ON CONFLICT(id) DO UPDATE SET generation=$2,deleted=$5,content_hash=$3,source_device_id=$4',[id,generation,hash,deviceId,Boolean(local.find(row=>row.id===id)?.deleted)]);verified=seq}
  await SullaSettingsModel.set('memorySyncV1Cursor',String(cursor),'string');await SullaSettingsModel.set('memorySyncV1VerifiedSeq',String(verified),'string');await SullaSettingsModel.set('memorySyncV1OwnDelete','','string');this.status={kind:'memory',lastSyncAt:new Date().toISOString(),lastError:undefined,skipped:undefined,pendingAuthority:(await this.pending()).length};
 }catch(error){const message=error instanceof Error?error.message:String(error);console.warn(`[MemorySyncV1] ${message}`);const waiting=error instanceof FilesSyncClientError&&(error.code==='vault_locked'||error.code==='no_cloud_vault');this.status={...this.status,lastError:waiting?undefined:message,skipped:waiting?'Waiting for your vault':undefined}}}
 private async applyWithConflict(record:Record<string,unknown>){
  const id=String(record.id),generation=Number(record.generation??1),meta=await postgresClient.queryOne<{generation:number|string;content_hash:string|null}>('SELECT generation,content_hash FROM memory_sync_v1_records WHERE id=$1',[id]);
  if(meta&&Number(meta.generation)===generation){
   const local=(await this.rows()).find(row=>row.id===id),incomingHash=memoryContentHash(record.value);
   if(local&&meta.content_hash&&meta.content_hash!==incomingHash){
    const merged=applyMemoryRecord({id,generation,deleted:false,value:{table:local.table,value:local.value}},{id,generation,deleted:false,value:record});
    if(merged.conflictCopy&&local.table==='subject_memory.items'){
     const conflictId=`${String(local.value.id)}:conflict:${generation}`;
     await this.apply({table:local.table,id:`${local.table}:${conflictId}`,generation,value:{...local.value,id:conflictId,superseded_by:(record.value as Record<string,unknown>)?.id,superseded_ts:Date.now()},sourceDeviceId:'local-conflict'});
    }
   }
  }
  await this.apply(record);
 }
 private async apply(record:Record<string,unknown>){const table=String(record.table),v=record.value as Record<string,unknown>;if(!TABLES.includes(table as any)||!v)return;const json=JSON.stringify(v);
  if(table==='observations')await postgresClient.query(`INSERT INTO observations SELECT * FROM json_populate_record(NULL::observations,$1::json) ON CONFLICT(id) DO UPDATE SET priority=excluded.priority,content=excluded.content,updated_at=excluded.updated_at,archived=excluded.archived,source=excluded.source`,[json]);
  else if(table==='identity_observations')await postgresClient.query(`INSERT INTO identity_observations SELECT * FROM json_populate_record(NULL::identity_observations,$1::json) ON CONFLICT(id) DO UPDATE SET domain=excluded.domain,level=excluded.level,category=excluded.category,content=excluded.content,basis=excluded.basis,updated_at=excluded.updated_at,archived=excluded.archived,source=excluded.source`,[json]);
  else if(table==='subject_memory.subjects')await postgresClient.query(`INSERT INTO subject_memory.subjects SELECT * FROM json_populate_record(NULL::subject_memory.subjects,$1::json) ON CONFLICT(slug) DO UPDATE SET kind=excluded.kind,name=excluded.name,parent=excluded.parent,aliases=excluded.aliases,overview=excluded.overview,status=excluded.status,updated_ts=excluded.updated_ts`,[json]);
  else if(table==='subject_memory.items')await postgresClient.query(`INSERT INTO subject_memory.items SELECT * FROM json_populate_record(NULL::subject_memory.items,$1::json) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,ptype=excluded.ptype,text=excluded.text,why=excluded.why,scope=excluded.scope,origin=excluded.origin,ts=excluded.ts,supersedes=excluded.supersedes,superseded_by=excluded.superseded_by,superseded_ts=excluded.superseded_ts,always_on=excluded.always_on,skill_slug=excluded.skill_slug,worker=excluded.worker`,[json]);
  else await postgresClient.query(`INSERT INTO subject_memory.overviews SELECT * FROM json_populate_record(NULL::subject_memory.overviews,$1::json) ON CONFLICT(subject,ts) DO UPDATE SET text=excluded.text,status=excluded.status,worker=excluded.worker`,[json]);
  const contentHash=memoryContentHash(v);
  await postgresClient.query('INSERT INTO memory_sync_v1_records(id,generation,deleted,content_hash,source_device_id) VALUES($1,$2,false,$3,$4) ON CONFLICT(id) DO UPDATE SET generation=GREATEST(memory_sync_v1_records.generation,$2),deleted=false,content_hash=$3,source_device_id=$4',[String(record.id),Number(record.generation??1),contentHash,String(record.sourceDeviceId??'')]);}
 private async tombstone(id:string){const split=id.indexOf(':'),table=id.slice(0,split),pk=id.slice(split+1);if(table==='observations'||table==='identity_observations')await postgresClient.query(`UPDATE ${table} SET archived=true,updated_at=now() WHERE id=$1`,[pk]);else if(table==='subject_memory.items')await postgresClient.query('UPDATE subject_memory.items SET superseded_by=$2,superseded_ts=$3 WHERE id=$1',[pk,'sync:tombstone',Date.now()]);else if(table==='subject_memory.subjects')await postgresClient.query("UPDATE subject_memory.subjects SET status='archived' WHERE slug=$1",[pk]);else if(table==='subject_memory.overviews'){const at=pk.lastIndexOf(':');if(at>0)await postgresClient.query("UPDATE subject_memory.overviews SET status='archived' WHERE subject=$1 AND ts=$2",[pk.slice(0,at),Number(pk.slice(at+1))])}}
}
export const MemorySyncV1=new MemorySyncV1Impl();
