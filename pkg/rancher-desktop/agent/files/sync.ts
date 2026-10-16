import { decryptChunk } from './crypto';
import { FileKeyring } from './keyring';
import { SullaFilesService } from './service';
import { postgresClient } from '../database/PostgresClient';

import type { ChunkStore, ToolExecutionContext } from './types';

export interface SyncResult { pushed: number; pulled: number; merged: number; conflictCopies: number }

function mergeText(base:string, ours:string, theirs:string):string | null {
  const b = base.split('\n'); const o = ours.split('\n'); const t = theirs.split('\n');
  if (b.length !== o.length || b.length !== t.length) return null;
  const out:string[] = [];
  for (let i = 0; i < b.length; i++) {
    if (o[i] === t[i])out.push(o[i]); else if (o[i] === b[i])out.push(t[i]); else if (t[i] === b[i])out.push(o[i]); else return null;
  }
  return out.join('\n');
}

export class SullaFilesSyncClient {
  constructor(private readonly baseUrl:string | undefined, private readonly store:ChunkStore, private readonly keyring:FileKeyring, private readonly files:SullaFilesService, private readonly token?:string) {}
  private headers(context:ToolExecutionContext, extra:Record<string, string> = {}):Record<string, string> { return { 'content-type': 'application/json', 'x-sulla-user-id': context.sub, 'x-sulla-device-id': context.device_id ?? 'desktop', ...(this.token ? { authorization: `Bearer ${ this.token }` } : { }), ...extra } }
  private async json(context:ToolExecutionContext, path:string, init:RequestInit = {}) { if (!this.baseUrl) throw new Error('Sulla Files server is not configured'); const r = await fetch(new URL(path, this.baseUrl), { ...init, headers: { ...this.headers(context), ...(init.headers as any) } }); if (!r.ok) { const body = await r.json().catch(() => ({})); throw Object.assign(new Error((body).error ?? `sync HTTP ${ r.status }`), { status: r.status, body }) } return r.json() }
  async discoverCollections(context:ToolExecutionContext):Promise<string[]> {
    if (!this.baseUrl) return [];
    const rows = await this.json(context, '/v1/collections') as any[];
    for (const row of rows) {
      await postgresClient.query(`INSERT INTO collections(id,org_id,owner_user_id,agent_run_id,name,kind,home,encryption,encrypted_data_key,dedup_key_ciphertext,retention_policy,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT(id) DO NOTHING`, [row.id, row.org_id, row.owner_user_id, row.agent_run_id, row.name, row.kind, row.home, row.encryption, row.encrypted_data_key, row.dedup_key_ciphertext, row.retention_policy, row.created_at, row.updated_at]);
      await postgresClient.query(`INSERT INTO collection_acl(collection_id,principal_type,principal_id,role) VALUES($1,'user',$2,'manage') ON CONFLICT DO NOTHING`, [row.id, context.sub]);
    }
    return rows.map(row => row.id);
  }

