import { isLegacyInternalPath } from './legacyPreflight.js';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, realpath, rename, stat } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';

import { issueCapabilityToken } from './auth.js';
import { chunkId, decryptChunk, encryptChunk } from './crypto.js';
import { copyLockedFile } from './fileOperations.js';
import { isProtectedPath } from './protectedFiles.js';
import { FilesMutationCoordinator } from './safeFilesystem.js';
import { NativeOperationJournal } from './nativeOperationJournal.js';
import { streamFileContent } from './fileStream.js';
import type { DatabaseOperationAccess } from './databaseOperations.js';
import { Store } from './store.js';

import type { FilesIdentity } from './auth.js';
import type { Config, FileRootConfig } from './config.js';
import type { IndexingQueue } from './indexing.js';
import type { OriginalRevealTarget } from './originalReveal.js';
import type { EvictionReceipt, FileFingerprint, PinnedRegularFile, PublicationReceipt } from './safeFilesystem.js';
import type pg from 'pg';

const CHUNK_BYTES = 4 * 1024 * 1024;
const DEFAULT_IGNORES = ['.DS_Store', '._*', '*.tmp', '~$*', '.git/', 'node_modules/', '*.sulla-conflict-*', '.sulla-trash/', '.sulla-operation-recovery/', 'master.key'];

interface RuntimeState {
  state: 'synced' | 'syncing' | 'paused' | 'error'; pendingFiles: number; pendingBytes: number;
  processedBytes: number; totalBytes: number; estimatedSeconds?: number; lastError?: string;
  lastScanAt?: string; lastSyncAt?: string; serverConfigured: boolean;
  legacyImport?: Config['legacyPreflight'];
}
interface WatchedRow { collection_id: string; root_id: string; path: string; file_id: string; content_hash: string; size: string; mtime_ms: string; role?: string }
export interface FileRootStatus {
  id: string; name: string; collectionId: string; syncMode: 'local' | 'server'; paused: boolean;
  exclusions: string[]; state: 'idle' | 'scanning' | 'syncing' | 'paused' | 'offline' | 'error' | 'detached';
  pendingFiles: number; serverConfigured: boolean; lastError?: string; lastScanAt?: string; lastSyncAt?: string;
}
interface PathOperationPlanEntry {
  rootId: string;
  fileId: string;
  sourcePath: string;
  targetPath: string;
  stagePath: string;
  contentHash: string;
  kind: 'move' | 'copy';
}
interface DiskScan { paths: string[]; complete: boolean; errors: string[] }
interface PathOperationRow {
  operation_id: string;
  state: 'planned' | 'publishing' | 'db-committed';
  plan: PathOperationPlanEntry[] | RemotePurgePlan;
  receipts: PathOperationReceipt[];
}
interface RemotePurgePlan {
  kind:'remote-purge-v1'; rootId:string; collectionId:string; fileId:string;
  sourcePath:string; stagePath:string; versionId:string; revision:string;
  contentHash:string; fingerprint:{dev:string;ino:string;size:number;mtimeMs:number};
  lifecycleGeneration:number;
}
interface PathOperationReceipt {
  fileId: string;
  stagePath: string;
  targetPath: string;
  published: true;
  fingerprint?: { dev: string; ino: string; size: number; mtimeMs: number };
}

