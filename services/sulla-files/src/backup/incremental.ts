import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createCoherentDatabaseSnapshot, EPHEMERAL_TABLE_DATA, restoreIsolatedDatabase, type SchemaEvidence } from './database.js';
import { sha256File, type BackupEntry } from './container.js';
import type { BackupObjectStore } from './destinations.js';

import type { Config } from '../config.js';

export interface IncrementalManifest {
  format:'sulla-files-incremental-backup'; version:1; id:string; createdAt:string; tier:'hourly'|'daily'|'weekly'|'manual';
  postgresVersion:string; snapshotId:string; migrations:string[]; tables:unknown[]; excludedTableData:Record<string,string>;
  entries:(BackupEntry & { objectKey:string })[];
}
export interface SignedIncrementalManifest { manifest:IncrementalManifest; signature:{ algorithm:'hmac-sha256'; value:string } }

function canonical(value:IncrementalManifest):string { return JSON.stringify(value) }
function signature(manifest:IncrementalManifest,key:string|Buffer):string { return createHmac('sha256',key).update(canonical(manifest)).digest('hex') }
function objectKey(digest:string):string { return `objects/sha256/${ digest.slice(0,2) }/${ digest }` }

export async function createIncrementalBackup(config:Config,store:BackupObjectStore,tier:IncrementalManifest['tier']='manual'):Promise<{ key:string; manifest:SignedIncrementalManifest; uploaded:number; reused:number }> {
  const workspace = await mkdtemp(join(tmpdir(),'sulla-files-incremental-'));
  try {
    const rowsPath = join(workspace,'rows.jsonl');
    const snapshot = await createCoherentDatabaseSnapshot(config.databaseUrl,config.chunkRoot,join(workspace,'chunks'),rowsPath);
    const evidencePath = join(workspace,'schema-evidence.json'); await writeFile(evidencePath,JSON.stringify(snapshot.evidence),{mode:0o600});
    const sources:{ path:string; type:BackupEntry['type']; source:string }[] = [
      { path:'database/rows.jsonl',type:'postgres-rows',source:rowsPath },
      { path:'schema/evidence.json',type:'schema-evidence',source:evidencePath },
      ...snapshot.chunks.map(chunk => ({ path:`chunks/${ chunk.collection_id }/${ chunk.id.slice(0,2) }/${ chunk.id }`,type:'encrypted-chunk' as const,source:chunk.backupPath })),
    ];
    let uploaded=0,reused=0; const entries:IncrementalManifest['entries']=[];
    for (const source of sources) {
      const digest=await sha256File(source.source); const key=objectKey(digest.sha256);
      if (await store.has(key)) reused++; else { await store.putFileImmutable(key,source.source); uploaded++ }
      entries.push({ path:source.path,type:source.type,...digest,objectKey:key });
    }
    const manifest:IncrementalManifest={
      format:'sulla-files-incremental-backup',version:1,id:randomUUID(),createdAt:new Date().toISOString(),tier,
      postgresVersion:snapshot.evidence.postgresVersion,snapshotId:snapshot.snapshotId,migrations:snapshot.evidence.migrations,
      tables:snapshot.evidence.tables,excludedTableData:Object.fromEntries(Object.entries(EPHEMERAL_TABLE_DATA).filter(([name])=>snapshot.evidence.tables.some(table=>table.name===name))),entries,
    };
    const signed:SignedIncrementalManifest={manifest,signature:{algorithm:'hmac-sha256',value:signature(manifest,config.capabilitySigningKey)}};
    const key=`snapshots/${ manifest.createdAt.slice(0,10) }/${ manifest.id }.json`;
    await store.putImmutable(key,JSON.stringify(signed));
    await verifyIncrementalManifest(store,key,config.capabilitySigningKey);
    return {key,manifest:signed,uploaded,reused};
  } finally { await rm(workspace,{recursive:true,force:true}) }
}