  async sync(context:ToolExecutionContext, collectionId:string):Promise<SyncResult> {
    if (!this.baseUrl) return { pushed: 0, pulled: 0, merged: 0, conflictCopies: 0 };
    const collection = await postgresClient.queryOne<any>('SELECT * FROM collections WHERE id=$1 AND kind=\'knowledge\'', [collectionId]); if (!collection) throw new Error('Only knowledge collections sync');
    await this.json(context, '/v1/collections', { method: 'POST', body: JSON.stringify({ collection }) });
    const deviceId = context.device_id ?? 'desktop';
    await postgresClient.query(`INSERT INTO file_sync_cursors(collection_id,device_id) VALUES($1,$2) ON CONFLICT DO NOTHING`, [collectionId, deviceId]);
    const cursor = await postgresClient.queryOne<any>('SELECT * FROM file_sync_cursors WHERE collection_id=$1 AND device_id=$2', [collectionId, deviceId]);
    const result:SyncResult = { pushed: 0, pulled: 0, merged: 0, conflictCopies: 0 };
    const pending = await postgresClient.query<any>(`SELECT j.seq,row_to_json(f.*) file,row_to_json(v.*) version,row_to_json(m.*) manifest FROM journal j JOIN files f ON f.id=j.file_id JOIN file_versions v ON v.id=j.version_id JOIN manifests m ON m.hash=v.manifest_hash WHERE j.collection_id=$1 AND j.seq>$2 AND v.device_id=$3 ORDER BY j.seq`, [collectionId, cursor.last_push_seq, deviceId]);
    for (const item of pending) { await this.pushOne(context, collectionId, item, result); await postgresClient.query('UPDATE file_sync_cursors SET last_push_seq=$3 WHERE collection_id=$1 AND device_id=$2', [collectionId, deviceId, item.seq]) }
    await postgresClient.query(`UPDATE file_sync_cursors SET last_push_seq=COALESCE((
      SELECT MAX(j.seq) FROM journal j JOIN file_versions v ON v.id=j.version_id WHERE j.collection_id=$1 AND v.device_id=$2
    ),last_push_seq) WHERE collection_id=$1 AND device_id=$2`, [collectionId, deviceId]);
    const entries = await this.json(context, `/v1/collections/${ collectionId }/journal?after=${ cursor.last_seq }`);
    for (const entry of entries as any[]) { await this.pullOne(context, entry); result.pulled++; await postgresClient.query('UPDATE file_sync_cursors SET last_seq=$3 WHERE collection_id=$1 AND device_id=$2', [collectionId, deviceId, entry.seq]) }
    return result;
  }

  private async pushOne(context:ToolExecutionContext, collectionId:string, item:any, result:SyncResult) {
    const chunks = await postgresClient.query<any>('SELECT * FROM chunks WHERE collection_id=$1 AND id=ANY($2::text[])', [item.version.chunk_collection_id, item.manifest.chunk_ids]);
    const payload = { collectionId, file: item.file, version: item.version, manifest: item.manifest, chunks, baseServerVersionId: item.version.base_server_version_id ?? item.version.parent_version_id };
    const prep = await this.json(context, '/v1/versions/prepare', { method: 'POST', body: JSON.stringify(payload) });
    if (prep.conflict) { await this.resolveConflict(context, collectionId, item, prep.currentVersionId, result); return }
    for (const id of prep.missing) { const r = await fetch(new URL(`/v1/chunks/${ item.version.chunk_collection_id }/${ id }`, this.baseUrl), { method: 'PUT', headers: this.headers(context, { 'content-type': 'application/octet-stream' }), body: await this.store.get(item.version.chunk_collection_id, id) }); if (!r.ok) throw new Error(`chunk upload failed ${ r.status }`); }
    await this.json(context, '/v1/versions/commit', { method: 'POST', body: JSON.stringify(payload) }); result.pushed++;
  }

