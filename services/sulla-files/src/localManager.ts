import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, readFile, readdir, rename, stat } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';

import { issueCapabilityToken } from './auth.js';
import { chunkId, decryptChunk, encrypt, encryptChunk } from './crypto.js';
import { Store } from './store.js';

import type { Config } from './config.js';
import type pg from 'pg';

const CHUNK_BYTES = 4 * 1024 * 1024;
const DEFAULT_IGNORES = ['.DS_Store', '._*', '*.tmp', '~$*', '.git/', 'node_modules/', '*.sulla-conflict-*', '.sulla-trash/'];

interface RuntimeState {
  state: 'synced' | 'syncing' | 'paused' | 'error'; pendingFiles: number; pendingBytes: number;
  processedBytes: number; totalBytes: number; estimatedSeconds?: number; lastError?: string;
  lastScanAt?: string; lastSyncAt?: string; serverConfigured: boolean;
}
interface WatchedRow { collection_id: string; path: string; file_id: string; content_hash: string; size: string; mtime_ms: string; role?: string }

function mime(path:string):string {
  const extension = extname(path).toLowerCase();
  return ({ '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json', '.yaml': 'application/yaml', '.yml': 'application/yaml', '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska' } as Record<string, string>)[extension] ?? 'application/octet-stream';
}
function matchIgnore(path:string, patterns:string[]):boolean {
  const parts = path.split('/');
  return patterns.some(raw => {
    const pattern = raw.trim().replace(/^\//, '');
    if (!pattern || pattern.startsWith('#')) return false;
    if (pattern.endsWith('/')) return parts.slice(0, -1).includes(pattern.slice(0, -1));
    const expression = new RegExp(`^${ pattern.split('*').map(value => value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&')).join('.*') }$`);
    return expression.test(path) || parts.some(part => expression.test(part));
  });
}
function conflictPath(path:string, device:string):string {
  const extension = extname(path); const stem = extension ? path.slice(0, -extension.length) : path;
  const date = new Date().toISOString().replace(/T.*/, '');
  return `${ stem } (conflicted copy ${ device.replace(/[^\w-]/g, '-') } ${ date })${ extension }`;
}
function collectionIdFor(userId:string):string {
  const value = createHash('sha256').update(`sulla-files:v1:${ userId }`).digest('hex').slice(0, 32).split(''); value[12] = '4'; value[16] = '8';
  return `${ value.slice(0, 8).join('') }-${ value.slice(8, 12).join('') }-${ value.slice(12, 16).join('') }-${ value.slice(16, 20).join('') }-${ value.slice(20).join('') }`;
}

export class LocalFilesManager {
  private readonly store: Store;
  private collectionId?:  string;
  private running?:       Promise<void>;
  private paused:         boolean;
  private lastError?:     string;
  private lastScanAt?:    string;
  private lastSyncAt?:    string;
  private syncTimer?:     NodeJS.Timeout;
  private pendingFiles = 0;
  private pendingBytes = 0;
  private processedBytes = 0;
  private totalBytes = 0;
  private progressStartedAt = 0;
  constructor(private readonly db:pg.Pool, private readonly config:Config) { this.store = new Store(config.chunkRoot); this.paused = config.paused }

  async initialize():Promise<void> {
    if (!this.config.filesRoot) return;
    await mkdir(this.config.filesRoot, { recursive: true, mode: 0o700 });
    await mkdir(this.config.dataRoot, { recursive: true, mode: 0o700 });
    this.collectionId = await this.ensureCollection();
    const saved = await this.db.query('SELECT paused,last_error,last_scan_at,last_sync_at FROM files_runtime_state WHERE id=TRUE');
    if (saved.rows[0]) { this.paused ||= saved.rows[0].paused; this.lastError = saved.rows[0].last_error; this.lastScanAt = saved.rows[0].last_scan_at?.toISOString?.(); this.lastSyncAt = saved.rows[0].last_sync_at?.toISOString?.() }
    await this.rescan();
    this.syncTimer = setInterval(() => this.sync().catch(error => this.fail(error)), 15_000);
    this.syncTimer.unref();
  }

  close():void { if (this.syncTimer) clearInterval(this.syncTimer); }
  status():RuntimeState {
    const elapsed = Math.max(0.001, (Date.now() - this.progressStartedAt) / 1_000); const rate = this.processedBytes / elapsed;
    return { state: this.paused ? 'paused' : this.lastError ? 'error' : this.running ? 'syncing' : 'synced', pendingFiles: this.pendingFiles, pendingBytes: this.pendingBytes, processedBytes: this.processedBytes, totalBytes: this.totalBytes, estimatedSeconds: this.running && rate > 0 ? Math.max(1, Math.ceil(this.pendingBytes / rate)) : undefined, lastError: this.lastError, lastScanAt: this.lastScanAt, lastSyncAt: this.lastSyncAt, serverConfigured: Boolean(this.config.serverUrl) };
  }

  async recent(limit:number, exactPath?:string):Promise<any[]> {
    const result = await this.db.query(`SELECT f.id,f.path,f.mime,f.size,f.updated_at,(f.path ILIKE '%conflicted copy%') AS conflict,m.duration_seconds
      FROM files f JOIN collection_acl a ON a.collection_id=f.collection_id AND a.principal_type='user' AND a.principal_id=$1
      LEFT JOIN recording_metadata m ON m.file_id=f.id
      WHERE f.deleted_at IS NULL AND ($2::text IS NULL OR f.path=$2) ORDER BY f.updated_at DESC LIMIT $3`, [this.config.userId, exactPath ?? null, Math.max(1, Math.min(Number.isFinite(limit) ? limit : 4, 100))]);
    const syncState = this.status().state;
    return result.rows.map(row => ({ id: row.id, path: row.path, mime: row.mime, size: Number(row.size), updatedAt: row.updated_at, conflict: row.conflict, durationSeconds: row.duration_seconds == null ? undefined : Number(row.duration_seconds), syncState: syncState === 'error' ? 'error' : syncState === 'syncing' ? 'syncing' : 'synced' }));
  }

  async setPaused(paused:boolean):Promise<RuntimeState> {
    this.paused = paused; await this.db.query('UPDATE files_runtime_state SET paused=$1,state=$2,updated_at=NOW() WHERE id=TRUE', [paused, paused ? 'paused' : 'synced']);
    if (!paused) await this.sync();
    return this.status();
  }

  async rescan():Promise<void> { return this.serial(async() => { await this.scanFolder(); if (!this.paused) await this.syncNow(); }) }
  async sync():Promise<void> { if (this.paused || !this.config.serverUrl) return; return this.serial(() => this.syncNow()) }
  private async serial(operation:()=>Promise<void>):Promise<void> {
    if (this.running) return this.running;
    this.running = operation().then(() => { this.lastError = undefined }).catch(error => { this.fail(error); throw error }).finally(() => { this.running = undefined });
    return this.running;
  }

  private fail(error:unknown):void { this.lastError = error instanceof Error ? error.message : String(error); this.db.query("UPDATE files_runtime_state SET state='error',last_error=$1,updated_at=NOW() WHERE id=TRUE", [this.lastError]).catch(dbError => console.error('[SullaFiles] failed to record runtime error', dbError)) }

  private async masterKey():Promise<Uint8Array> {
    const path = join(this.config.dataRoot, 'master.key');
    try { const key = await readFile(path); if (key.length !== 32) throw new Error('invalid Files master key'); return key } catch (error:any) {
      if (error?.code !== 'ENOENT') throw error;
      const key = randomBytes(32); const handle = await open(path, 'wx', 0o600); try { await handle.write(key) } finally { await handle.close() } return key;
    }
  }

  private async ensureCollection():Promise<string> {
    const id = collectionIdFor(this.config.userId); const existing = await this.db.query("SELECT id FROM collections WHERE id=$1 AND owner_user_id=$2 AND kind='knowledge'", [id, this.config.userId]);
    if (existing.rows[0]) { if (this.config.orgId) await this.db.query('UPDATE collections SET org_id=$2,updated_at=NOW() WHERE id=$1', [id, this.config.orgId]); return existing.rows[0].id }
    const master = await this.masterKey(); const data = createHmac('sha256', this.config.capabilitySigningKey).update(`sulla:files:data-key:v1:${ id }`).digest(); const dedup = createHmac('sha256', this.config.capabilitySigningKey).update(`sulla:files:dedup-key:v1:${ id }`).digest();
    const encryptedData = await encrypt(data, master, `sulla:files:data-key:v1:${ id }`); const encryptedDedup = await encrypt(dedup, master, `sulla:files:dedup-key:v1:${ id }`);
    await this.db.query(`INSERT INTO collections(id,org_id,owner_user_id,name,kind,home,encrypted_data_key,dedup_key_ciphertext,retention_policy)
      VALUES($1,$2,$3,'Files','knowledge',$4,$5,$6,$7)`, [id, this.config.orgId ?? null, this.config.userId, this.config.serverUrl ? 'synced' : 'desktop-only', encryptedData, encryptedDedup, { trashDays: 90 }]);
    await this.db.query("INSERT INTO collection_acl(collection_id,principal_type,principal_id,role) VALUES($1,'user',$2,'manage')", [id, this.config.userId]); return id;
  }

  private keys(collectionId = this.collectionId!):{ data: Uint8Array; dedup: Uint8Array } {
    return {
      data:  createHmac('sha256', this.config.capabilitySigningKey).update(`sulla:files:data-key:v1:${ collectionId }`).digest(),
      dedup: createHmac('sha256', this.config.capabilitySigningKey).update(`sulla:files:dedup-key:v1:${ collectionId }`).digest(),
    };
  }

  private async ignores():Promise<string[]> { try { return [...DEFAULT_IGNORES, ...(await readFile(join(this.config.filesRoot!, '.sullaignore'), 'utf8')).split(/\r?\n/)] } catch { return DEFAULT_IGNORES } }
  private safe(relativePath:string):string { const absolute = resolve(this.config.filesRoot!, relativePath); if (absolute !== this.config.filesRoot && !absolute.startsWith(`${ this.config.filesRoot }${ sep }`)) throw new Error('path escapes Files folder'); return absolute }
  private async diskFiles(root = this.config.filesRoot!, prefix = ''):Promise<string[]> {
    const ignores = await this.ignores(); const output:string[] = [];
    for (const entry of await readdir(root, { withFileTypes: true })) { const rel = prefix ? `${ prefix }/${ entry.name }` : entry.name; if (matchIgnore(rel, ignores)) continue; if (entry.isDirectory()) output.push(...await this.diskFiles(join(root, entry.name), rel)); else if (entry.isFile() && rel !== '.sullaignore') output.push(rel); }
    return output;
  }

  private async scanFolder():Promise<void> {
    const disk = await this.diskFiles(); const diskSet = new Set(disk); const states = (await this.db.query<WatchedRow>(`SELECT w.*,a.role FROM watched_folder_state w JOIN collection_acl a ON a.collection_id=w.collection_id AND a.principal_type='user' AND a.principal_id=$1`, [this.config.userId])).rows;
    const owned = states.filter(row => row.collection_id === this.collectionId); const missing = new Map(owned.filter(row => !diskSet.has(row.path)).map(row => [row.content_hash, row]));
    const diskInfo = new Map<string, { size:number; mtimeMs:number }>();
    for (const filePath of disk) { const info = await stat(this.safe(filePath)); diskInfo.set(filePath, { size: info.size, mtimeMs: info.mtimeMs }) }
    const changedPaths = disk.filter(filePath => { const current = states.find(row => row.path === filePath); const info = diskInfo.get(filePath)!; return current?.role !== 'view' && (!current || Number(current.size) !== info.size || Number(current.mtime_ms) !== Math.trunc(info.mtimeMs)) });
    this.pendingFiles = changedPaths.length + missing.size; this.totalBytes = changedPaths.reduce((sum, filePath) => sum + diskInfo.get(filePath)!.size, 0); this.pendingBytes = this.totalBytes; this.processedBytes = 0; this.progressStartedAt = Date.now();
    await this.db.query("UPDATE files_runtime_state SET state='syncing',pending_files=$1,updated_at=NOW() WHERE id=TRUE", [this.pendingFiles]);
    let changed = 0;
    for (const path of disk) { const info = diskInfo.get(path)!; const old = states.find(row => row.path === path); if (old && Number(old.size) === info.size && Number(old.mtime_ms) === Math.trunc(info.mtimeMs)) continue; if (old?.role === 'view') continue; const result = await this.ingest(old?.collection_id ?? this.collectionId!, path, info.mtimeMs, old, missing); this.processedBytes += info.size; this.pendingBytes = Math.max(0, this.totalBytes - this.processedBytes); this.pendingFiles = Math.max(0, this.pendingFiles - 1); if (result) changed++; }
    const currentStates = (await this.db.query<WatchedRow>('SELECT * FROM watched_folder_state')).rows;
    for (const row of states) if (!diskSet.has(row.path) && row.role !== 'view' && !currentStates.some(current => current.file_id === row.file_id && current.path !== row.path)) { await this.softDelete(row); changed++ }
    this.pendingFiles = 0; this.pendingBytes = 0; this.processedBytes = this.totalBytes; this.lastScanAt = new Date().toISOString(); await this.db.query("UPDATE files_runtime_state SET state='synced',pending_files=0,last_error=NULL,last_scan_at=NOW(),updated_at=NOW() WHERE id=TRUE");
    if (changed) console.log(`[SullaFiles] recorded ${ changed } watched folder change(s)`);
  }

  private async ingest(collectionId:string, path:string, mtimeMs:number, old:WatchedRow | undefined, missing:Map<string, WatchedRow>):Promise<boolean> {
    const keys = this.keys(collectionId); const whole = createHash('sha256'); const ids:string[] = []; const chunks:any[] = []; let total = 0;
    for await (const part of createReadStream(this.safe(path), { highWaterMark: CHUNK_BYTES })) { const plain = Buffer.from(part); total += plain.length; whole.update(plain); const id = chunkId(plain, keys.dedup); ids.push(id); if (!await this.store.has(collectionId, id)) { const encrypted = await encryptChunk(plain, keys.data, id); await this.store.put(collectionId, id, encrypted); chunks.push({ id, size: plain.length, storedSize: encrypted.length }) } }
    if (total === 0) { const empty = Buffer.alloc(0); const id = chunkId(empty, keys.dedup); ids.push(id); if (!await this.store.has(collectionId, id)) { const encrypted = await encryptChunk(empty, keys.data, id); await this.store.put(collectionId, id, encrypted); chunks.push({ id, size: 0, storedSize: encrypted.length }) } }
    const contentHash = whole.digest('hex'); if (old?.content_hash === contentHash) { await this.db.query('UPDATE watched_folder_state SET size=$3,mtime_ms=$4 WHERE collection_id=$1 AND path=$2', [collectionId, path, total, Math.trunc(mtimeMs)]); return false }
    const renameFrom = !old ? missing.get(contentHash) : undefined; const manifestHash = createHash('sha256').update(JSON.stringify({ ids, size: total })).digest('hex');
    const client = await this.db.connect(); await client.query('BEGIN');
    try {
      await client.query('INSERT INTO manifests(hash,chunk_ids,total_size) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [manifestHash, JSON.stringify(ids), total]);
      for (const chunk of chunks) await client.query('INSERT INTO chunks(collection_id,id,size,stored_size,location,refcount) VALUES($1,$2,$3,$4,$5,0) ON CONFLICT DO NOTHING', [collectionId, chunk.id, chunk.size, chunk.storedSize, `chunks/${ collectionId }/${ chunk.id }`]);
      let fileId = old?.file_id ?? renameFrom?.file_id; let parent:string | null = null;
      if (fileId) { const file = (await client.query('SELECT current_version_id FROM files WHERE id=$1 FOR UPDATE', [fileId])).rows[0]; parent = file.current_version_id; await client.query('UPDATE files SET path=$2,mime=$3,size=$4,deleted_at=NULL,updated_at=NOW() WHERE id=$1', [fileId, path, mime(path), total]) } else { fileId = (await client.query("INSERT INTO files(collection_id,path,created_by_type,created_by_id,mime,size) VALUES($1,$2,'user',$3,$4,$5) RETURNING id", [collectionId, path, this.config.userId, mime(path), total])).rows[0].id }
      const version = (await client.query(`INSERT INTO file_versions(file_id,chunk_collection_id,parent_version_id,manifest_hash,size,created_by_type,created_by_id,message,device_id,base_server_version_id)
        VALUES($1,$2,$3,$4,$5,'user',$6,$7,$8,$3) RETURNING id`, [fileId, collectionId, parent, manifestHash, total, this.config.userId, renameFrom ? `Renamed ${ renameFrom.path } to ${ path }` : 'Watched folder change', this.config.deviceId])).rows[0];
      await client.query('UPDATE files SET current_version_id=$2 WHERE id=$1', [fileId, version.id]); await client.query('UPDATE chunks SET refcount=refcount+1 WHERE collection_id=$1 AND id=ANY($2::text[])', [collectionId, ids]);
      await client.query('INSERT INTO journal(collection_id,file_id,version_id,op) VALUES($1,$2,$3,$4)', [collectionId, fileId, version.id, renameFrom ? 'rename' : 'put']);
      if (renameFrom) await client.query('DELETE FROM watched_folder_state WHERE collection_id=$1 AND path=$2', [collectionId, renameFrom.path]);
      await client.query(`INSERT INTO watched_folder_state(collection_id,path,file_id,content_hash,size,mtime_ms) VALUES($1,$2,$3,$4,$5,$6)
        ON CONFLICT(collection_id,path) DO UPDATE SET file_id=EXCLUDED.file_id,content_hash=EXCLUDED.content_hash,size=EXCLUDED.size,mtime_ms=EXCLUDED.mtime_ms`, [collectionId, path, fileId, contentHash, total, Math.trunc(mtimeMs)]);
      await client.query('COMMIT'); if (renameFrom) missing.delete(contentHash);
      if (path.startsWith('Recordings/') && mime(path).startsWith('video/') && !/-(?:camera|mic|system-audio)\.[^/]+$/i.test(path)) {
        await this.db.query(`INSERT INTO recording_enrichment_jobs(file_id,version_id,status) VALUES($1,$2,'pending') ON CONFLICT(version_id) DO NOTHING`, [fileId, version.id]).catch(error => console.warn('[SullaFiles] recording enrichment hook unavailable:', error));
      }
      return true;
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  }

  private async softDelete(row:WatchedRow):Promise<void> {
    const client = await this.db.connect(); await client.query('BEGIN');
    try {
      const file = (await client.query('SELECT current_version_id FROM files WHERE id=$1 FOR UPDATE', [row.file_id])).rows[0]; if (!file) { await client.query('ROLLBACK'); return }
      const version = (await client.query(`INSERT INTO file_versions(file_id,chunk_collection_id,parent_version_id,manifest_hash,size,deleted,created_by_type,created_by_id,message,device_id,base_server_version_id)
        VALUES($1,$2,$3,NULL,0,TRUE,'user',$4,'Moved to Trash',$5,$3) RETURNING id`, [row.file_id, row.collection_id, file.current_version_id, this.config.userId, this.config.deviceId])).rows[0];
      await client.query('UPDATE files SET current_version_id=$2,deleted_at=NOW(),updated_at=NOW() WHERE id=$1', [row.file_id, version.id]); await client.query("INSERT INTO journal(collection_id,file_id,version_id,op) VALUES($1,$2,$3,'delete')", [row.collection_id, row.file_id, version.id]); await client.query('DELETE FROM watched_folder_state WHERE collection_id=$1 AND path=$2', [row.collection_id, row.path]); await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  }

  private headers(extra:Record<string, string> = {}):Record<string, string> { return { authorization: `Bearer ${ issueCapabilityToken({ sub: this.config.userId, device_id: this.config.deviceId, scopes: ['files/*'] }, this.config.capabilitySigningKey) }`, ...extra } }
  private async remote(path:string, init:RequestInit = {}):Promise<any> { const response = await fetch(new URL(path, this.config.serverUrl), { ...init, headers: { ...this.headers({ 'content-type': 'application/json' }), ...(init.headers as any) } }); if (!response.ok) { const body:any = await response.json().catch(() => ({})); throw Object.assign(new Error(body.error ?? `sync HTTP ${ response.status }`), { status: response.status, body }) } return response.status === 204 ? undefined : response.json() }
  private async syncNow():Promise<void> {
    if (!this.config.serverUrl) return; await this.db.query("UPDATE files_runtime_state SET state='syncing',last_error=NULL,updated_at=NOW() WHERE id=TRUE");
    const collection = (await this.db.query('SELECT * FROM collections WHERE id=$1', [this.collectionId])).rows[0]; await this.remote('/v1/collections', { method: 'POST', body: JSON.stringify({ collection }) });
    const remoteCollections:any[] = await this.remote('/v1/collections');
    for (const remote of remoteCollections) {
      if (remote.id !== this.collectionId) {
        await this.db.query(`INSERT INTO collections(id,org_id,owner_user_id,name,kind,home,encryption,encrypted_data_key,dedup_key_ciphertext,retention_policy)
          VALUES($1,$2,$3,$4,$5,'synced',$6,$7,$8,$9)
          ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,org_id=EXCLUDED.org_id,updated_at=NOW()`, [remote.id, remote.org_id, remote.owner_user_id, remote.name, remote.kind, remote.encryption, remote.encrypted_data_key, remote.dedup_key_ciphertext, remote.retention_policy ?? {}]);
        const role = remote.access_role ?? (remote.shared_folders?.some((folder:any) => folder.role === 'edit') ? 'edit' : 'view');
        await this.db.query(`INSERT INTO collection_acl(collection_id,principal_type,principal_id,role) VALUES($1,'user',$2,$3)
          ON CONFLICT(collection_id,principal_type,principal_id) DO UPDATE SET role=EXCLUDED.role`, [remote.id, this.config.userId, role]);
      }
      await this.syncCollection(remote.id, remote.id === this.collectionId || remote.access_role === 'edit' || remote.access_role === 'manage' || remote.shared_folders?.some((folder:any) => folder.role === 'edit'));
    }
    this.pendingFiles = 0; this.lastSyncAt = new Date().toISOString(); await this.db.query("UPDATE files_runtime_state SET state='synced',pending_files=0,last_error=NULL,last_sync_at=NOW(),updated_at=NOW() WHERE id=TRUE");
  }

  private async syncCollection(collectionId:string, canPush:boolean):Promise<void> {
    await this.db.query('INSERT INTO file_sync_cursors(collection_id,device_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [collectionId, this.config.deviceId]);
    let cursor = (await this.db.query('SELECT * FROM file_sync_cursors WHERE collection_id=$1 AND device_id=$2', [collectionId, this.config.deviceId])).rows[0];
    if (canPush) {
      const pending = (await this.db.query(`SELECT j.seq,row_to_json(f.*) file,row_to_json(v.*) version,row_to_json(m.*) manifest FROM journal j JOIN files f ON f.id=j.file_id JOIN file_versions v ON v.id=j.version_id LEFT JOIN manifests m ON m.hash=v.manifest_hash WHERE j.collection_id=$1 AND j.seq>$2 AND v.device_id=$3 ORDER BY j.seq`, [collectionId, cursor.last_push_seq, this.config.deviceId])).rows;
      this.pendingFiles += pending.length;
      for (const item of pending) { await this.push(item, collectionId); await this.db.query('UPDATE file_sync_cursors SET last_push_seq=$3 WHERE collection_id=$1 AND device_id=$2', [collectionId, this.config.deviceId, item.seq]) }
    }
    cursor = (await this.db.query('SELECT * FROM file_sync_cursors WHERE collection_id=$1 AND device_id=$2', [collectionId, this.config.deviceId])).rows[0];
    const entries = await this.remote(`/v1/collections/${ collectionId }/journal?after=${ cursor.last_seq }`);
    for (const entry of entries) { await this.pull(entry); await this.db.query('UPDATE file_sync_cursors SET last_seq=$3 WHERE collection_id=$1 AND device_id=$2', [collectionId, this.config.deviceId, entry.seq]) }
  }

  private async push(item:any, collectionId = item.file.collection_id):Promise<void> {
    const chunks = item.manifest ? (await this.db.query('SELECT * FROM chunks WHERE collection_id=$1 AND id=ANY($2::text[])', [item.version.chunk_collection_id, item.manifest.chunk_ids])).rows : [];
    const payload = { collectionId, file: item.file, version: item.version, manifest: item.manifest, chunks, baseServerVersionId: item.version.base_server_version_id ?? item.version.parent_version_id };
    const prep = await this.remote('/v1/versions/prepare', { method: 'POST', body: JSON.stringify(payload) });
    if (prep.conflict) { await this.keepConflict(item, prep.currentVersionId); return }
    for (const id of prep.missing ?? []) { const response = await fetch(new URL(`/v1/chunks/${ item.version.chunk_collection_id }/${ id }`, this.config.serverUrl), { method: 'PUT', headers: this.headers({ 'content-type': 'application/octet-stream' }), body: await this.store.get(item.version.chunk_collection_id, id) }); if (!response.ok) throw new Error(`chunk upload failed ${ response.status }`); }
    await this.remote('/v1/versions/commit', { method: 'POST', body: JSON.stringify(payload) }); await this.db.query('UPDATE file_versions SET base_server_version_id=id WHERE id=$1', [item.version.id]);
  }

  private async keepConflict(item:any, remoteVersionId:string):Promise<void> {
    const collectionId = item.file.collection_id;
    const nextPath = conflictPath(item.file.path, this.config.deviceId); const source = this.safe(item.file.path); const target = this.safe(nextPath); await mkdir(dirname(target), { recursive: true }); await rename(source, target);
    const fileId = randomUUID(); const versionId = randomUUID(); const info = await stat(target); const hash = createHash('sha256'); for await (const part of createReadStream(target)) hash.update(part);
    const client = await this.db.connect(); await client.query('BEGIN');
    try {
      await client.query(`INSERT INTO files(id,collection_id,path,created_by_type,created_by_id,mime,size) VALUES($1,$2,$3,$4,$5,$6,$7)`, [fileId, collectionId, nextPath, item.file.created_by_type, item.file.created_by_id, item.file.mime, item.file.size]);
      await client.query(`INSERT INTO file_versions(id,file_id,chunk_collection_id,parent_version_id,manifest_hash,size,deleted,created_by_type,created_by_id,message,device_id,base_server_version_id)
        VALUES($1,$2,$3,NULL,$4,$5,FALSE,$6,$7,$8,$9,NULL)`, [versionId, fileId, item.version.chunk_collection_id, item.version.manifest_hash, item.version.size, item.version.created_by_type, item.version.created_by_id, `Conflict copy of ${ item.file.path }`, this.config.deviceId]);
      await client.query('UPDATE files SET current_version_id=$2 WHERE id=$1', [fileId, versionId]);
      await client.query('UPDATE chunks SET refcount=refcount+1 WHERE collection_id=$1 AND id=ANY($2::text[])', [item.version.chunk_collection_id, item.manifest.chunk_ids]);
      await client.query("INSERT INTO journal(collection_id,file_id,version_id,op) VALUES($1,$2,$3,'conflict')", [collectionId, fileId, versionId]);
      await client.query('DELETE FROM watched_folder_state WHERE collection_id=$1 AND path=$2', [collectionId, item.file.path]);
      await client.query('INSERT INTO watched_folder_state(collection_id,path,file_id,content_hash,size,mtime_ms) VALUES($1,$2,$3,$4,$5,$6)', [collectionId, nextPath, fileId, hash.digest('hex'), info.size, Math.trunc(info.mtimeMs)]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
    const conflict = { ...item, file: { ...item.file, id: fileId, path: nextPath }, version: { ...item.version, id: versionId, file_id: fileId, parent_version_id: null, base_server_version_id: null, message: `Conflict copy of ${ item.file.path }` } };
    await this.push(conflict); const bundle = await this.remote(`/v1/versions/${ remoteVersionId }`); await this.pull({ ...bundle, seq: 0 });
  }

  private async materialize(bundle:any):Promise<void> {
    const keys = this.keys(bundle.version.chunk_collection_id); const target = this.safe(bundle.file.path); await mkdir(dirname(target), { recursive: true }); const temp = `${ target }.sulla-conflict-${ randomUUID() }`; const output = createWriteStream(temp, { mode: 0o600 });
    let lastId:string | undefined; let lastPlain:Buffer | undefined;
    try { for (const id of bundle.manifest.chunk_ids) { let plain:Buffer; if (id === lastId && lastPlain) plain = lastPlain; else { let encrypted:Uint8Array; if (await this.store.has(bundle.version.chunk_collection_id, id)) encrypted = await this.store.get(bundle.version.chunk_collection_id, id); else { const response = await fetch(new URL(`/v1/chunks/${ bundle.version.chunk_collection_id }/${ id }`, this.config.serverUrl), { headers: this.headers() }); if (!response.ok) throw new Error(`chunk download failed ${ response.status }`); encrypted = new Uint8Array(await response.arrayBuffer()); await this.store.put(bundle.version.chunk_collection_id, id, encrypted) } plain = await decryptChunk(encrypted, keys.data, id); lastId = id; lastPlain = plain } if (!output.write(plain)) await new Promise<void>(resolve => output.once('drain', () => resolve())); } output.end(); await new Promise<void>((resolve, reject) => { output.once('finish', resolve); output.once('error', reject) }); await rename(temp, target) } catch (error) { output.destroy(); throw error }
  }

  private async pull(entry:any):Promise<void> {
    if (entry.version.device_id === this.config.deviceId) return;
    const collectionId = entry.file.collection_id;
    if (entry.version.deleted) {
      const existing = (await this.db.query('SELECT path FROM files WHERE id=$1', [entry.file.id])).rows[0];
      if (existing) {
        const source = this.safe(existing.path); const trash = this.safe(`.sulla-trash/${ entry.file.id }/${ Date.now() }-${ basename(existing.path) }`);
        try { await mkdir(dirname(trash), { recursive: true }); await rename(source, trash) } catch (error:any) { if (error?.code !== 'ENOENT') throw error; }
        const client = await this.db.connect(); await client.query('BEGIN');
        try {
          await client.query(`INSERT INTO file_versions(id,file_id,chunk_collection_id,parent_version_id,manifest_hash,size,deleted,created_by_type,created_by_id,created_at,message,device_id,base_server_version_id)
            VALUES($1,$2,$3,$4,NULL,0,TRUE,$5,$6,$7,$8,$9,$1) ON CONFLICT DO NOTHING`, [entry.version.id, entry.file.id, entry.version.chunk_collection_id, entry.version.parent_version_id, entry.version.created_by_type, entry.version.created_by_id, entry.version.created_at, entry.version.message, entry.version.device_id]);
          await client.query('UPDATE files SET current_version_id=$2,deleted_at=NOW(),updated_at=NOW() WHERE id=$1', [entry.file.id, entry.version.id]);
          await client.query('DELETE FROM watched_folder_state WHERE collection_id=$1 AND file_id=$2', [collectionId, entry.file.id]); await client.query('COMMIT');
        } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
      }
      return;
    }
    const prior = (await this.db.query('SELECT path FROM files WHERE id=$1', [entry.file.id])).rows[0];
    if (prior?.path && prior.path !== entry.file.path) {
      try { await mkdir(dirname(this.safe(entry.file.path)), { recursive: true }); await rename(this.safe(prior.path), this.safe(entry.file.path)) } catch (error:any) { if (error?.code !== 'ENOENT') throw error; }
    }
    await this.materialize(entry);
    const info = await stat(this.safe(entry.file.path)); const hash = createHash('sha256');
    for await (const part of createReadStream(this.safe(entry.file.path))) hash.update(part);
    const client = await this.db.connect(); await client.query('BEGIN');
    try {
      await client.query('INSERT INTO manifests(hash,chunk_ids,total_size) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [entry.manifest.hash, JSON.stringify(entry.manifest.chunk_ids), entry.manifest.total_size]);
      await client.query(`INSERT INTO files(id,collection_id,path,created_by_type,created_by_id,mime,size) VALUES($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT(id) DO UPDATE SET path=EXCLUDED.path,mime=EXCLUDED.mime,size=EXCLUDED.size,deleted_at=NULL,updated_at=NOW()`, [entry.file.id, collectionId, entry.file.path, entry.file.created_by_type, entry.file.created_by_id, entry.file.mime, entry.file.size]);
      await client.query(`INSERT INTO file_versions(id,file_id,chunk_collection_id,parent_version_id,manifest_hash,size,deleted,created_by_type,created_by_id,created_at,message,device_id,base_server_version_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$1) ON CONFLICT DO NOTHING`, [entry.version.id, entry.file.id, entry.version.chunk_collection_id, entry.version.parent_version_id, entry.version.manifest_hash, entry.version.size, entry.version.deleted, entry.version.created_by_type, entry.version.created_by_id, entry.version.created_at, entry.version.message, entry.version.device_id]);
      await client.query('UPDATE files SET current_version_id=$2 WHERE id=$1', [entry.file.id, entry.version.id]);
      await client.query(`INSERT INTO watched_folder_state(collection_id,path,file_id,content_hash,size,mtime_ms) VALUES($1,$2,$3,$4,$5,$6)
        ON CONFLICT(collection_id,path) DO UPDATE SET file_id=EXCLUDED.file_id,content_hash=EXCLUDED.content_hash,size=EXCLUDED.size,mtime_ms=EXCLUDED.mtime_ms`, [collectionId, entry.file.path, entry.file.id, hash.digest('hex'), info.size, Math.trunc(info.mtimeMs)]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  }
}