function mime(path:string):string {
  const extension = extname(path).toLowerCase();
  return ({
    '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.tsv': 'text/tab-separated-values',
    '.js': 'text/javascript', '.jsx': 'text/javascript', '.mjs': 'text/javascript', '.cjs': 'text/javascript', '.ts': 'text/typescript', '.tsx': 'text/typescript',
    '.css': 'text/css', '.html': 'text/html', '.htm': 'text/html', '.vue': 'text/plain', '.svelte': 'text/plain', '.py': 'text/x-python', '.rb': 'text/x-ruby', '.go': 'text/x-go', '.rs': 'text/x-rust',
    '.java': 'text/x-java-source', '.c': 'text/x-c', '.h': 'text/x-c', '.cc': 'text/x-c++', '.cpp': 'text/x-c++', '.hpp': 'text/x-c++', '.swift': 'text/x-swift', '.kt': 'text/x-kotlin',
    '.sh': 'text/x-shellscript', '.sql': 'text/x-sql', '.toml': 'text/x-toml', '.json': 'application/json', '.yaml': 'application/yaml', '.yml': 'application/yaml', '.xml': 'application/xml',
    '.pdf': 'application/pdf', '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.opus': 'audio/opus', '.aif': 'audio/aiff', '.aiff': 'audio/aiff', '.weba': 'audio/webm',
    '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
  } as Record<string, string>)[extension] ?? 'application/octet-stream';
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
function isSensitiveTrackedPath(relativePath:string):boolean {
  return relativePath.replaceAll('\\', '/').split('/').some(part => {
    const value = part.toLowerCase();
    return value.includes('wallet') || value === 'vault' || value === 'vaults';
  });
}
function conflictPath(path:string, device:string):string {
  const extension = extname(path); const stem = extension ? path.slice(0, -extension.length) : path;
  const date = new Date().toISOString().replace(/T.*/, '');
  return `${ stem } (conflicted copy ${ device.replace(/[^\w-]/g, '-') } ${ date })${ extension }`;
}
function collectionIdFor(userId:string, rootId = 'default'):string {
  const identity = rootId === 'default' ? `sulla-files:v1:${ userId }` : `sulla-files:root:v1:${ userId }:${ rootId }`;
  const value = createHash('sha256').update(identity).digest('hex').slice(0, 32).split(''); value[12] = '4'; value[16] = '8';
  return `${ value.slice(0, 8).join('') }-${ value.slice(8, 12).join('') }-${ value.slice(12, 16).join('') }-${ value.slice(16, 20).join('') }-${ value.slice(20).join('') }`;
}

function serializeFingerprint(value:PublicationReceipt['fingerprint']):NonNullable<PathOperationReceipt['fingerprint']> {
  return { dev: value.dev.toString(), ino: value.ino.toString(), size: value.size, mtimeMs: value.mtimeMs };
}

function deserializeFingerprint(value:NonNullable<PathOperationReceipt['fingerprint']>):PublicationReceipt['fingerprint'] {
  if (!/^\d+$/.test(value.dev) || !/^\d+$/.test(value.ino) || !Number.isSafeInteger(value.size) || !Number.isSafeInteger(value.mtimeMs)) {
    throw new Error('Path operation publication receipt has an invalid fingerprint');
  }
  return { dev: BigInt(value.dev), ino: BigInt(value.ino), size: value.size, mtimeMs: value.mtimeMs };
}

function sameIdentity(left:PublicationReceipt['fingerprint'], right:PublicationReceipt['fingerprint']):boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFingerprint(left:PublicationReceipt['fingerprint'], right:PublicationReceipt['fingerprint']):boolean {
  return sameIdentity(left, right) && left.size === right.size && left.mtimeMs === right.mtimeMs;
}

/** Resolve symlinks before allowing plaintext watched files beside private storage. */
export async function assertSeparateStorageRoots(filesRoot:string, dataRoot:string, chunkRoot:string):Promise<void> {
  const [files, data, chunks] = await Promise.all([realpath(filesRoot), realpath(dataRoot), realpath(chunkRoot)]);
  const contains = (parent:string, child:string) => child === parent || child.startsWith(parent.endsWith(sep) ? parent : `${ parent }${ sep }`);
  for (const privateRoot of [data, chunks]) {
    if (contains(files, privateRoot) || contains(privateRoot, files)) throw new Error('Files watched folder must not overlap private data or chunk storage');
  }
}

export class LocalFilesManager {
  private readonly store: Store;
  private collectionId?:  string;
  private stopped = false;
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
  readonly mutations: FilesMutationCoordinator;
  private readonly rootCollections = new Map<string, string>();
  private readonly rootMutations = new Map<string, FilesMutationCoordinator>();
  private readonly roots:FileRootConfig[];
  private nativeJournalInstance?:NativeOperationJournal;
  private get nativeJournal():NativeOperationJournal { return this.nativeJournalInstance ??= new NativeOperationJournal(this.db,async(collectionId) => {
    const row=(await this.db.query('SELECT * FROM file_roots WHERE collection_id=$1',[collectionId])).rows[0];
    if (!row) {
      if ((await this.db.query('SELECT 1 FROM watched_folder_state WHERE collection_id=$1 LIMIT 1',[collectionId])).rowCount) throw new Error('Tracked root is missing');
      return null;
    }
    const root=this.roots.find(root=>root.id===row.id);
    if (!root || !row.enabled || ['detached','offline'].includes(row.state) || root.path!==row.mount_path || this.rootCollections.get(root.id)!==collectionId) throw new Error('Tracked root is unavailable');
    return { id:root.id,collectionId,mutations:this.rootMutations.get(root.id)! };
  },(fileId,versionId,hash)=>this.verifyNativeVersion(fileId,versionId,hash),async(fileId,versionId)=>{
    const content=await streamFileContent(this.db,this.config,this.store,fileId,versionId,undefined,new AbortController().signal);
    if (!content) throw Object.assign(new Error('Original version content is unavailable'),{status:409,code:'original-changed'});
    return content.body;
  }) }

  private async verifyNativeVersion(fileId:string,versionId:string,hash:string):Promise<void> {
    const content=await streamFileContent(this.db,this.config,this.store,fileId,versionId,undefined,new AbortController().signal);
    if (!content) throw Object.assign(new Error('Original version content is unavailable'),{status:409,code:'original-changed'});
    const digest=createHash('sha256');
    for await (const chunk of content.body) digest.update(chunk);
    if (digest.digest('hex')!==hash) throw Object.assign(new Error('Original differs from the current Files version'),{status:409,code:'original-changed'});
  }

  operationCustody():NonNullable<DatabaseOperationAccess['custody']> {
    const locked=<T>(operation:()=>Promise<T>):Promise<T> => {
      const roots=[...this.rootMutations.entries()].sort(([a],[b])=>a.localeCompare(b));
      const acquire=(index:number):Promise<T>=>index===roots.length?operation():roots[index][1].runExclusive([],()=>acquire(index+1));
      return acquire(0);
    };
    return {
      run:<T>(operation:()=>Promise<T>) => this.serial(()=>locked(async() => {
        await this.recoverPathOperations();
        try {
          const result=await operation();
          await this.recoverPathOperations();
          return result;
        } catch (error) {
          try { await this.recoverPathOperations() } catch {
            throw Object.assign(new Error('Native operation requires preserved-artifact reconciliation'),{ status:409,code:'recovery-required' });
          }
          throw error;
        }
      })),
      publish:(client,receipt,undo) => this.nativeJournal.publish(client,receipt,undo),
      occupied:(collectionId,path)=>this.nativeJournal.occupied(collectionId,path),
      folders:(collectionId,path,files)=>this.nativeJournal.folders(collectionId,path,files),
      folderSnapshot:(collectionId,path,files)=>this.nativeJournal.folderSnapshot(collectionId,path,files),
      available:()=>FilesMutationCoordinator.atomicRenameAvailable(),
    };
  }

  async disposeTrashReceipt(receiptId:string):Promise<{state:'none'|'complete'|'recovery-required';error?:string}> {
    return this.serial(async()=>{
      await this.recoverPathOperations();
      return this.nativeJournal.dispose(receiptId);
    });
  }

  async expireTrashReceipts(now=new Date()):Promise<{invalidated:number;disposed:number;preserved:number}> {
    return this.serial(async()=>{
      const rows=(await this.db.query(`SELECT id FROM files_database_operation_receipts
        WHERE action='trash' AND state IN('completed','undone')
          AND folder_plan#>>'{lifecycle,expiresAt}' IS NOT NULL
          AND (folder_plan#>>'{lifecycle,expiresAt}')::timestamptz<=$1
          AND folder_plan#>>'{lifecycle,disposal,undoInvalidatedAt}' IS NULL ORDER BY created_at`,[now])).rows;
      let invalidated=0,disposed=0,preserved=0;
      for (const candidate of rows) {
        const client=await this.db.connect(); let receipt:any; let operation:any;
        try {
          await client.query('BEGIN');
          receipt=(await client.query('SELECT * FROM files_database_operation_receipts WHERE id=$1 FOR UPDATE',[candidate.id])).rows[0];
          if (!receipt || receipt.folder_plan?.lifecycle?.disposal?.undoInvalidatedAt) { await client.query('COMMIT'); continue }
          operation=(await client.query('SELECT * FROM files_path_operations WHERE operation_id=$1 FOR UPDATE',[receipt.id])).rows[0];
          if (operation && (!['completed','undone','rolled-back'].includes(operation.state)||operation.last_error)) { await client.query('ROLLBACK'); preserved++; continue }
          const folderPlan=receipt.folder_plan?.source?receipt.folder_plan:null;
          const fileIds=[...new Set<string>([receipt.file_id,...(folderPlan?.children??[]).flatMap((item:any)=>[item.before?.fileId,item.after?.fileId])].filter(Boolean))];
          if (fileIds.length && (await client.query('SELECT 1 FROM files f WHERE f.id=ANY($1::uuid[]) AND files_retention_active(f) LIMIT 1',[fileIds])).rowCount) { await client.query('ROLLBACK'); preserved++; continue }
          const invalidation={undoInvalidatedAt:now.toISOString(),invalidatedBy:'configured-retention',reason:'configured-trash-retention-expired'};
          receipt.folder_plan.lifecycle={...(receipt.folder_plan.lifecycle??{}),disposal:invalidation};
          await client.query('UPDATE files_database_operation_receipts SET folder_plan=$2 WHERE id=$1',[receipt.id,receipt.folder_plan]);
          if (operation) { operation.plan.disposal=invalidation; await client.query('UPDATE files_path_operations SET plan=$2,updated_at=NOW() WHERE operation_id=$1',[receipt.id,operation.plan]) }
          await client.query('COMMIT'); invalidated++;
        } catch(error) { await client.query('ROLLBACK'); throw error }
        finally { client.release() }
        if (operation) { const result=await this.nativeJournal.dispose(receipt.id); if (result.state==='complete') disposed++; else preserved++ }
      }
      return {invalidated,disposed,preserved};
    });
  }

  async originalRevealTarget(file:any):Promise<OriginalRevealTarget|null> {
    return this.serial(async() => {
      const row = (await this.db.query(`SELECT w.*,r.enabled,r.state,r.mount_path FROM watched_folder_state w
        JOIN file_roots r ON r.id=w.root_id AND r.collection_id=w.collection_id
        WHERE w.file_id=$1 AND w.collection_id=$2 AND w.path=$3`, [file.id,file.collection_id,file.path])).rows[0];
      if (!row) return null;
      const root = this.roots.find(root => root.id === row.root_id);
      if (!root || !row.enabled || ['detached','offline','error'].includes(row.state) || root.path !== row.mount_path ||
        this.rootCollections.get(root.id) !== file.collection_id) throw Object.assign(new Error('Original root is unavailable'), { status:409,code:'original-unavailable' });
      if (isProtectedPath(file.path) || file.path.split('/').some((part:string) => part === '.sulla-trash' || part === '.sulla-operation-recovery')) throw Object.assign(new Error('Protected original path'), { status:403,code:'original-forbidden' });
      const mutations = this.rootMutations.get(root.id)!;
      return mutations.runExclusive([file.path],async() => {
        await this.verifyNativeVersion(file.id,file.current_version_id,row.content_hash);
        const pinned = await mutations.pinVerified(file.path,pinned => this.verifyOperationPinned(pinned,row.content_hash));
        try {
          if (pinned.fingerprint.size !== Number(row.size) || pinned.fingerprint.mtimeMs !== Number(row.mtime_ms)) throw Object.assign(new Error('Original changed since indexing'), { status:409,code:'original-changed' });
          const fresh=(await this.db.query(`SELECT 1 FROM files f JOIN watched_folder_state w ON w.file_id=f.id AND w.collection_id=f.collection_id AND w.path=f.path
            JOIN file_roots r ON r.id=w.root_id AND r.collection_id=w.collection_id
            WHERE f.id=$1 AND f.current_version_id=$2 AND f.operation_revision=$3 AND f.path=$4 AND f.deleted_at IS NULL
              AND w.content_hash=$5 AND w.size=$6 AND w.mtime_ms=$7 AND r.id=$8 AND r.mount_path=$9 AND r.enabled=TRUE
              AND r.state NOT IN('detached','offline','error') AND NOT EXISTS(SELECT 1 FROM files_protected_files p WHERE p.file_id=f.id)`,
          [file.id,file.current_version_id,file.operation_revision,file.path,row.content_hash,row.size,row.mtime_ms,root.id,root.path])).rowCount;
          if (!fresh) throw Object.assign(new Error('Original changed during verification'),{status:409,code:'original-changed'});
          return { rootId:root.id,collectionId:file.collection_id,relativePath:file.path,fileId:file.id,
            versionId:file.current_version_id,revision:String(file.operation_revision),hash:row.content_hash,
            size:pinned.fingerprint.size,mtimeMs:pinned.fingerprint.mtimeMs };
        } finally { await pinned.close() }
      });
    });
  }

  constructor(private readonly db:pg.Pool, private readonly config:Config, private readonly indexer?:IndexingQueue, mutations?:FilesMutationCoordinator) {
    this.store = new Store(config.chunkRoot); this.paused = config.paused;
    this.roots = (config.fileRoots ?? (config.filesRoot ? [{ id: 'default', name: 'Sulla Files', path: config.filesRoot, syncMode: config.serverUrl ? 'server' : 'local', paused: config.paused, exclusions: [], primary: true }] : []))
      .filter(root => !isSensitiveTrackedPath(root.path));
    this.mutations = mutations ?? new FilesMutationCoordinator(config.filesRoot ?? config.dataRoot);
    for (const root of this.roots) this.rootMutations.set(root.id, root.primary ? this.mutations : new FilesMutationCoordinator(root.path));
  }

  async initialize(beforeScan?:()=>Promise<void>):Promise<void> {
    this.stopped = false;
    if (!this.config.filesRoot) return;
    for (const root of this.roots) await mkdir(root.path, { recursive: true, mode: 0o700 });
    await mkdir(this.config.dataRoot, { recursive: true, mode: 0o700 });
    await mkdir(this.config.chunkRoot, { recursive: true, mode: 0o700 });
    for (const root of this.roots) await assertSeparateStorageRoots(root.path, this.config.dataRoot, this.config.chunkRoot);
    for (const root of this.roots) {
      const collectionId = await this.ensureCollection(root);
      this.rootCollections.set(root.id, collectionId);
      if (root.primary) this.collectionId = collectionId;
      await this.db.query(`INSERT INTO file_roots(id,collection_id,display_name,mount_path,sync_mode,paused,exclusions,enabled,state)
        VALUES($1,$2,$3,$4,$5,$6,$7,TRUE,$8)
        ON CONFLICT(id) DO UPDATE SET collection_id=EXCLUDED.collection_id,display_name=EXCLUDED.display_name,mount_path=EXCLUDED.mount_path,
          sync_mode=EXCLUDED.sync_mode,paused=EXCLUDED.paused,exclusions=EXCLUDED.exclusions,enabled=TRUE,state=EXCLUDED.state,updated_at=NOW()`,
      [root.id, collectionId, root.name, root.path, root.syncMode, root.paused, JSON.stringify(root.exclusions), root.paused ? 'paused' : 'idle']);
    }
    await this.db.query("UPDATE file_roots SET enabled=FALSE,state='detached',updated_at=NOW() WHERE NOT(id=ANY($1::text[]))", [this.roots.map(root => root.id)]);
    await this.recoverPathOperations();
    await beforeScan?.();
    const saved = await this.db.query('SELECT paused,last_error,last_scan_at,last_sync_at FROM files_runtime_state WHERE id=TRUE');
    if (saved.rows[0]) { this.paused ||= saved.rows[0].paused; this.lastError = saved.rows[0].last_error; this.lastScanAt = saved.rows[0].last_scan_at?.toISOString?.(); this.lastSyncAt = saved.rows[0].last_sync_at?.toISOString?.() }
    await this.rescan();
    this.syncTimer = setInterval(() => this.sync().catch(error => this.fail(error)), 15_000);
    this.syncTimer.unref();
  }

  async close():Promise<void> {
    this.stopped = true;
    if (this.syncTimer) clearInterval(this.syncTimer);
    await this.mutations.runExclusive(['.'], () => Promise.resolve()).catch(() => undefined);
  }

  status():RuntimeState {
    const elapsed = Math.max(0.001, (Date.now() - this.progressStartedAt) / 1_000); const rate = this.processedBytes / elapsed;
    return { state: this.paused ? 'paused' : this.lastError ? 'error' : this.running ? 'syncing' : 'synced', pendingFiles: this.pendingFiles, pendingBytes: this.pendingBytes, processedBytes: this.processedBytes, totalBytes: this.totalBytes, estimatedSeconds: this.running && rate > 0 ? Math.max(1, Math.ceil(this.pendingBytes / rate)) : undefined, lastError: this.lastError, lastScanAt: this.lastScanAt, lastSyncAt: this.lastSyncAt, serverConfigured: Boolean(this.config.serverUrl), legacyImport: this.config.legacyPreflight };
  }

  async listRoots():Promise<FileRootStatus[]> {
    const rows = await this.db.query(`SELECT id,display_name,collection_id,sync_mode,paused,exclusions,state,pending_files,last_error,last_scan_at,last_sync_at
      FROM file_roots WHERE enabled=TRUE ORDER BY created_at`);
    return rows.rows.map(row => ({
      id: row.id, name: row.display_name, collectionId: row.collection_id, syncMode: row.sync_mode, paused: row.paused,
      exclusions: row.exclusions ?? [], state: row.paused ? 'paused' : row.state, pendingFiles: row.pending_files,
      serverConfigured: Boolean(this.config.serverUrl),
      lastError: row.last_error ?? undefined, lastScanAt: row.last_scan_at?.toISOString?.(), lastSyncAt: row.last_sync_at?.toISOString?.(),
    }));
  }

  async configureRoot(id:string, input:{ paused?:boolean; syncMode?:'local' | 'server'; exclusions?:string[] }):Promise<FileRootStatus> {
    const configured = this.roots.find(root => root.id === id);
    if (!configured) throw Object.assign(new Error('File root is not mounted in this Files runtime'), { status: 409 });
    if (input.syncMode === 'server' && !this.config.serverUrl) throw Object.assign(new Error('No Files server is configured'), { status: 409 });
    if (input.paused !== undefined) configured.paused = input.paused;
    if (input.syncMode) configured.syncMode = input.syncMode;
    if (input.exclusions) configured.exclusions = input.exclusions;
    await this.db.query(`UPDATE file_roots SET paused=$2,sync_mode=$3,exclusions=$4,state=$5,last_error=NULL,updated_at=NOW() WHERE id=$1 AND enabled=TRUE`,
      [id, configured.paused, configured.syncMode, JSON.stringify(configured.exclusions), configured.paused ? 'paused' : 'idle']);
    if (!configured.paused) await this.rescan();
    const root = (await this.listRoots()).find(item => item.id === id);
    if (!root) throw Object.assign(new Error('File root is unavailable'), { status: 404 });
    return root;
  }

  async detachRoot(id:string):Promise<void> {
    if (id === 'default') throw Object.assign(new Error('The default Files root cannot be removed'), { status: 409 });
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query("UPDATE file_roots SET enabled=FALSE,paused=TRUE,state='detached',pending_files=0,last_error=NULL,updated_at=NOW() WHERE id=$1 AND enabled=TRUE RETURNING collection_id", [id]);
      if (!result.rowCount) throw Object.assign(new Error('File root was not found'), { status: 404 });
      // Detaching forgets scan custody only. Source files, encrypted versions,
      // search records and journal history remain untouched and no delete versions
      // are emitted.
      await client.query('DELETE FROM watched_folder_state WHERE root_id=$1', [id]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release() }
    const configuredIndex = this.roots.findIndex(root => root.id === id);
    if (configuredIndex >= 0) this.roots.splice(configuredIndex, 1);
    this.rootCollections.delete(id);
  }

  async recent(limit:number, exactPath?:string):Promise<any[]> {
    const result = await this.db.query(`SELECT f.id,f.path,f.mime,f.size,f.updated_at,(f.path ILIKE '%conflicted copy%') AS conflict,m.duration_seconds,r.state AS residency_state
      FROM files f JOIN collection_acl a ON a.collection_id=f.collection_id AND a.principal_type='user' AND a.principal_id=$1
      LEFT JOIN recording_metadata m ON m.file_id=f.id
      LEFT JOIN file_residency r ON r.file_id=f.id
      WHERE NOT EXISTS(SELECT 1 FROM files_protected_files p WHERE p.file_id=f.id) AND f.deleted_at IS NULL AND ($2::text IS NULL OR f.path=$2) ORDER BY f.updated_at DESC LIMIT $3`, [this.config.userId, exactPath ?? null, Math.max(1, Math.min(Number.isFinite(limit) ? limit : 4, 100))]);
    const syncState = this.status().state;
    return result.rows.filter(row => !isProtectedPath(row.path)).map(row => ({ id: row.id, path: row.path, mime: row.mime, size: Number(row.size), updatedAt: row.updated_at, conflict: row.conflict, durationSeconds: row.duration_seconds == null ? undefined : Number(row.duration_seconds), syncState: row.residency_state === 'online-only' ? 'online-only' : syncState === 'error' ? 'error' : syncState === 'syncing' ? 'syncing' : 'synced' }));
  }

  async setPaused(paused:boolean):Promise<RuntimeState> {
    this.paused = paused; await this.db.query('UPDATE files_runtime_state SET paused=$1,state=$2,updated_at=NOW() WHERE id=TRUE', [paused, paused ? 'paused' : 'synced']);
    if (!paused) await this.sync();
    return this.status();
  }

  async watchedPathCoverage(collectionId:string, items:{ sourcePath:string; folder:boolean; fileSnapshots:{ id:string }[] }[]):Promise<number> {
    if (![...this.rootCollections.values()].includes(collectionId)) return 0;
    let covered = 0;
    for (const item of items) {
      const result = await this.db.query(`SELECT file_id::text FROM watched_folder_state WHERE collection_id=$1 AND (path=$2 OR ($3 AND starts_with(path,$2||'/')))`, [collectionId, item.sourcePath, item.folder]);
      const watched = new Set(result.rows.map(row => row.file_id));
      covered += item.fileSnapshots.filter(file => watched.has(file.id)).length;
    }
    return covered;
  }

  async applyPathOperations(action:'move' | 'copy', items:{ sourcePath:string; targetPath:string; folder:boolean; fileSnapshots:{ id:string; path:string; currentVersionId:string }[] }[], actor:FilesIdentity):Promise<void> {
    const fileId = items[0]?.fileSnapshots[0]?.id;
    const collectionId = fileId ? (await this.db.query('SELECT collection_id FROM files WHERE id=$1', [fileId])).rows[0]?.collection_id : undefined;
    const root = this.roots.find(item => this.rootCollections.get(item.id) === collectionId);
    if (!root) throw Object.assign(new Error('The watched Files root is unavailable'), { status: 409 });
    const paths = items.flatMap(item => [item.sourcePath, item.targetPath]);
    const mutations = this.rootMutations.get(root.id)!;
    return this.serial(() => mutations.runExclusive(paths, () => this.applyPathOperationsNow(action, items, actor, root, mutations)));
  }

  private async applyPathOperationsNow(action:'move' | 'copy', items:{ sourcePath:string; targetPath:string; folder:boolean; fileSnapshots:{ id:string; path:string; currentVersionId:string }[] }[], actor:FilesIdentity, root:FileRootConfig, mutations:FilesMutationCoordinator):Promise<void> {
    await FilesMutationCoordinator.requireAtomicRename();
    if (!this.config.filesRoot) throw Object.assign(new Error('The watched Files folder is unavailable'), { status: 409 });
    const collectionId = this.rootCollections.get(root.id)!;
    const sources = items.map(item => item.sourcePath);
    if (sources.some((source, index) => sources.some((candidate, other) => index !== other && source.startsWith(`${ candidate }/`)))) throw Object.assign(new Error('Choose either a folder or an item inside it, not both'), { status: 400 });
    const destinations = items.flatMap(item => item.fileSnapshots.map(file => `${ item.targetPath }${ file.path.slice(item.sourcePath.length) }`));
    if (new Set(destinations).size !== destinations.length) throw Object.assign(new Error('Two selected items have the same destination'), { status: 409 });
    if (items.some(item => item.fileSnapshots.some(file => `${ item.targetPath }${ file.path.slice(item.sourcePath.length) }` === file.path))) throw Object.assign(new Error('The destination must be different from the source'), { status: 400 });
    const operationId = randomUUID();
    const completed:{ publication:PublicationReceipt; eviction?:EvictionReceipt }[] = [];
    let durablePlan:PathOperationPlanEntry[] = [];
    const client = await this.db.connect(); let transaction = false; let intentCreated = false; let commitAttempted = false; let clientReleased = false;
    try {
      await client.query('BEGIN'); transaction = true;
      const lockedRows:any[][] = [];
      for (const item of items) {
        const snapshots = new Map(item.fileSnapshots.map(file => [file.id, file]));
        const rows = await client.query(`SELECT f.*,f.id::text,w.path AS watched_path,w.content_hash,w.size AS watched_size,w.mtime_ms,f.current_version_id::text
          FROM files f JOIN watched_folder_state w ON w.file_id=f.id AND w.collection_id=f.collection_id
          WHERE f.collection_id=$1 AND f.id=ANY($2::uuid[]) AND f.deleted_at IS NULL
            AND NOT EXISTS(SELECT 1 FROM files_protected_files p WHERE p.file_id=f.id)
          ORDER BY w.path FOR UPDATE OF f,w`, [collectionId, [...snapshots.keys()]]);
        if (rows.rowCount !== snapshots.size || rows.rows.some(row => { const snapshot = snapshots.get(row.id); return !snapshot || snapshot.path !== row.watched_path || snapshot.currentVersionId !== row.current_version_id })) throw Object.assign(new Error('A selected file changed or became protected while this operation was starting. Refresh Files and try again.'), { status: 409 });
        for (const row of rows.rows) {
          const nextPath = `${ item.targetPath }${ row.watched_path.slice(item.sourcePath.length) }`;
          const collision = await client.query('SELECT 1 FROM files WHERE collection_id=$1 AND path=$2 AND id<>$3 AND deleted_at IS NULL', [collectionId, nextPath, row.id]);
          if (collision.rowCount) throw Object.assign(new Error(`An item already exists at ${ nextPath }`), { status: 409 });
        }
        lockedRows.push(rows.rows);
      }
      const plan:PathOperationPlanEntry[] = [];
      for (const [index, item] of items.entries()) {
        for (const row of lockedRows[index]) {
          plan.push({
            rootId:      root.id,
            fileId:      row.id,
            sourcePath:  row.watched_path,
            targetPath:  `${ item.targetPath }${ row.watched_path.slice(item.sourcePath.length) }`,
            stagePath:   `.sulla-trash/.operations/${ operationId }/${ row.id }.${ action }`,
            contentHash: row.content_hash,
            kind:        action,
          });
        }
      }
      durablePlan = plan;
      await this.db.query(
        `INSERT INTO files_path_operations(operation_id,action,state,plan) VALUES($1,$2,'planned',$3::jsonb)`,
        [operationId, action, JSON.stringify(plan)],
      );
      intentCreated = true;
      await this.db.query("UPDATE files_path_operations SET state='publishing',updated_at=NOW() WHERE operation_id=$1", [operationId]);
      let planIndex = 0;
      for (const [index, item] of items.entries()) {
        for (const row of lockedRows[index]) {
          const sourcePath = row.watched_path;
          const targetPath = `${ item.targetPath }${ sourcePath.slice(item.sourcePath.length) }`;
          if (isProtectedPath(sourcePath) || isProtectedPath(targetPath)) throw Object.assign(new Error(`Protected Files content cannot be ${ action === 'move' ? 'moved' : 'copied' }`), { status: 403 });
          const verify = async(pinned:PinnedRegularFile) => {
            const hash = createHash('sha256');
            for await (const chunk of pinned.createReadStream()) hash.update(chunk);
            if (hash.digest('hex') !== row.content_hash) throw Object.assign(new Error('A selected file changed while the operation was starting. Refresh Files and try again.'), { status: 409 });
          };
          const operation = plan[planIndex++];
          if (action === 'copy') {
            completed.push({ publication: await mutations.copyVerified({ source: sourcePath, target: targetPath, staged: operation.stagePath, verify }) });
          } else {
            const eviction = await mutations.evictVerified({ source: sourcePath, quarantine: operation.stagePath, verify });
            try {
              const publication = await mutations.publishVerified({ staged: eviction.quarantine, target: targetPath, verify });
              completed.push({ publication, eviction });
            } catch (error) {
              try { await mutations.recoverEviction(eviction, verify) } catch (recoveryError) {
                throw Object.assign(new Error(`${ error instanceof Error ? error.message : String(error) }. The source was preserved for recovery at ${ eviction.quarantine }: ${ recoveryError instanceof Error ? recoveryError.message : String(recoveryError) }`), { status: (error as any)?.status ?? 500 });
              }
              throw error;
            }
          }
          await this.db.query(
            `UPDATE files_path_operations SET receipts=receipts||$2::jsonb,updated_at=NOW() WHERE operation_id=$1`,
            [operationId, JSON.stringify([{
              fileId:      operation.fileId,
              stagePath:   operation.stagePath,
              targetPath:  operation.targetPath,
              published:   true,
              fingerprint: serializeFingerprint(completed.at(-1)!.publication.fingerprint),
            }])],
          );
        }
      }
      let receiptIndex = 0;
      for (const [index, item] of items.entries()) {
        for (const row of lockedRows[index]) {
          const nextPath = `${ item.targetPath }${ row.watched_path.slice(item.sourcePath.length) }`;
          const receipt = completed[receiptIndex++].publication;
          if (action === 'move') {
            await client.query('UPDATE files SET path=$2,updated_at=NOW() WHERE id=$1', [row.id, nextPath]);
            await client.query('UPDATE watched_folder_state SET path=$3 WHERE collection_id=$1 AND file_id=$2', [collectionId, row.id, nextPath]);
            await client.query("INSERT INTO journal(collection_id,file_id,version_id,op) VALUES($1,$2,$3,'rename')", [collectionId, row.id, row.current_version_id]);
            await client.query(`INSERT INTO audit_log(who_type,who_id,device_or_run_id,file_id,version_id,action,details) VALUES($1,$2,$3,$4,$5,'move',$6)`, [actor.kind === 'capability' ? 'agent-or-device' : 'user', actor.userId, actor.deviceId || null, row.id, row.current_version_id, JSON.stringify({ collectionId, from: row.path, to: nextPath })]);
          } else {
            const copied = await copyLockedFile(client, row, nextPath, actor);
            await client.query(`INSERT INTO watched_folder_state(collection_id,path,file_id,content_hash,size,mtime_ms,root_id)
              VALUES($1,$2,$3,$4,$5,$6,$7)`, [collectionId, nextPath, copied.id, row.content_hash, receipt.fingerprint.size, Math.trunc(receipt.fingerprint.mtimeMs), root.id]);
            await client.query(`INSERT INTO audit_log(who_type,who_id,device_or_run_id,file_id,version_id,action,details) VALUES($1,$2,$3,$4,$5,'copy',$6)`, [actor.kind === 'capability' ? 'agent-or-device' : 'user', actor.userId, actor.deviceId || null, copied.id, copied.current_version_id, JSON.stringify({ collectionId, from: row.watched_path, to: nextPath })]);
          }
        }
        if (action === 'move' && item.folder) {
          const folderStars = await client.query(`SELECT principal_type,principal_id,folder_path FROM file_stars WHERE collection_id=$1 AND (folder_path=$2 OR starts_with(folder_path,$2||'/')) FOR UPDATE`, [collectionId, item.sourcePath]);
          for (const star of folderStars.rows) await client.query(`UPDATE file_stars SET folder_path=$4 WHERE principal_type=$1 AND principal_id=$2 AND collection_id=$3 AND folder_path=$5`, [star.principal_type, star.principal_id, collectionId, `${ item.targetPath }${ star.folder_path.slice(item.sourcePath.length) }`, star.folder_path]);
          for (const table of ['folder_shares', 'file_share_links']) await client.query(`UPDATE ${ table } SET folder_path=$3||substr(folder_path,length($2)+1) WHERE collection_id=$1 AND folder_path IS NOT NULL AND (folder_path=$2 OR starts_with(folder_path,$2||'/'))`, [collectionId, item.sourcePath, item.targetPath]);
        }
      }
      await client.query("UPDATE files_path_operations SET state='db-committed',updated_at=NOW() WHERE operation_id=$1", [operationId]);
      commitAttempted = true;
      await client.query('COMMIT'); transaction = false;
    } catch (error) {
      if (commitAttempted) {
        client.release(true); clientReleased = true;
        throw Object.assign(new Error(`The database commit outcome is being reconciled; published files were preserved: ${ error instanceof Error ? error.message : String(error) }`), { status: 503 });
      }
      const preservationErrors:string[] = [];
      if (transaction) {
        try { await client.query('ROLLBACK') } catch (rollbackError) { preservationErrors.push(`database rollback failed: ${ rollbackError instanceof Error ? rollbackError.message : String(rollbackError) }`) }
      }
      for (const item of completed.reverse()) {
        const planned = durablePlan.find(entry => entry.targetPath === item.publication.target);
        const verify = async(pinned:PinnedRegularFile) => planned ? this.verifyOperationPinned(pinned, planned.contentHash) : pinned.assertUnchanged();
        try { await mutations.rollbackPublication(item.publication, verify) } catch (recoveryError) { preservationErrors.push(`${ item.publication.target }: ${ recoveryError instanceof Error ? recoveryError.message : String(recoveryError) }`); continue }
        if (item.eviction) {
          try { await mutations.recoverEviction(item.eviction, verify) } catch (recoveryError) { preservationErrors.push(`${ item.eviction.source }: ${ recoveryError instanceof Error ? recoveryError.message : String(recoveryError) }`) }
        } else {
          try { await mutations.finalizePublication(item.publication) } catch (recoveryError) { preservationErrors.push(`${ item.publication.staged }: ${ recoveryError instanceof Error ? recoveryError.message : String(recoveryError) }`) }
        }
      }
      if (intentCreated) {
        await this.db.query(
          `UPDATE files_path_operations SET state=$2,last_error=$3,updated_at=NOW() WHERE operation_id=$1`,
          [operationId, preservationErrors.length ? 'publishing' : 'completed', (error instanceof Error ? error.message : String(error)).slice(0, 2000)],
        ).catch(() => undefined);
      }
      const reason = error instanceof Error ? error.message : String(error);
      throw Object.assign(new Error(`${ reason }${ preservationErrors.length ? ` Recovery artifacts were preserved: ${ preservationErrors.join('; ') }` : '' }`), { status: (error as any)?.status ?? 500 });
    } finally { if (!clientReleased) client.release(); }
    const cleanupErrors:string[] = [];
    for (const item of completed) await mutations.finalizePublication(item.publication).catch(error => cleanupErrors.push(`${ item.publication.staged }: ${ error instanceof Error ? error.message : String(error) }`));
    await this.db.query(
      `UPDATE files_path_operations SET state=$2,last_error=$3,updated_at=NOW() WHERE operation_id=$1`,
      [operationId, cleanupErrors.length ? 'db-committed' : 'completed', cleanupErrors.length ? cleanupErrors.join('; ').slice(0, 2000) : null],
    );
    if (cleanupErrors.length) throw Object.assign(new Error(`The operation committed, but protected cleanup artifacts remain: ${ cleanupErrors.join('; ') }. Refresh Files before retrying.`), { status: 500 });
    this.indexer?.wake();
    await this.scanFolder();
    if (!this.paused) await this.syncNow();
  }

  /** Reconcile durable native publications before the watcher can infer changes. */
  async recoverPathOperations():Promise<void> {
    return this.mutations.runExclusive(['.sulla-trash/.operations'], async() => {
      const rows = (await this.db.query(
        `SELECT operation_id,state,plan,receipts FROM files_path_operations
          WHERE state IN('planned','publishing','db-committed','undo-planned','undo-publishing','undo-db-committed') ORDER BY created_at`,
      )).rows as PathOperationRow[];
      for (const row of rows) {
        try {
          if ((row.plan as RemotePurgePlan)?.kind==='remote-purge-v1') { await this.recoverRemotePurgeOperation(row as any); continue }
          if ([2,3].includes((row.plan as any)?.version)) { await this.nativeJournal.recover(row); continue }
          const plan = Array.isArray(row.plan) ? row.plan : [];
          if (!plan.length) throw new Error('Path operation has no recoverable plan');
          const receipts = Array.isArray(row.receipts) ? row.receipts : [];
          if (row.state === 'db-committed') await this.finishCommittedPathOperation(plan, receipts);
          else await this.rollbackUncommittedPathOperation(plan, receipts);
          await this.db.query("UPDATE files_path_operations SET state='completed',last_error=NULL,updated_at=NOW() WHERE operation_id=$1", [row.operation_id]);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await this.db.query('UPDATE files_path_operations SET last_error=$2,updated_at=NOW() WHERE operation_id=$1', [row.operation_id, message.slice(0, 2000)]);
          throw new Error(`Files path operation ${ row.operation_id } requires preserved-artifact reconciliation: ${ message }`);
        }
      }
      const disposalRows=(await this.db.query(`SELECT operation_id FROM files_path_operations WHERE state IN('completed','undone','rolled-back')
        AND plan#>>'{disposal,undoInvalidatedAt}' IS NOT NULL AND plan#>>'{disposal,artifactsDisposedAt}' IS NULL ORDER BY created_at`)).rows;
      for (const disposal of disposalRows) {
        const result=await this.nativeJournal.dispose(disposal.operation_id);
        if (result.state==='recovery-required') throw new Error(result.error??`Trash receipt ${disposal.operation_id} artifact disposal requires recovery`);
      }
    });
  }

  private async recoverRemotePurgeOperation(input:PathOperationRow):Promise<void> {
    const row=(await this.db.query('SELECT operation_id,state,plan,receipts FROM files_path_operations WHERE operation_id=$1',[input.operation_id])).rows[0];
    if (!row) throw new Error('Remote purge journal is missing; retained bytes were preserved');
    if (row.state==='completed' || row.state==='rolled-back') return;
    if (!['planned','publishing','db-committed'].includes(row.state) || row.plan?.kind!=='remote-purge-v1') throw new Error('Remote purge journal state is invalid; retained bytes were preserved');
    const plan=row.plan as RemotePurgePlan; const mutations=this.rootMutations.get(plan.rootId);
    if (!mutations) throw new Error(`Remote purge root ${plan.rootId} is unavailable; retained bytes were preserved`);
    const verify=(p:PinnedRegularFile)=>this.verifyOperationPinned(p,plan.contentHash);
    const expected=deserializeFingerprint(plan.fingerprint);
    if (row.state==='db-committed') {
      if ((await this.db.query('SELECT 1 FROM files WHERE id=$1 OR (collection_id=$2 AND path=$3) LIMIT 1',[plan.fileId,plan.collectionId,plan.sourcePath])).rowCount) {
        throw new Error('Remote purge metadata is still live; retained bytes were preserved');
      }
      const tombstone=(await this.db.query('SELECT collection_id,path,lifecycle_generation FROM file_purge_tombstones WHERE file_id=$1',[plan.fileId])).rows[0];
      if (!tombstone || tombstone.collection_id!==plan.collectionId || tombstone.path!==plan.sourcePath || Number(tombstone.lifecycle_generation)<plan.lifecycleGeneration) {
        throw new Error('Remote purge commit proof is missing or changed; retained bytes were preserved');
      }
      if (await mutations.exists(plan.stagePath)) await mutations.disposeRetainedFile(plan.stagePath,expected,verify);
      await this.db.query("UPDATE files_path_operations SET state='completed',last_error=NULL,updated_at=NOW() WHERE operation_id=$1 AND state='db-committed'",[row.operation_id]);
      return;
    }
    const sourceExists=await mutations.exists(plan.sourcePath); const stageExists=await mutations.exists(plan.stagePath);
    if (sourceExists && stageExists) throw new Error('Remote purge source and retained stage both exist; both were preserved');
    if (!sourceExists && !stageExists) throw new Error('Remote purge source and retained stage are both missing');
    if (stageExists) await mutations.recoverEviction({source:plan.sourcePath,quarantine:plan.stagePath,fingerprint:expected},verify);
    await this.db.query("UPDATE files_path_operations SET state='rolled-back',last_error=NULL,updated_at=NOW() WHERE operation_id=$1 AND state IN('planned','publishing')",[row.operation_id]);
  }

  private async finishCommittedPathOperation(plan:PathOperationPlanEntry[], receipts:PathOperationReceipt[]):Promise<void> {
    const mutations = this.rootMutations.get(plan[0]?.rootId ?? 'default');
    if (!mutations || plan.some(entry => (entry.rootId ?? 'default') !== (plan[0]?.rootId ?? 'default'))) throw new Error('Path operation root is unavailable or inconsistent');
    for (const entry of plan) {
      const receipt = this.operationReceipt(entry, receipts);
      if (!receipt?.fingerprint) throw new Error(`Committed publication receipt is missing: ${ entry.targetPath }`);
      const fingerprint = deserializeFingerprint(receipt.fingerprint);
      if (!await mutations.exists(entry.targetPath)) throw new Error(`Committed target is missing: ${ entry.targetPath }`);
      const target = await mutations.pin(entry.targetPath);
      try {
        if (!sameFingerprint(target.fingerprint, fingerprint)) throw new Error(`Committed target identity changed: ${ entry.targetPath }`);
        await this.verifyOperationPinned(target, entry.contentHash);
      } finally { await target.close() }
      if (await mutations.exists(entry.stagePath)) {
        const staged = await mutations.pin(entry.stagePath);
        try {
          if (!sameFingerprint(staged.fingerprint, fingerprint)) throw new Error(`Committed stage identity changed: ${ entry.stagePath }`);
          await this.verifyOperationPinned(staged, entry.contentHash);
        } finally { await staged.close() }
        await mutations.finalizePublication({ staged: entry.stagePath, target: entry.targetPath, fingerprint });
      }
    }
  }

  private async rollbackUncommittedPathOperation(plan:PathOperationPlanEntry[], receipts:PathOperationReceipt[]):Promise<void> {
    const mutations = this.rootMutations.get(plan[0]?.rootId ?? 'default');
    if (!mutations || plan.some(entry => (entry.rootId ?? 'default') !== (plan[0]?.rootId ?? 'default'))) throw new Error('Path operation root is unavailable or inconsistent');
    for (const entry of [...plan].reverse()) {
      const durableReceipt = this.operationReceipt(entry, receipts);
      const stageExists = await mutations.exists(entry.stagePath);
      if (await mutations.exists(entry.targetPath) && (durableReceipt?.fingerprint || stageExists)) {
        let fingerprint = durableReceipt?.fingerprint ? deserializeFingerprint(durableReceipt.fingerprint) : undefined;
        if (!fingerprint) {
          const [stage, target] = await Promise.all([mutations.pin(entry.stagePath), mutations.pin(entry.targetPath)]);
          try {
            if (!sameIdentity(stage.fingerprint, target.fingerprint)) throw new Error(`Uncommitted target is not owned by its recovery stage: ${ entry.targetPath }`);
            await Promise.all([this.verifyOperationPinned(stage, entry.contentHash), this.verifyOperationPinned(target, entry.contentHash)]);
            fingerprint = target.fingerprint;
          } finally { await Promise.all([stage.close(), target.close()]) }
        }
        await mutations.rollbackPublication(
          { staged: entry.stagePath, target: entry.targetPath, fingerprint },
          pinned => this.verifyOperationPinned(pinned, entry.contentHash),
        );
      }
      if (entry.kind === 'move' && await mutations.exists(entry.stagePath)) {
        const staged = await mutations.pin(entry.stagePath);
        const receipt:EvictionReceipt = { source: entry.sourcePath, quarantine: entry.stagePath, fingerprint: staged.fingerprint };
        await staged.close();
        await mutations.recoverEviction(receipt, pinned => this.verifyOperationPinned(pinned, entry.contentHash));
      } else if (entry.kind === 'copy' && await mutations.exists(entry.stagePath)) {
        const staged = await mutations.pin(entry.stagePath);
        const receipt:PublicationReceipt = { staged: entry.stagePath, target: entry.targetPath, fingerprint: staged.fingerprint };
        await staged.close();
        await mutations.finalizePublication(receipt);
      }
    }
  }

  private operationReceipt(entry:PathOperationPlanEntry, receipts:PathOperationReceipt[]):PathOperationReceipt | undefined {
    return receipts.find(receipt => receipt.published && receipt.fileId === entry.fileId && receipt.stagePath === entry.stagePath && receipt.targetPath === entry.targetPath);
  }

  private async verifyOperationPinned(pinned:PinnedRegularFile, expectedHash:string):Promise<void> {
    const hash = createHash('sha256');
    for await (const chunk of pinned.createReadStream()) hash.update(chunk);
    if (hash.digest('hex') !== expectedHash) throw new Error(`Recovery artifact changed: ${ pinned.relativePath }`);
    await pinned.assertUnchanged();
  }

  async rescan():Promise<void> { return this.serial(async() => { await this.recoverPathOperations(); await this.scanFolder(); if (!this.paused) await this.syncNow(); }) }
  async sync():Promise<void> { if (this.paused || !this.config.serverUrl) return; return this.serial(() => this.syncNow()) }
  private async serial<T>(operation:()=>Promise<T>):Promise<T> {
    return this.mutations.runExclusive(['.'], async() => {
      if (this.stopped) throw new Error('Files is locked');
      const result = operation().then(value => { this.lastError = undefined; return value }).catch(error => { this.fail(error); throw error });
      const running = result.then(() => undefined);
      this.running = running;
      try { await running; return await result } finally { if (this.running === running) this.running = undefined; }
    });
  }

  private fail(error:unknown):void { this.lastError = error instanceof Error ? error.message : String(error); this.db.query("UPDATE files_runtime_state SET state='error',last_error=$1,updated_at=NOW() WHERE id=TRUE", [this.lastError]).catch(dbError => console.error('[SullaFiles] failed to record runtime error', dbError)) }

  private async ensureCollection(root:FileRootConfig):Promise<string> {
    const id = collectionIdFor(this.config.userId, root.id);
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const existing = await client.query(`SELECT c.id FROM collections c WHERE c.owner_user_id=$2 AND c.kind='knowledge' AND c.published=TRUE AND c.legacy_source=FALSE
        AND (c.id=$1 OR c.id=(SELECT shadow_collection_id FROM files_legacy_collection_map WHERE source_collection_id=$1)) ORDER BY (c.id=$1) DESC LIMIT 1`, [id, this.config.userId]);
      if (!existing.rows[0]) {
        await client.query(`INSERT INTO collections(id,org_id,owner_user_id,name,kind,home,encrypted_data_key,dedup_key_ciphertext,retention_policy)
          VALUES($1,$2,$3,$4,'knowledge',$5,'{}','{}',$6)`, [id, this.config.orgId ?? null, this.config.userId, root.primary ? 'Files' : root.name, root.syncMode === 'server' && this.config.serverUrl ? 'synced' : 'desktop-only', { trashDays: 90 }]);
        const wrapped = await this.config.keyring!.create(id, client);
        await client.query('UPDATE collections SET encrypted_data_key=$2,dedup_key_ciphertext=$3 WHERE id=$1', [id, wrapped.data, wrapped.dedup]);
        await client.query("INSERT INTO collection_acl(collection_id,principal_type,principal_id,role) VALUES($1,'user',$2,'manage')", [id, this.config.userId]);
      } else if (this.config.orgId) await client.query('UPDATE collections SET org_id=$2,updated_at=NOW() WHERE id=$1', [id, this.config.orgId]);
      await client.query('COMMIT'); return existing.rows[0]?.id ?? id;
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  }

  private async ignores(root:FileRootConfig):Promise<string[]> { try { return [...DEFAULT_IGNORES, ...root.exclusions, ...(await readFile(join(root.path, '.sullaignore'), 'utf8')).split(/\r?\n/)] } catch { return [...DEFAULT_IGNORES, ...root.exclusions] } }
  private safe(relativePath:string, root = this.roots.find(item => item.primary)!):string { const absolute = resolve(root.path, relativePath); if (absolute !== root.path && !absolute.startsWith(`${ root.path }${ sep }`)) throw new Error('path escapes Files folder'); return absolute }
  private rootForCollection(collectionId:string):FileRootConfig {
    return this.roots.find(root => this.rootCollections.get(root.id) === collectionId) ?? this.roots.find(root => root.primary)!;
  }

  private async diskFiles(configuredRoot:FileRootConfig, current = configuredRoot.path, prefix = '', patterns?:string[]):Promise<DiskScan> {
    const ignores = patterns ?? await this.ignores(configuredRoot); const output:DiskScan = { paths: [], complete: true, errors: [] };
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }) } catch (error:any) {
      return { paths: [], complete: false, errors: [`Could not read ${ prefix || 'the tracked folder' }: ${ error?.code ?? 'filesystem error' }`] };
    }
    for (const entry of entries) {
      const rel = prefix ? `${ prefix }/${ entry.name }` : entry.name;
      if (isProtectedPath(rel) || isSensitiveTrackedPath(rel) || (configuredRoot.primary && isLegacyInternalPath(rel, this.config.legacyPreflight)) || matchIgnore(rel, ignores)) continue;
      if (entry.isDirectory()) {
        const nested = await this.diskFiles(configuredRoot, join(current, entry.name), rel, ignores);
        output.paths.push(...nested.paths); output.complete &&= nested.complete; output.errors.push(...nested.errors);
      } else if (entry.isFile() && rel !== '.sullaignore') output.paths.push(rel);
    }
    return output;
  }

  private async scanFolder():Promise<void> {
    const pendingOperation = await this.db.query("SELECT operation_id FROM files_path_operations WHERE state IN('planned','publishing','db-committed','undo-planned','undo-publishing','undo-db-committed') LIMIT 1");
    if (pendingOperation.rowCount) throw new Error(`Files path operation ${ pendingOperation.rows[0].operation_id } must be reconciled before watcher scanning`);
    for (const root of this.roots) {
      if (root.paused) continue;
      try { await this.scanRoot(root) } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.db.query("UPDATE file_roots SET state='error',last_error=$2,pending_files=0,updated_at=NOW() WHERE id=$1", [root.id, message]);
        console.error(`[SullaFiles] root ${ root.id } scan failed`, error);
      }
    }
  }

  private async scanRoot(root:FileRootConfig):Promise<void> {
    const collectionId = this.rootCollections.get(root.id)!;
    await this.db.query("UPDATE file_roots SET state='scanning',pending_files=0,last_error=NULL,updated_at=NOW() WHERE id=$1", [root.id]);
    const patterns = await this.ignores(root); const scanned = await this.diskFiles(root, root.path, '', patterns); const diskSet = new Set(scanned.paths); const states = (await this.db.query<WatchedRow>(`SELECT w.*,a.role FROM watched_folder_state w JOIN collection_acl a ON a.collection_id=w.collection_id AND a.principal_type='user' AND a.principal_id=$1 LEFT JOIN file_residency r ON r.file_id=w.file_id WHERE w.root_id=$2 AND COALESCE(r.state,'local')<>'online-only'`, [this.config.userId, root.id])).rows.filter(row => !root.primary || !isLegacyInternalPath(row.path, this.config.legacyPreflight));
    const reconciledStates = states.filter(row => !isProtectedPath(row.path) && !isSensitiveTrackedPath(row.path) && !matchIgnore(row.path, patterns));
    const missingRows = reconciledStates.filter(row => !diskSet.has(row.path));
    if (scanned.complete && reconciledStates.length > 0 && (scanned.paths.length === 0 || (missingRows.length >= 100 && missingRows.length / reconciledStates.length >= 0.8))) {
      throw new Error('Folder availability changed unexpectedly; deletion reconciliation was suspended to protect indexed files');
    }
    const missing = new Map(missingRows.map(row => [row.content_hash, row]));
    const diskInfo = new Map<string, { size:number; mtimeMs:number }>();
    for (const filePath of scanned.paths) {
      try { const info = await stat(this.safe(filePath, root)); if (info.isFile()) diskInfo.set(filePath, { size: info.size, mtimeMs: info.mtimeMs }) } catch (error:any) { scanned.complete = false; scanned.errors.push(`Could not inspect ${ filePath }: ${ error?.code ?? 'filesystem error' }`) }
    }
    const disk = [...diskInfo.keys()];
    const changedPaths = disk.filter(filePath => { const current = states.find(row => row.path === filePath); const info = diskInfo.get(filePath)!; return current?.role !== 'view' && (!current || Number(current.size) !== info.size || Number(current.mtime_ms) !== Math.trunc(info.mtimeMs)) });
    this.pendingFiles = changedPaths.length + missing.size; this.totalBytes = changedPaths.reduce((sum, filePath) => sum + diskInfo.get(filePath)!.size, 0); this.pendingBytes = this.totalBytes; this.processedBytes = 0; this.progressStartedAt = Date.now();
    await this.db.query("UPDATE files_runtime_state SET state='syncing',pending_files=$1,updated_at=NOW() WHERE id=TRUE", [this.pendingFiles]);
    await this.db.query("UPDATE file_roots SET state='scanning',pending_files=$2,updated_at=NOW() WHERE id=$1", [root.id, this.pendingFiles]);
    let changed = 0;
    for (const filePath of disk) {
      const info = diskInfo.get(filePath)!; const old = states.find(row => row.path === filePath);
      if (old && Number(old.size) === info.size && Number(old.mtime_ms) === Math.trunc(info.mtimeMs)) continue;
      if (old?.role === 'view') continue;
      try { if (await this.ingest(root, collectionId, filePath, info.mtimeMs, old, missing)) changed++ } catch (error:any) { scanned.errors.push(`Could not import ${ filePath }: ${ error?.code ?? error?.message ?? 'filesystem error' }`) }
      this.processedBytes += info.size; this.pendingBytes = Math.max(0, this.totalBytes - this.processedBytes); this.pendingFiles = Math.max(0, this.pendingFiles - 1);
    }
    const currentStates = (await this.db.query<WatchedRow>('SELECT * FROM watched_folder_state WHERE root_id=$1', [root.id])).rows;
    if (scanned.complete) for (const row of reconciledStates) if (!diskSet.has(row.path) && row.role !== 'view' && !currentStates.some(current => current.file_id === row.file_id && current.path !== row.path)) { await this.softDelete(row); changed++ }
    this.pendingFiles = 0; this.pendingBytes = 0; this.processedBytes = this.totalBytes; this.lastScanAt = new Date().toISOString(); await this.db.query("UPDATE files_runtime_state SET state='synced',pending_files=0,last_error=NULL,last_scan_at=NOW(),updated_at=NOW() WHERE id=TRUE");
    const scanError = scanned.errors.length ? scanned.errors.slice(0, 5).join('; ').slice(0, 2000) : null;
    await this.db.query("UPDATE file_roots SET state=$2,pending_files=0,last_error=$3,last_scan_at=NOW(),updated_at=NOW() WHERE id=$1", [root.id, scanError
      ? 'error'
      : 'idle', scanError]);
    if (changed) console.log(`[SullaFiles] recorded ${ changed } watched folder change(s) for root ${ root.id }`);
  }

  private async ingest(root:FileRootConfig, collectionId:string, filePath:string, mtimeMs:number, old:WatchedRow | undefined, missing:Map<string, WatchedRow>):Promise<boolean> {
    const keys = await this.config.keyring!.keys(collectionId); const whole = createHash('sha256'); const ids:string[] = []; const chunks:any[] = []; let total = 0;
    for await (const part of createReadStream(this.safe(filePath, root), { highWaterMark: CHUNK_BYTES })) { const plain = Buffer.from(part); total += plain.length; whole.update(plain); const id = chunkId(plain, keys.dedup); ids.push(id); if (!await this.store.has(collectionId, id)) { const encrypted = await encryptChunk(plain, keys.data, id); await this.store.put(collectionId, id, encrypted); chunks.push({ id, size: plain.length, storedSize: encrypted.length }) } }
    if (total === 0) { const empty = Buffer.alloc(0); const id = chunkId(empty, keys.dedup); ids.push(id); if (!await this.store.has(collectionId, id)) { const encrypted = await encryptChunk(empty, keys.data, id); await this.store.put(collectionId, id, encrypted); chunks.push({ id, size: 0, storedSize: encrypted.length }) } }
    const contentHash = whole.digest('hex'); if (old?.content_hash === contentHash) { await this.db.query('UPDATE watched_folder_state SET size=$3,mtime_ms=$4 WHERE collection_id=$1 AND path=$2', [collectionId, filePath, total, Math.trunc(mtimeMs)]); return false }
    const renameFrom = !old ? missing.get(contentHash) : undefined; const manifestHash = createHash('sha256').update(JSON.stringify({ ids, size: total })).digest('hex');
    const existing = !old && !renameFrom ? (await this.db.query(`SELECT f.id,f.deleted_at,v.manifest_hash FROM files f LEFT JOIN file_versions v ON v.id=f.current_version_id
      WHERE f.collection_id=$1 AND f.path=$2`, [collectionId, filePath])).rows[0] : undefined;
    if (existing && !existing.deleted_at && existing.manifest_hash === manifestHash) {
      await this.db.query(`INSERT INTO watched_folder_state(collection_id,path,file_id,content_hash,size,mtime_ms,root_id) VALUES($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT(collection_id,path) DO UPDATE SET file_id=EXCLUDED.file_id,content_hash=EXCLUDED.content_hash,size=EXCLUDED.size,mtime_ms=EXCLUDED.mtime_ms,root_id=EXCLUDED.root_id`, [collectionId, filePath, existing.id, contentHash, total, Math.trunc(mtimeMs), root.id]);
      return false;
    }
    const client = await this.db.connect(); await client.query('BEGIN');
    try {
      await client.query('INSERT INTO manifests(hash,chunk_ids,total_size) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [manifestHash, JSON.stringify(ids), total]);
      for (const chunk of chunks) await client.query('INSERT INTO chunks(collection_id,id,size,stored_size,location,refcount) VALUES($1,$2,$3,$4,$5,0) ON CONFLICT DO NOTHING', [collectionId, chunk.id, chunk.size, chunk.storedSize, `chunks/${ collectionId }/${ chunk.id }`]);
      let fileId = old?.file_id ?? renameFrom?.file_id ?? existing?.id; let parent:string | null = null;
      if (fileId) { const file = (await client.query('SELECT current_version_id FROM files WHERE id=$1 FOR UPDATE', [fileId])).rows[0]; parent = file.current_version_id; await client.query("UPDATE files SET path=$2,mime=$3,size=$4,search_text=NULL,extracted_at=NULL,extraction_status='pending',deleted_at=NULL,updated_at=NOW() WHERE id=$1", [fileId, filePath, mime(filePath), total]) } else { fileId = (await client.query("INSERT INTO files(collection_id,path,created_by_type,created_by_id,mime,size,extraction_status) VALUES($1,$2,'user',$3,$4,$5,'pending') RETURNING id", [collectionId, filePath, this.config.userId, mime(filePath), total])).rows[0].id }
      const version = (await client.query(`INSERT INTO file_versions(file_id,chunk_collection_id,parent_version_id,manifest_hash,size,created_by_type,created_by_id,message,device_id,base_server_version_id)
        VALUES($1,$2,$3,$4,$5,'user',$6,$7,$8,$3) RETURNING id`, [fileId, collectionId, parent, manifestHash, total, this.config.userId, renameFrom ? `Renamed ${ renameFrom.path } to ${ filePath }` : 'Watched folder change', this.config.deviceId])).rows[0];
      await client.query('UPDATE files SET current_version_id=$2 WHERE id=$1', [fileId, version.id]); await client.query('UPDATE chunks SET refcount=refcount+1 WHERE collection_id=$1 AND id=ANY($2::text[])', [collectionId, ids]);
      await client.query('INSERT INTO journal(collection_id,file_id,version_id,op) VALUES($1,$2,$3,$4)', [collectionId, fileId, version.id, renameFrom ? 'rename' : 'put']);
      if (renameFrom) await client.query('DELETE FROM watched_folder_state WHERE collection_id=$1 AND path=$2', [collectionId, renameFrom.path]);
      await client.query(`INSERT INTO watched_folder_state(collection_id,path,file_id,content_hash,size,mtime_ms,root_id) VALUES($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT(collection_id,path) DO UPDATE SET file_id=EXCLUDED.file_id,content_hash=EXCLUDED.content_hash,size=EXCLUDED.size,mtime_ms=EXCLUDED.mtime_ms,root_id=EXCLUDED.root_id`, [collectionId, filePath, fileId, contentHash, total, Math.trunc(mtimeMs), root.id]);
      await client.query('COMMIT'); this.indexer?.wake(); if (renameFrom) missing.delete(contentHash);
      if (root.primary && filePath.startsWith('Recordings/') && mime(filePath).startsWith('video/') && !/-(?:camera|mic|system-audio)\.[^/]+$/i.test(filePath)) {
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
    if (!this.config.serverUrl) return;
    const syncRoots = this.roots.filter(root => !root.paused && root.syncMode === 'server');
    if (!syncRoots.length) return;
    await this.db.query("UPDATE files_runtime_state SET state='syncing',last_error=NULL,updated_at=NOW() WHERE id=TRUE");
    for (const root of syncRoots) {
      const collectionId = this.rootCollections.get(root.id)!;
      await this.config.keyring!.requireLegacySync(collectionId);
      await this.db.query("UPDATE file_roots SET state='syncing',last_error=NULL,updated_at=NOW() WHERE id=$1", [root.id]);
      const collection = (await this.db.query('SELECT * FROM collections WHERE id=$1', [collectionId])).rows[0];
      await this.remote('/v1/collections', { method: 'POST', body: JSON.stringify({ collection }) });
    }
    const remoteCollections:any[] = await this.remote('/v1/collections');
    for (const remote of remoteCollections) await this.config.keyring!.requireLegacySync(remote.id);
    for (const remote of remoteCollections) {
      if (remote.id !== this.collectionId) {
        await this.db.query(`INSERT INTO collections(id,org_id,owner_user_id,name,kind,home,encryption,encrypted_data_key,dedup_key_ciphertext,retention_policy)
          VALUES($1,$2,$3,$4,$5,'synced',$6,$7,$8,$9)
          ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,org_id=EXCLUDED.org_id,updated_at=NOW()`, [remote.id, remote.org_id, remote.owner_user_id, remote.name, remote.kind, remote.encryption, remote.encrypted_data_key, remote.dedup_key_ciphertext, remote.retention_policy ?? {}]);
        const role = remote.access_role ?? (remote.shared_folders?.some((folder:any) => folder.role === 'edit') ? 'edit' : 'view');
        await this.db.query(`INSERT INTO collection_acl(collection_id,principal_type,principal_id,role) VALUES($1,'user',$2,$3)
          ON CONFLICT(collection_id,principal_type,principal_id) DO UPDATE SET role=EXCLUDED.role`, [remote.id, this.config.userId, role]);
      }
      const localRoot = syncRoots.find(root => this.rootCollections.get(root.id) === remote.id);
      await this.syncCollection(remote.id, Boolean(localRoot) || remote.access_role === 'edit' || remote.access_role === 'manage' || remote.shared_folders?.some((folder:any) => folder.role === 'edit'));
    }
    this.pendingFiles = 0; this.lastSyncAt = new Date().toISOString(); await this.db.query("UPDATE files_runtime_state SET state='synced',pending_files=0,last_error=NULL,last_sync_at=NOW(),updated_at=NOW() WHERE id=TRUE");
    await this.db.query("UPDATE file_roots SET state='idle',pending_files=0,last_error=NULL,last_sync_at=NOW(),updated_at=NOW() WHERE id=ANY($1::text[])", [syncRoots.map(root => root.id)]);
  }

  private async syncCollection(collectionId:string, canPush:boolean):Promise<void> {
    await this.db.query('INSERT INTO file_sync_cursors(collection_id,device_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [collectionId, this.config.deviceId]);
    let cursor = (await this.db.query('SELECT * FROM file_sync_cursors WHERE collection_id=$1 AND device_id=$2', [collectionId, this.config.deviceId])).rows[0];
    const entries = await this.remote(`/v1/collections/${ collectionId }/journal?after=${ cursor.last_seq }`);
    for (const entry of entries) { await this.pull(entry); await this.db.query('UPDATE file_sync_cursors SET last_seq=$3 WHERE collection_id=$1 AND device_id=$2', [collectionId, this.config.deviceId, entry.seq]) }
    cursor = (await this.db.query('SELECT * FROM file_sync_cursors WHERE collection_id=$1 AND device_id=$2', [collectionId, this.config.deviceId])).rows[0];
    if (canPush) {
      const pending = (await this.db.query(`SELECT j.seq,j.op,row_to_json(f.*) file,row_to_json(v.*) version,row_to_json(m.*) manifest FROM journal j JOIN files f ON f.id=j.file_id JOIN file_versions v ON v.id=j.version_id LEFT JOIN manifests m ON m.hash=v.manifest_hash WHERE j.collection_id=$1 AND j.seq>$2 AND v.device_id=$3 ORDER BY j.seq`, [collectionId, cursor.last_push_seq, this.config.deviceId])).rows;
      this.pendingFiles += pending.length;
      for (const item of pending) { await this.push(item, collectionId); await this.db.query('UPDATE file_sync_cursors SET last_push_seq=$3 WHERE collection_id=$1 AND device_id=$2', [collectionId, this.config.deviceId, item.seq]) }
    }
  }

  private async push(item:any, collectionId = item.file.collection_id):Promise<void> {
    if (item.op === 'lifecycle') {
      await this.remote(`/v1/files/${ item.file.id }/lifecycle-state`, { method: 'PATCH', body: JSON.stringify({ file: item.file }) });
      return;
    }
    const chunks = item.manifest ? (await this.db.query('SELECT * FROM chunks WHERE collection_id=$1 AND id=ANY($2::text[])', [item.version.chunk_collection_id, item.manifest.chunk_ids])).rows : [];
    const payload = { collectionId, file: item.file, version: item.version, manifest: item.manifest, chunks, baseServerVersionId: item.version.base_server_version_id ?? item.version.parent_version_id };
    const prep = await this.remote('/v1/versions/prepare', { method: 'POST', body: JSON.stringify(payload) });
    if (prep.conflict) { await this.keepConflict(item, prep.currentVersionId); return }
    for (const id of prep.missing ?? []) { const response = await fetch(new URL(`/v1/chunks/${ item.version.chunk_collection_id }/${ id }`, this.config.serverUrl), { method: 'PUT', headers: this.headers({ 'content-type': 'application/octet-stream' }), body: await this.store.get(item.version.chunk_collection_id, id) }); if (!response.ok) throw new Error(`chunk upload failed ${ response.status }`); }
    await this.remote('/v1/versions/commit', { method: 'POST', body: JSON.stringify(payload) }); await this.db.query('UPDATE file_versions SET base_server_version_id=id WHERE id=$1', [item.version.id]);
  }

  private async keepConflict(item:any, remoteVersionId:string):Promise<void> {
    const collectionId = item.file.collection_id;
    const root = this.rootForCollection(collectionId);
    const nextPath = conflictPath(item.file.path, this.config.deviceId); const source = this.safe(item.file.path, root); const target = this.safe(nextPath, root); await mkdir(dirname(target), { recursive: true }); await rename(source, target);
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
      await client.query('INSERT INTO watched_folder_state(collection_id,path,file_id,content_hash,size,mtime_ms,root_id) VALUES($1,$2,$3,$4,$5,$6,$7)', [collectionId, nextPath, fileId, hash.digest('hex'), info.size, Math.trunc(info.mtimeMs), root.id]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
    const conflict = { ...item, file: { ...item.file, id: fileId, path: nextPath }, version: { ...item.version, id: versionId, file_id: fileId, parent_version_id: null, base_server_version_id: null, message: `Conflict copy of ${ item.file.path }` } };
    await this.push(conflict); const bundle = await this.remote(`/v1/versions/${ remoteVersionId }`); await this.pull({ ...bundle, seq: 0 });
  }

  private async materialize(bundle:any):Promise<void> {
    const root = this.rootForCollection(bundle.file.collection_id);
    const keys = await this.config.keyring!.keys(bundle.version.chunk_collection_id); const target = this.safe(bundle.file.path, root); await mkdir(dirname(target), { recursive: true }); const temp = `${ target }.sulla-conflict-${ randomUUID() }`; const output = createWriteStream(temp, { mode: 0o600 });
    let lastId:string | undefined; let lastPlain:Buffer | undefined;
    try { for (const id of bundle.manifest.chunk_ids) { let plain:Buffer; if (id === lastId && lastPlain) plain = lastPlain; else { let encrypted:Uint8Array; if (await this.store.has(bundle.version.chunk_collection_id, id)) encrypted = await this.store.get(bundle.version.chunk_collection_id, id); else { const response = await fetch(new URL(`/v1/chunks/${ bundle.version.chunk_collection_id }/${ id }`, this.config.serverUrl), { headers: this.headers() }); if (!response.ok) throw new Error(`chunk download failed ${ response.status }`); encrypted = new Uint8Array(await response.arrayBuffer()); await this.store.put(bundle.version.chunk_collection_id, id, encrypted) } plain = await decryptChunk(encrypted, keys.data, id); lastId = id; lastPlain = plain } if (!output.write(plain)) await new Promise<void>(resolve => output.once('drain', () => resolve())); } output.end(); await new Promise<void>((resolve, reject) => { output.once('finish', resolve); output.once('error', reject) }); await rename(temp, target) } catch (error) { output.destroy(); throw error }
  }

  private async pull(entry:any):Promise<void> {
    const collectionId = entry.file.collection_id;
    if (entry.op === 'purge') {
      if (entry.syncAuthority?.canMaterialize !== true) return;
      const active=await this.db.query(`SELECT operation_id FROM files_path_operations WHERE state IN('planned','publishing','db-committed','undo-planned','undo-publishing','undo-db-committed')
        AND (plan->>'collectionId'=$1 OR plan::text LIKE $2) LIMIT 1`,[collectionId,`%${entry.file.id}%`]);
      if (active.rowCount) throw new Error(`Remote purge is held by active Files path operation ${active.rows[0].operation_id}`);
      const existing=(await this.db.query(`SELECT f.path,f.current_version_id,f.operation_revision,w.root_id,w.content_hash,w.size,w.mtime_ms
        FROM files f LEFT JOIN watched_folder_state w ON w.file_id=f.id AND w.collection_id=f.collection_id WHERE f.id=$1 AND f.collection_id=$2`,[entry.file.id,collectionId])).rows[0];
      const root=this.rootForCollection(collectionId); const mutations=this.rootMutations.get(existing?.root_id??root.id);
      let remoteOperationId:string|undefined; let remotePlan:RemotePurgePlan|undefined;
      if (existing?.path && existing.content_hash) {
        if (!mutations) throw new Error('Remote purge root is unavailable; local bytes were preserved');
        const pinned=await mutations.pinVerified(existing.path,p=>this.verifyOperationPinned(p,existing.content_hash));
        const expected:FileFingerprint=pinned.fingerprint;
        try {
          if (expected.size!==Number(existing.size) || expected.mtimeMs!==Number(existing.mtime_ms)) throw new Error('Remote purge cannot prove current watched-file ownership; local bytes were preserved');
        } finally { await pinned.close() }
        remoteOperationId=randomUUID();
        remotePlan={kind:'remote-purge-v1',rootId:existing.root_id,collectionId,fileId:entry.file.id,sourcePath:existing.path,
          stagePath:`.sulla-trash/.operations/${remoteOperationId}/remote-purge`,versionId:existing.current_version_id,
          revision:String(existing.operation_revision),contentHash:existing.content_hash,fingerprint:serializeFingerprint(expected),
          lifecycleGeneration:Number(entry.file.lifecycle_generation??0)};
        await this.db.query(`INSERT INTO files_path_operations(operation_id,action,state,plan) VALUES($1,'trash','planned',$2)`,[remoteOperationId,remotePlan]);
        await this.db.query("UPDATE files_path_operations SET state='publishing',updated_at=NOW() WHERE operation_id=$1",[remoteOperationId]);
        let eviction:EvictionReceipt;
        try { eviction=await mutations.evictVerified({source:remotePlan.sourcePath,quarantine:remotePlan.stagePath,verify:p=>this.verifyOperationPinned(p,remotePlan!.contentHash)}) }
        catch(error) {
          try { await this.recoverRemotePurgeOperation({operation_id:remoteOperationId,state:'publishing',plan:remotePlan,receipts:[]}) }
          catch(recoveryError:any) {
            await this.db.query('UPDATE files_path_operations SET last_error=$2,updated_at=NOW() WHERE operation_id=$1',[remoteOperationId,String(recoveryError?.message??recoveryError).slice(0,2000)]).catch(()=>undefined);
            throw recoveryError;
          }
          throw error;
        }
        if (!sameFingerprint(eviction.fingerprint,expected)) {
          await this.recoverRemotePurgeOperation({operation_id:remoteOperationId,state:'publishing',plan:remotePlan,receipts:[]});
          throw new Error('Remote purge source identity changed before eviction; bytes were restored');
        }
      } else if (existing?.path) throw new Error('Remote purge cannot prove ownership of local bytes; they were preserved');
      const client = await this.db.connect(); await client.query('BEGIN');
      try {
        await client.query("SET LOCAL sulla.trusted_replication='on'");
        if (existing && !(await client.query('SELECT 1 FROM files WHERE id=$1 AND collection_id=$2 AND path=$3 AND current_version_id=$4 AND operation_revision=$5 FOR UPDATE',[entry.file.id,collectionId,existing.path,existing.current_version_id,existing.operation_revision])).rowCount) throw new Error('Remote purge target changed; retained bytes were preserved');
        if (remoteOperationId && !(await client.query("SELECT 1 FROM files_path_operations WHERE operation_id=$1 AND state='publishing' AND plan->>'fileId'=$2 AND plan->>'versionId'=$3 AND plan->>'revision'=$4 FOR UPDATE",[remoteOperationId,entry.file.id,existing.current_version_id,String(existing.operation_revision)])).rowCount) throw new Error('Remote purge journal changed; retained bytes were preserved');
        const receipt=existing?(await client.query(`SELECT * FROM files_database_operation_receipts WHERE file_id=$1 AND action='trash'
          AND after_state->>'versionId'=$2 ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,[entry.file.id,existing.current_version_id])).rows[0]:null;
        if (receipt?.state==='completed') {
          const invalidation={undoInvalidatedAt:new Date().toISOString(),invalidatedBy:'remote-authority',reason:'replicated-disposal'};
          const receiptPlan=receipt.folder_plan??{}; receiptPlan.lifecycle={...(receiptPlan.lifecycle??{}),disposal:invalidation};
          await client.query('UPDATE files_database_operation_receipts SET folder_plan=$2 WHERE id=$1',[receipt.id,receiptPlan]);
          const operation=(await client.query('SELECT * FROM files_path_operations WHERE operation_id=$1 FOR UPDATE',[receipt.id])).rows[0];
          if (operation) { operation.plan.disposal=invalidation; await client.query('UPDATE files_path_operations SET plan=$2,updated_at=NOW() WHERE operation_id=$1',[receipt.id,operation.plan]) }
        }
        await client.query(`INSERT INTO file_purge_tombstones(collection_id,file_id,path,lifecycle_generation,audience,purged_at)
          VALUES($1,$2,$3,$4,'{"users":[],"groups":[]}'::jsonb,COALESCE($5,NOW()))
          ON CONFLICT(file_id) DO UPDATE SET path=EXCLUDED.path,lifecycle_generation=GREATEST(file_purge_tombstones.lifecycle_generation,EXCLUDED.lifecycle_generation),purged_at=EXCLUDED.purged_at`,
        [collectionId, entry.file.id, existing?.path??entry.file.path, entry.file.lifecycle_generation ?? 0, entry.at ?? null]);
        await client.query('UPDATE audit_log SET file_id=NULL,version_id=NULL WHERE file_id=$1 OR version_id IN(SELECT id FROM file_versions WHERE file_id=$1)', [entry.file.id]);
        await client.query('DELETE FROM file_share_links WHERE file_id=$1', [entry.file.id]);
        await client.query(`UPDATE files SET record_lock_type='none',retention_mode='none',retain_until=NULL,retention_event_type=NULL,retention_event_at=NULL,
          retention_duration_days=NULL,disposal_status='approved',draft_version_id=NULL,published_version_id=NULL,current_version_id=NULL,
          lifecycle_generation=GREATEST(lifecycle_generation,$2) WHERE id=$1`, [entry.file.id, entry.file.lifecycle_generation ?? 0]);
        await client.query('DELETE FROM journal WHERE file_id=$1', [entry.file.id]);
        await client.query('DELETE FROM files WHERE id=$1 AND collection_id=$2', [entry.file.id, collectionId]);
        await client.query('DELETE FROM watched_folder_state WHERE collection_id=$1 AND file_id=$2', [collectionId, entry.file.id]);
        if (remoteOperationId && (await client.query("UPDATE files_path_operations SET state='db-committed',last_error=NULL,updated_at=NOW() WHERE operation_id=$1 AND state='publishing'",[remoteOperationId])).rowCount!==1) throw new Error('Remote purge journal commit proof could not be recorded');
        await client.query('COMMIT');
        if (remoteOperationId && remotePlan) await this.recoverRemotePurgeOperation({operation_id:remoteOperationId,state:'db-committed',plan:remotePlan,receipts:[]});
        if (receipt?.state==='completed') {
          const disposed=await this.nativeJournal.dispose(receipt.id);
          if (disposed.state==='recovery-required') throw new Error(disposed.error??'Remote purge retained artifacts require recovery');
        }
      } catch (error) {
        await client.query('ROLLBACK').catch(()=>undefined);
        if (remoteOperationId) {
          const durable=(await this.db.query('SELECT operation_id,state,plan,receipts FROM files_path_operations WHERE operation_id=$1',[remoteOperationId])).rows[0];
          if (durable && ['planned','publishing','db-committed'].includes(durable.state)) await this.recoverRemotePurgeOperation(durable).catch(async recoveryError=>{
            await this.db.query('UPDATE files_path_operations SET last_error=$2,updated_at=NOW() WHERE operation_id=$1',[remoteOperationId,String((recoveryError as any)?.message??recoveryError).slice(0,2000)]).catch(()=>undefined);
            throw recoveryError;
          });
        }
        throw error;
      } finally { client.release() }
      return;
    }
    if (entry.op === 'lifecycle') {
      if (!entry.file.path) return;
      const client = await this.db.connect(); await client.query('BEGIN');
      try {
      await client.query("SET LOCAL sulla.trusted_replication='on'");
      await client.query(`INSERT INTO files(id,collection_id,path,created_by_type,created_by_id,mime,size,lifecycle_generation)
        VALUES($1,$2,$3,$4,$5,$6,$7,-1) ON CONFLICT(id) DO NOTHING`, [entry.file.id, collectionId, entry.file.path,
        entry.file.created_by_type, entry.file.created_by_id, entry.file.mime, entry.file.size]);
      await client.query(`UPDATE files SET
        draft_version_id=CASE WHEN EXISTS(SELECT 1 FROM file_versions WHERE id=$2 AND file_id=$1) THEN $2 ELSE draft_version_id END,
        published_version_id=CASE WHEN EXISTS(SELECT 1 FROM file_versions WHERE id=$3 AND file_id=$1) THEN $3 ELSE published_version_id END,
        versioning_enabled=$4,major_minor_enabled=$5,require_approval=$6,require_checkout=$7,
        checked_out_by_user_id=$8,checked_out_by_device_id=$9,checked_out_at=$10,retention_mode=$11,retain_until=$12,
        retention_event_type=$13,retention_event_at=$14,retention_duration_days=$15,record_lock_type=$16,record_locked_at=$17,
        record_locked_by=$18,disposal_status=$19,disposal_review_at=$20,disposal_extended_until=$21,lifecycle_generation=$22,updated_at=NOW()
        WHERE id=$1 AND lifecycle_generation < $22`, [entry.file.id, entry.file.draft_version_id, entry.file.published_version_id, entry.file.versioning_enabled, entry.file.major_minor_enabled,
        entry.file.require_approval, entry.file.require_checkout, entry.file.checked_out_by_user_id, entry.file.checked_out_by_device_id, entry.file.checked_out_at,
        entry.file.retention_mode, entry.file.retain_until, entry.file.retention_event_type, entry.file.retention_event_at, entry.file.retention_duration_days,
        entry.file.record_lock_type, entry.file.record_locked_at, entry.file.record_locked_by, entry.file.disposal_status, entry.file.disposal_review_at,
        entry.file.disposal_extended_until, entry.file.lifecycle_generation]);
      await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
      return;
    }
    if (entry.version?.device_id === this.config.deviceId) return;
    if (entry.syncAuthority?.canMaterialize !== true) return;
    const root = this.rootForCollection(collectionId);
    if (entry.version.deleted) {
      const existing = (await this.db.query('SELECT path FROM files WHERE id=$1', [entry.file.id])).rows[0];
      if (existing) {
        const source = this.safe(existing.path, root); const trash = this.safe(`.sulla-trash/${ entry.file.id }/${ Date.now() }-${ basename(existing.path) }`, root);
        try { await mkdir(dirname(trash), { recursive: true }); await rename(source, trash) } catch (error:any) { if (error?.code !== 'ENOENT') throw error; }
        const client = await this.db.connect(); await client.query('BEGIN');
        try {
          await client.query("SET LOCAL sulla.trusted_replication='on'");
          await client.query(`INSERT INTO file_versions(id,file_id,chunk_collection_id,parent_version_id,manifest_hash,size,deleted,created_by_type,created_by_id,created_at,message,device_id,base_server_version_id)
            VALUES($1,$2,$3,$4,NULL,0,TRUE,$5,$6,$7,$8,$9,$1) ON CONFLICT DO NOTHING`, [entry.version.id, entry.file.id, entry.version.chunk_collection_id, entry.version.parent_version_id, entry.version.created_by_type, entry.version.created_by_id, entry.version.created_at, entry.version.message, entry.version.device_id]);
          await client.query('UPDATE files SET current_version_id=$2,deleted_at=NOW(),updated_at=NOW() WHERE id=$1', [entry.file.id, entry.version.id]);
          await client.query('DELETE FROM watched_folder_state WHERE collection_id=$1 AND file_id=$2', [collectionId, entry.file.id]); await client.query('COMMIT');
        } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
      }
      return;
    }
    const client = await this.db.connect(); await client.query('BEGIN');
    try {
      await client.query("SET LOCAL sulla.trusted_replication='on'");
      const prior = (await client.query('SELECT path,current_version_id,record_lock_type,lifecycle_generation FROM files WHERE id=$1 FOR UPDATE', [entry.file.id])).rows[0];
      if (prior?.current_version_id && prior.record_lock_type !== 'none' && Number(entry.file.lifecycle_generation ?? 0) <= Number(prior.lifecycle_generation)) { await client.query('ROLLBACK'); return }
      if (prior?.path && prior.path !== entry.file.path) {
        try { await mkdir(dirname(this.safe(entry.file.path, root)), { recursive: true }); await rename(this.safe(prior.path, root), this.safe(entry.file.path, root)) } catch (error:any) { if (error?.code !== 'ENOENT') throw error; }
      }
      await this.materialize(entry);
      const info = await stat(this.safe(entry.file.path, root)); const hash = createHash('sha256');
      for await (const part of createReadStream(this.safe(entry.file.path, root))) hash.update(part);
      await client.query('INSERT INTO manifests(hash,chunk_ids,total_size) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [entry.manifest.hash, JSON.stringify(entry.manifest.chunk_ids), entry.manifest.total_size]);
      await client.query(`INSERT INTO files(id,collection_id,path,created_by_type,created_by_id,mime,size,versioning_enabled,major_minor_enabled,require_approval,require_checkout,
        checked_out_by_user_id,checked_out_by_device_id,checked_out_at,retention_mode,retain_until,retention_event_type,retention_event_at,retention_duration_days,
        record_lock_type,record_locked_at,record_locked_by,disposal_status,disposal_review_at,disposal_extended_until,lifecycle_generation)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)
        ON CONFLICT(id) DO UPDATE SET path=EXCLUDED.path,mime=EXCLUDED.mime,size=EXCLUDED.size,deleted_at=NULL,
        versioning_enabled=CASE WHEN EXCLUDED.lifecycle_generation>=files.lifecycle_generation THEN EXCLUDED.versioning_enabled ELSE files.versioning_enabled END,
        major_minor_enabled=CASE WHEN EXCLUDED.lifecycle_generation>=files.lifecycle_generation THEN EXCLUDED.major_minor_enabled ELSE files.major_minor_enabled END,
        require_approval=CASE WHEN EXCLUDED.lifecycle_generation>=files.lifecycle_generation THEN EXCLUDED.require_approval ELSE files.require_approval END,
        require_checkout=CASE WHEN EXCLUDED.lifecycle_generation>=files.lifecycle_generation THEN EXCLUDED.require_checkout ELSE files.require_checkout END,
        checked_out_by_user_id=CASE WHEN EXCLUDED.lifecycle_generation>=files.lifecycle_generation THEN EXCLUDED.checked_out_by_user_id ELSE files.checked_out_by_user_id END,
        checked_out_by_device_id=CASE WHEN EXCLUDED.lifecycle_generation>=files.lifecycle_generation THEN EXCLUDED.checked_out_by_device_id ELSE files.checked_out_by_device_id END,
        checked_out_at=CASE WHEN EXCLUDED.lifecycle_generation>=files.lifecycle_generation THEN EXCLUDED.checked_out_at ELSE files.checked_out_at END,
        retention_mode=CASE WHEN EXCLUDED.lifecycle_generation>=files.lifecycle_generation THEN EXCLUDED.retention_mode ELSE files.retention_mode END,
        retain_until=CASE WHEN EXCLUDED.lifecycle_generation>=files.lifecycle_generation THEN EXCLUDED.retain_until ELSE files.retain_until END,
        retention_event_type=CASE WHEN EXCLUDED.lifecycle_generation>=files.lifecycle_generation THEN EXCLUDED.retention_event_type ELSE files.retention_event_type END,
        retention_event_at=CASE WHEN EXCLUDED.lifecycle_generation>=files.lifecycle_generation THEN EXCLUDED.retention_event_at ELSE files.retention_event_at END,
        retention_duration_days=CASE WHEN EXCLUDED.lifecycle_generation>=files.lifecycle_generation THEN EXCLUDED.retention_duration_days ELSE files.retention_duration_days END,
        record_lock_type=CASE WHEN EXCLUDED.lifecycle_generation>=files.lifecycle_generation THEN EXCLUDED.record_lock_type ELSE files.record_lock_type END,
        record_locked_at=CASE WHEN EXCLUDED.lifecycle_generation>=files.lifecycle_generation THEN EXCLUDED.record_locked_at ELSE files.record_locked_at END,
        record_locked_by=CASE WHEN EXCLUDED.lifecycle_generation>=files.lifecycle_generation THEN EXCLUDED.record_locked_by ELSE files.record_locked_by END,
        disposal_status=CASE WHEN EXCLUDED.lifecycle_generation>=files.lifecycle_generation THEN EXCLUDED.disposal_status ELSE files.disposal_status END,
        disposal_review_at=CASE WHEN EXCLUDED.lifecycle_generation>=files.lifecycle_generation THEN EXCLUDED.disposal_review_at ELSE files.disposal_review_at END,
        disposal_extended_until=CASE WHEN EXCLUDED.lifecycle_generation>=files.lifecycle_generation THEN EXCLUDED.disposal_extended_until ELSE files.disposal_extended_until END,
        lifecycle_generation=GREATEST(files.lifecycle_generation,EXCLUDED.lifecycle_generation),updated_at=NOW()`,
      [entry.file.id, collectionId, entry.file.path, entry.file.created_by_type, entry.file.created_by_id, entry.file.mime, entry.file.size,
        entry.file.versioning_enabled ?? false, entry.file.major_minor_enabled ?? false, entry.file.require_approval ?? false, entry.file.require_checkout ?? false,
        entry.file.checked_out_by_user_id ?? null, entry.file.checked_out_by_device_id ?? null, entry.file.checked_out_at ?? null, entry.file.retention_mode ?? 'none', entry.file.retain_until ?? null,
        entry.file.retention_event_type ?? null, entry.file.retention_event_at ?? null, entry.file.retention_duration_days ?? null, entry.file.record_lock_type ?? 'none',
        entry.file.record_locked_at ?? null, entry.file.record_locked_by ?? null, entry.file.disposal_status ?? 'none', entry.file.disposal_review_at ?? null,
        entry.file.disposal_extended_until ?? null, entry.file.lifecycle_generation ?? 0]);
      await client.query(`INSERT INTO file_versions(id,file_id,chunk_collection_id,parent_version_id,manifest_hash,size,deleted,created_by_type,created_by_id,created_at,message,device_id,base_server_version_id,
        major_version,minor_version,version_kind,publication_status,published_at,published_by,version_comment)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$1,$13,$14,$15,$16,$17,$18,$19) ON CONFLICT(id) DO UPDATE SET
        major_version=EXCLUDED.major_version,minor_version=EXCLUDED.minor_version,version_kind=EXCLUDED.version_kind,
        publication_status=EXCLUDED.publication_status,published_at=EXCLUDED.published_at,published_by=EXCLUDED.published_by,
        version_comment=EXCLUDED.version_comment,base_server_version_id=EXCLUDED.id`,
      [entry.version.id, entry.file.id, entry.version.chunk_collection_id, entry.version.parent_version_id, entry.version.manifest_hash, entry.version.size,
        entry.version.deleted, entry.version.created_by_type, entry.version.created_by_id, entry.version.created_at, entry.version.message, entry.version.device_id,
        entry.version.major_version ?? 0, entry.version.minor_version ?? 1, entry.version.version_kind ?? 'minor', entry.version.publication_status ?? 'draft',
        entry.version.published_at ?? null, entry.version.published_by ?? null, entry.version.version_comment ?? null]);
      await client.query(`UPDATE files SET current_version_id=$2,
        draft_version_id=CASE WHEN $3='draft' THEN $2 ELSE draft_version_id END,
        published_version_id=CASE WHEN $3='published' THEN $2 ELSE published_version_id END WHERE id=$1`, [entry.file.id, entry.version.id, entry.version.publication_status ?? 'draft']);
      await client.query(`INSERT INTO watched_folder_state(collection_id,path,file_id,content_hash,size,mtime_ms,root_id) VALUES($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT(collection_id,path) DO UPDATE SET file_id=EXCLUDED.file_id,content_hash=EXCLUDED.content_hash,size=EXCLUDED.size,mtime_ms=EXCLUDED.mtime_ms,root_id=EXCLUDED.root_id`, [collectionId, entry.file.path, entry.file.id, hash.digest('hex'), info.size, Math.trunc(info.mtimeMs), root.id]);
      await client.query('COMMIT'); this.indexer?.wake();
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  }
}