  private async remoteVersion(context:ToolExecutionContext, id:string) { return this.json(context, `/v1/versions/${ id }`) }
  private async remoteBytes(context:ToolExecutionContext, bundle:any):Promise<Uint8Array> { const collection = await postgresClient.queryOne<any>('SELECT * FROM collections WHERE id=$1', [bundle.version.chunk_collection_id]); const { dataKey } = await this.keyring.unwrap(collection.id, collection.encrypted_data_key, collection.dedup_key_ciphertext); const parts = []; for (const id of bundle.manifest.chunk_ids) { const r = await fetch(new URL(`/v1/chunks/${ collection.id }/${ id }`, this.baseUrl), { headers: this.headers(context) }); if (!r.ok) throw new Error(`chunk download failed ${ r.status }`); parts.push(await decryptChunk(new Uint8Array(await r.arrayBuffer()), dataKey, id)) } return Buffer.concat(parts) }
  private async resolveConflict(context:ToolExecutionContext, collectionId:string, item:any, currentId:string, result:SyncResult) {
    const ours = await this.files.get(context, item.file.id, item.version.id); const theirs = await this.remoteVersion(context, currentId); let merged:string | null = null;
    if (item.file.mime.startsWith('text/') || item.file.mime === 'application/json') {
      const baseId = item.version.base_server_version_id ?? item.version.parent_version_id;
      if (baseId) { const base = await this.remoteVersion(context, baseId); merged = mergeText(Buffer.from(await this.remoteBytes(context, base)).toString('utf8'), Buffer.from(ours.bytes).toString('utf8'), Buffer.from(await this.remoteBytes(context, theirs)).toString('utf8')) }
    }
    if (merged !== null) { const created = await this.files.put(context, { collectionId, path: item.file.path, bytes: Buffer.from(merged), mime: item.file.mime, message: 'Automatic 3-way sync merge' }); await postgresClient.query('UPDATE file_versions SET base_server_version_id=$2 WHERE id=$1', [created.versionId, currentId]); const next = (await postgresClient.query<any>(`SELECT 0 seq,row_to_json(f.*) file,row_to_json(v.*) version,row_to_json(m.*) manifest FROM files f JOIN file_versions v ON v.id=f.current_version_id JOIN manifests m ON m.hash=v.manifest_hash WHERE f.id=$1`, [item.file.id]))[0]; await this.pushOne(context, collectionId, next, result); result.merged++; return }
    const suffix = `.conflict-${ (context.device_id ?? 'desktop').replace(/[^\w-]/g, '-') }-${ Date.now() }`; const created = await this.files.put(context, { collectionId, path: `${ item.file.path }${ suffix }`, bytes: ours.bytes, mime: item.file.mime, message: `Conflict copy of ${ item.file.path }` }); const next = (await postgresClient.query<any>(`SELECT 0 seq,row_to_json(f.*) file,row_to_json(v.*) version,row_to_json(m.*) manifest FROM files f JOIN file_versions v ON v.id=f.current_version_id JOIN manifests m ON m.hash=v.manifest_hash WHERE v.id=$1`, [created.versionId]))[0]; await this.pushOne(context, collectionId, next, result); result.conflictCopies++;
  }

  private async pullOne(context:ToolExecutionContext, entry:any) {
    for (const id of entry.manifest.chunk_ids) { if (!await this.store.has(entry.version.chunk_collection_id, id)) { const r = await fetch(new URL(`/v1/chunks/${ entry.version.chunk_collection_id }/${ id }`, this.baseUrl), { headers: this.headers(context) }); if (!r.ok) throw new Error(`chunk download failed ${ r.status }`); await this.store.put(entry.version.chunk_collection_id, { id, bytes: new Uint8Array(await r.arrayBuffer()) }) } }
    await postgresClient.transaction(async c => { await c.query('INSERT INTO manifests(hash,chunk_ids,total_size) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [entry.manifest.hash, JSON.stringify(entry.manifest.chunk_ids), entry.manifest.total_size]); await c.query(`INSERT INTO files(id,collection_id,path,created_by_type,created_by_id,mime,size,search_text) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO UPDATE SET path=EXCLUDED.path,mime=EXCLUDED.mime,size=EXCLUDED.size,search_text=EXCLUDED.search_text,updated_at=NOW()`, [entry.file.id, entry.file.collection_id, entry.file.path, entry.file.created_by_type, entry.file.created_by_id, entry.file.mime, entry.file.size, entry.file.search_text]); await c.query(`INSERT INTO file_versions(id,file_id,chunk_collection_id,parent_version_id,manifest_hash,size,deleted,created_by_type,created_by_id,created_at,message,device_id,base_server_version_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT DO NOTHING`, [entry.version.id, entry.version.file_id, entry.version.chunk_collection_id, entry.version.parent_version_id, entry.version.manifest_hash, entry.version.size, entry.version.deleted, entry.version.created_by_type, entry.version.created_by_id, entry.version.created_at, entry.version.message, entry.version.device_id, entry.version.id]); await c.query('UPDATE files SET current_version_id=$2 WHERE id=$1', [entry.file.id, entry.version.id]) });
  }
}
export { mergeText as threeWayMergeText };