export async function verifyIncrementalRestore(config:Config,store:BackupObjectStore,key:string):Promise<SignedIncrementalManifest> {
  const signed=await verifyIncrementalManifest(store,key,config.capabilitySigningKey);
  const workspace=await mkdtemp(join(tmpdir(),'sulla-files-restore-proof-'));
  try {
    const byPath=new Map(signed.manifest.entries.map(entry=>[entry.path,entry]));
    const rows=byPath.get('database/rows.jsonl'); const schema=byPath.get('schema/evidence.json');
    if (!rows || !schema) throw new Error('Backup restore proof requires database rows and schema evidence');
    const rowsPath=join(workspace,'rows.jsonl'); const schemaPath=join(workspace,'schema.json');
    await writeFile(rowsPath,await store.get(rows.objectKey),{mode:0o600}); await writeFile(schemaPath,await store.get(schema.objectKey),{mode:0o600});
    for (const [entry,path] of [[rows,rowsPath],[schema,schemaPath]] as const) if ((await sha256File(path)).sha256!==entry.sha256) throw new Error(`Backup object digest mismatch: ${ entry.path }`);
    const evidence=JSON.parse(await readFile(schemaPath,'utf8')) as SchemaEvidence;
    const isolated=await restoreIsolatedDatabase(config.databaseUrl,rowsPath,evidence);
    try {
      const inventory=(await isolated.pool.query<{collection_id:string;id:string;stored_size:number}>('SELECT collection_id::text,id,stored_size FROM chunks ORDER BY collection_id,id')).rows;
      const chunks=new Map(signed.manifest.entries.filter(entry=>entry.type==='encrypted-chunk').map(entry=>[entry.path,entry]));
      if (chunks.size!==inventory.length) throw new Error('Backup restore proof found a chunk inventory mismatch');
      for (const chunk of inventory) {
        const path=`chunks/${ chunk.collection_id }/${ chunk.id.slice(0,2) }/${ chunk.id }`; const entry=chunks.get(path);
        if (!entry || entry.size!==Number(chunk.stored_size)) throw new Error(`Backup restore proof found invalid chunk metadata: ${ path }`);
        const bytes=await store.get(entry.objectKey); if (bytes.byteLength!==entry.size) throw new Error(`Backup restore proof found truncated ciphertext: ${ path }`);
        const digest=createHash('sha256').update(bytes).digest('hex');
        if (digest!==entry.sha256) throw new Error(`Backup restore proof found corrupt ciphertext: ${ path }`);
      }
    } finally { await isolated.cleanup() }
    return signed;
  } finally { await rm(workspace,{recursive:true,force:true}) }
}

export async function verifyIncrementalManifest(store:BackupObjectStore,key:string,signingKey:string|Buffer):Promise<SignedIncrementalManifest> {
  const signed=JSON.parse((await store.get(key)).toString('utf8')) as SignedIncrementalManifest;
  if (signed?.manifest?.format !== 'sulla-files-incremental-backup' || signed.manifest.version !== 1 || signed.signature?.algorithm !== 'hmac-sha256') throw new Error('Backup manifest format is invalid');
  const expected=Buffer.from(signature(signed.manifest,signingKey),'hex'); const actual=Buffer.from(signed.signature.value ?? '','hex');
  if (expected.length !== actual.length || !timingSafeEqual(expected,actual)) throw new Error('Backup manifest signature is invalid');
  for (const entry of signed.manifest.entries) {
    if (entry.objectKey !== objectKey(entry.sha256) || !(await store.has(entry.objectKey))) throw new Error(`Backup object is missing: ${ entry.path }`);
  }
  return signed;
}

export async function promoteManifest(store:BackupObjectStore,source:SignedIncrementalManifest,tier:'daily'|'weekly',key:string|Buffer):Promise<{key:string;manifest:SignedIncrementalManifest}> {
  const manifest:IncrementalManifest={...source.manifest,id:randomUUID(),tier};
  const signed:SignedIncrementalManifest={manifest,signature:{algorithm:'hmac-sha256',value:signature(manifest,key)}};
  const path=`snapshots/${ manifest.createdAt.slice(0,10) }/${ manifest.id }.json`;
  await store.putImmutable(path,JSON.stringify(signed));
  await verifyIncrementalManifest(store,path,key);
  return {key:path,manifest:signed};
}

export function retentionVictims(manifests:SignedIncrementalManifest[],now=new Date()):SignedIncrementalManifest[] {
  const limits={hourly:{count:24,age:24*60*60_000},daily:{count:30,age:30*24*60*60_000},weekly:{count:12,age:12*7*24*60*60_000}} as const;
  const victims:SignedIncrementalManifest[]=[];
  for (const tier of ['hourly','daily','weekly'] as const) {
    const values=manifests.filter(item=>item.manifest.tier===tier).sort((a,b)=>b.manifest.createdAt.localeCompare(a.manifest.createdAt));
    victims.push(...values.filter((item,index)=>index>=limits[tier].count || now.getTime()-Date.parse(item.manifest.createdAt)>limits[tier].age));
  }
  return victims;
}

/** Pruning is refused unless a newer snapshot has passed manifest and isolated-restore verification. */
export function mayPrune(candidate:SignedIncrementalManifest,newer:{ manifest:SignedIncrementalManifest; verifiedAt?:string; restoreVerifiedAt?:string }):boolean {
  return Boolean(newer.verifiedAt && newer.restoreVerifiedAt && newer.manifest.manifest.createdAt>candidate.manifest.createdAt);
}
