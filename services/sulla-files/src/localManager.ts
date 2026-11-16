// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { TransactionRunner } from './FilesTransaction.js';

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, realpath } from 'node:fs/promises';
import { basename, sep } from 'node:path';

import { decryptChunk } from './crypto.js';
import { isProtectedPath } from './protectedFiles.js';
import { PublicationLifecyclePolicy } from './publicationLifecyclePolicy.js';
import { CollectionPolicyRepository } from './Repositories/CollectionPolicyRepository.js';
import { FilesMutationCoordinator } from './safeFilesystem.js';
import { NativeOperationJournal } from './nativeOperationJournal.js';
import { queryNativeSourcePage, type NativeSourcePage, type NativeSourcePageRow } from './nativeSourcePaging.js';
import { streamFileContent } from './fileStream.js';
import type { DatabaseOperationAccess } from './databaseOperations.js';
import { Store } from './store.js';

import type { FilesIdentity } from './auth.js';
import type { Config, FileRootConfig } from './config.js';
import type { IndexingQueue } from './indexing.js';
import type { OriginalRevealTarget } from './originalReveal.js';
import type { PinnedRegularFile, ReplacementReceipt } from './safeFilesystem.js';
import type pg from 'pg';
import { NativeRootScanner } from './NativeRootScanner.js';
import { WatchedFolderRepository, type WatchedRow } from './Repositories/WatchedFolderRepository.js';
import { ScanProgress } from './ScanProgress.js';
import { TrackedPathFilter } from './TrackedPathFilter.js';
import { PathOperationRecovery } from './PathOperationRecovery.js';
import { PathOperationRepository } from './Repositories/PathOperationRepository.js';
import { TrashReceiptExpiry } from './TrashReceiptExpiry.js';
import { LegacyFolderSync } from './LegacyFolderSync.js';
import { NativePathOperationPublisher, type PathOperationItem } from './NativePathOperationPublisher.js';
import { PathOperationPublishRepository } from './Repositories/PathOperationPublishRepository.js';
import { RemoteFilesClient } from './RemoteFilesClient.js';
import { RemotePurgeApplier } from './RemotePurgeApplier.js';
import { ReplicationPuller } from './ReplicationPuller.js';
import { LegacySyncRepository } from './Repositories/LegacySyncRepository.js';
import { RemotePurgeRepository } from './Repositories/RemotePurgeRepository.js';
import { ReplicationRepository } from './Repositories/ReplicationRepository.js';
import type { PathOperationRow } from './PathOperationPlan.js';
import { FileRootRepository } from './Repositories/FileRootRepository.js';
import { TrackedRootCatalog, type BrokeredRootInput, type FileRootStatus } from './TrackedRootCatalog.js';
import { WatchedFileIngestor } from './WatchedFileIngestor.js';
import { NativeSourceOperations } from './NativeSourceOperations.js';
import type { FuseTrackedFile, NativePublicationAction, NativePublicationCompletionProof, NativeSourceIngestResult, NativeSourceOperationInput } from './NativeSourceOperations.js';

interface RuntimeState {
  state: 'synced' | 'syncing' | 'paused' | 'error'; pendingFiles: number; pendingBytes: number;
  processedBytes: number; totalBytes: number; estimatedSeconds?: number; lastError?: string;
  lastScanAt?: string; lastSyncAt?: string; serverConfigured: boolean;
  legacyImport?: Config['legacyPreflight'];
}
export type { FileRootStatus } from './TrackedRootCatalog.js';
export type { FuseTrackedFile, NativePublicationAction, NativePublicationCompletionProof, NativeSourceIngestResult, NativeSourceOperationInput } from './NativeSourceOperations.js';

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
  private readonly publicationLifecyclePolicy: PublicationLifecyclePolicy;
  private readonly collectionPolicyRepository: CollectionPolicyRepository;
  private collectionId?:  string;
  private stopped = false;
  private running?:       Promise<unknown>;
  private paused:         boolean;
  private lastError?:     string;
  private syncTimer?:     NodeJS.Timeout;
  readonly mutations: FilesMutationCoordinator;
  private readonly rootCollections = new Map<string, string>();
  private readonly rootMutations = new Map<string, FilesMutationCoordinator>();
  private readonly roots:FileRootConfig[];
  private readonly nativeSources:NativeSourceOperations;
  private readonly progress = new ScanProgress();
  private readonly rootRepository:FileRootRepository;
  private readonly catalog:TrackedRootCatalog;
  private readonly recovery:PathOperationRecovery;
  private readonly trashExpiry:TrashReceiptExpiry;
  private readonly puller:ReplicationPuller;
  private readonly legacySync:LegacyFolderSync;
  private readonly publisher:NativePathOperationPublisher;
  private readonly ingestor:WatchedFileIngestor;
  private readonly scanner:NativeRootScanner;
  private nativeJournalInstance?:NativeOperationJournal;
  private get nativeJournal():NativeOperationJournal { return this.nativeJournalInstance ??= new NativeOperationJournal(this.db,async(collectionId) => {
    const row=(await this.db.query('SELECT * FROM file_roots WHERE collection_id=$1',[collectionId])).rows[0];
    const hasNativeCustody=async() => Boolean((await this.db.query('SELECT 1 FROM watched_folder_state WHERE collection_id=$1 LIMIT 1',[collectionId])).rowCount);
    if (!row) {
      if (await hasNativeCustody()) throw new Error('Tracked root is missing');
      return null;
    }
    // Detach explicitly relinquishes native custody. Keep the row as audit
    // history, but do not let an obsolete root turn ordinary Files database
    // operations into native publication attempts.
    if (!row.enabled || row.state==='detached') return null;
    // A Desktop-brokered root lives on the host; this container has no path to it (attachBrokeredRoot
    // never adds it to this.roots), so there is no container-side native root to check or publish to.
    // Desktop owns the host-side effects. Without this every rename/move in the home collection failed
    // closed with 'Tracked root is unavailable'.
    if (typeof row.mount_path==='string' && row.mount_path.startsWith('/brokered/')) return null;
    const root=this.roots.find(root=>root.id===row.id);
    if (!root || row.state==='offline' || root.path!==row.mount_path || this.rootCollections.get(root.id)!==collectionId) {
      if (await hasNativeCustody()) throw new Error('Tracked root is unavailable');
      return null;
    }
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

  expireTrashReceipts(now=new Date()):Promise<{invalidated:number;disposed:number;preserved:number}> {
    return this.serial(() => this.trashExpiry.expire(now));
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

  /** store: the process-wide chunk store, so reads of evicted chunks hydrate through the chunk cache. */
  constructor(private readonly db:pg.Pool, private readonly config:Config, private readonly indexer?:IndexingQueue, mutations?:FilesMutationCoordinator, store?:Store, publicationLifecyclePolicy?:PublicationLifecyclePolicy, collectionPolicyRepository?:CollectionPolicyRepository) {
    this.store = store ?? new Store(config.chunkRoot);
    this.publicationLifecyclePolicy = publicationLifecyclePolicy ?? new PublicationLifecyclePolicy();
    this.collectionPolicyRepository = collectionPolicyRepository ?? new CollectionPolicyRepository(); this.paused = config.paused;
    this.roots = (config.fileRoots ?? (config.filesRoot ? [{ id: 'default', name: 'Sulla Files', path: config.filesRoot, syncMode: config.serverUrl ? 'server' : 'local', paused: config.paused, exclusions: [], primary: true }] : []))
      .filter(root => !TrackedPathFilter.isSensitive(root.path));
    this.mutations = mutations ?? new FilesMutationCoordinator(config.filesRoot ?? config.dataRoot);
    for (const root of this.roots) this.rootMutations.set(root.id, root.primary ? this.mutations : new FilesMutationCoordinator(root.path));
    this.rootRepository = new FileRootRepository(db);
    const pathOperations = new PathOperationRepository(db);
    this.recovery = new PathOperationRecovery(pathOperations, this.mutations, this.rootMutations, () => this.nativeJournal);
    this.trashExpiry = new TrashReceiptExpiry(pathOperations, new TransactionRunner(db), () => this.nativeJournal);
    const transactions = new TransactionRunner(db); const remote = new RemoteFilesClient(config); const rootFor = (collectionId:string) => this.rootForCollection(collectionId);
    const purges = new RemotePurgeApplier(new RemotePurgeRepository(db), pathOperations, this.recovery, transactions, this.rootMutations, rootFor, () => this.nativeJournal);
    this.puller = new ReplicationPuller(db, config, this.store, remote, new ReplicationRepository(db), purges, transactions, this.collectionPolicyRepository, this.publicationLifecyclePolicy, rootFor, indexer);
    this.publisher = new NativePathOperationPublisher(config, this.rootCollections, new PathOperationPublishRepository(db), this.recovery, transactions, { afterPublish: async() => {
      this.indexer?.wake();
      await this.scanFolder();
      if (!this.paused) await this.syncNow();
    } });
    this.legacySync = new LegacyFolderSync(db, config, this.store, this.roots, this.rootCollections, this.progress, remote, new LegacySyncRepository(db), this.puller, transactions,
      this.collectionPolicyRepository, { homeCollectionId: () => this.collectionId, rootFor });
    this.catalog = new TrackedRootCatalog(db, config, this.roots, this.rootCollections, this.rootRepository);
    this.ingestor = new WatchedFileIngestor(db, config, this.store, indexer);
    this.scanner = new NativeRootScanner(config, this.roots, this.rootCollections, new WatchedFolderRepository(db), this.ingestor, this.progress);
    this.nativeSources = new NativeSourceOperations(db, { serial: operation => this.serial(operation), fuseRow: fileId => this.fuseRow(fileId) });
  }

  async initialize(beforeScan?:()=>Promise<void>):Promise<void> {
    this.stopped = false;
    await mkdir(this.config.dataRoot, { recursive: true, mode: 0o700 });
    await mkdir(this.config.chunkRoot, { recursive: true, mode: 0o700 });
    if (!this.config.filesRoot) {
      this.collectionId = await this.ensureCollection({
        id: 'default', name: 'Sulla Files', path: '', syncMode: this.config.serverUrl ? 'server' : 'local', paused: false, exclusions: [], primary: true,
      });
      await this.catalog.detachAll();
      await this.reconcileNativeSourceOperations();
      await beforeScan?.();
      return;
    }
    for (const root of this.roots) await mkdir(root.path, { recursive: true, mode: 0o700 });
    for (const root of this.roots) await assertSeparateStorageRoots(root.path, this.config.dataRoot, this.config.chunkRoot);
    const primaryCollection = await this.catalog.registerConfigured();
    if (primaryCollection) this.collectionId = primaryCollection;
    await this.recoverPathOperations();
    await this.reconcileNativeSourceOperations();
    await beforeScan?.();
    const saved = await this.rootRepository.savedRuntimeState();
    if (saved) { this.paused ||= saved.paused; this.lastError = saved.last_error as string | undefined; this.progress.lastScanAt = (saved.last_scan_at as any)?.toISOString?.(); this.progress.lastSyncAt = (saved.last_sync_at as any)?.toISOString?.() }
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
    const progress = this.progress;
    return { state: this.paused ? 'paused' : this.lastError ? 'error' : this.running ? 'syncing' : 'synced', pendingFiles: progress.pendingFiles, pendingBytes: progress.pendingBytes, processedBytes: progress.processedBytes, totalBytes: progress.totalBytes, estimatedSeconds: progress.estimatedSeconds(Boolean(this.running)), lastError: this.lastError, lastScanAt: progress.lastScanAt, lastSyncAt: progress.lastSyncAt, serverConfigured: Boolean(this.config.serverUrl), legacyImport: this.config.legacyPreflight };
  }

  async nativeCollectionId():Promise<string> {
    this.collectionId ??= await this.ensureCollection({
      id: 'default', name: 'Sulla Files', path: '', syncMode: this.config.serverUrl ? 'server' : 'local', paused: false, exclusions: [], primary: true,
    });
    return this.collectionId;
  }

  ingestNativeSource(input:NativeSourceOperationInput, ingest:(client:pg.PoolClient, versionId:string)=>Promise<NativeSourceIngestResult>):Promise<NativeSourceIngestResult> {
    return this.nativeSources.ingest(input, ingest);
  }
  planNativePublication(input:NativeSourceOperationInput & { fileId:string; baseVersionId:string }):Promise<void> { return this.nativeSources.planPublication(input) }
  finishNativePublication(operationId:string, proof?:NativePublicationCompletionProof, error?:string):Promise<void> { return this.nativeSources.finishPublication(operationId, proof, error) }
  reselectInterruptedNativePublication(input:{ fileId:string; previousHandle:string; handle:string; sourceRevision:string; sourceHash:string }):Promise<boolean> {
    return this.nativeSources.reselectInterruptedPublication(input);
  }
  finishNativePublicationConflict(operationId:string, input:{ conflictFileId:string; currentSourceRevision:string; currentSourceHash:string; currentFilesVersionId:string }):Promise<void> {
    return this.nativeSources.finishPublicationConflict(operationId, input);
  }
  nativePublicationActions():Promise<NativePublicationAction[]> { return this.nativeSources.publicationActions() }

  /** Keyset-paginated native source inventory; see queryNativeSourcePage. */
  async listNativeSources(page:NativeSourcePage = {}):Promise<NativeSourcePageRow[]> {
    return queryNativeSourcePage(this.db, page);
  }
  revalidateNativeSessions(handles:string[], replaceExisting = true):Promise<void> { return this.nativeSources.revalidateSessions(handles, replaceExisting) }

  fuseWriteNative(
    fileId:string, expectedVersionId:string, expectedSourceHash:string, bytes:Buffer, actor:FilesIdentity,
    ingest:(client:pg.PoolClient, versionId:string, current:FuseTrackedFile)=>Promise<NativeSourceIngestResult>,
    preserveConflict:(client:pg.PoolClient, versionId:string, current:FuseTrackedFile)=>Promise<NativeSourceIngestResult>,
  ):Promise<FuseTrackedFile> {
    return this.nativeSources.fuseWrite(fileId, expectedVersionId, expectedSourceHash, bytes, actor, ingest, preserveConflict);
  }

  private reconcileNativeSourceOperations():Promise<void> { return this.nativeSources.reconcileAfterRestart() }

  listRoots():Promise<FileRootStatus[]> { return this.catalog.list() }

  /** Register a Desktop-brokered host root without exposing its host path to the container. */
  async attachBrokeredRoot(input:BrokeredRootInput):Promise<FileRootStatus> {
    const { root, collectionId } = await this.catalog.attachBrokered(input);
    if (input.id === 'default') this.collectionId = collectionId;
    return root;
  }

  brokeredScanState(id:string, input:{ state:'scanning'|'idle'|'error'; pendingFiles?:number; lastError?:string }):Promise<FileRootStatus> { return this.catalog.brokeredScanState(id, input) }

  /** Experimental Files mount view over watched roots and indexed native sources. */
  async fuseSnapshot(collectionId:string):Promise<FuseTrackedFile[]> {
    const root = this.roots.find(candidate => this.rootCollections.get(candidate.id) === collectionId);
    if (root) await this.serial(() => this.scanRoot(root));
    const params:any[] = [collectionId, root?.id ?? null];
    const rows = await this.db.query(`SELECT f.id::text,f.collection_id::text,f.path,f.mime,f.size,f.current_version_id::text AS version_id,
      COALESCE(n.source_hash,c.content_hash,w.content_hash) AS content_hash,
      COALESCE(EXTRACT(EPOCH FROM n.updated_at)*1000,EXTRACT(EPOCH FROM c.created_at)*1000,w.mtime_ms) AS mtime_ms
      FROM files f
      LEFT JOIN files_native_sources n ON n.file_id=f.id AND n.state IN('active','conflict')
      LEFT JOIN files_native_conflicts c ON c.file_id=f.id
      LEFT JOIN watched_folder_state w ON w.file_id=f.id AND w.collection_id=f.collection_id
      WHERE f.collection_id=$1 AND f.deleted_at IS NULL AND (n.file_id IS NOT NULL OR c.file_id IS NOT NULL OR ($2::text IS NOT NULL AND w.root_id=$2))
        AND NOT EXISTS(SELECT 1 FROM files_protected_files p WHERE p.file_id=f.id) ORDER BY f.path`, params);
    return rows.rows.filter(row => !isProtectedPath(row.path)).map(row => ({
      id: row.id, collectionId: row.collection_id, path: row.path, mime: row.mime,
      size: Number(row.size), versionId: row.version_id, sourceHash: row.content_hash, mtimeMs: Number(row.mtime_ms),
    }));
  }

  async fuseRead(fileId:string):Promise<{ file:FuseTrackedFile; bytes:Buffer }> {
    const row = await this.fuseRow(fileId);
    if (row.native || row.storedNativeConflict) return { file: row, bytes: await this.readStoredVersion(fileId, row.versionId) };
    const root = this.rootForCollection(row.collectionId);
    const pinned = await this.rootMutations.get(root.id)!.pinVerified(row.path, file => this.verifyHash(file, row.sourceHash));
    try {
      const chunks:Buffer[] = [];
      for await (const chunk of pinned.createReadStream()) chunks.push(Buffer.from(chunk));
      await pinned.assertUnchanged();
      return { file: row, bytes: Buffer.concat(chunks) };
    } finally { await pinned.close() }
  }

  async fuseWrite(fileId:string, expectedVersionId:string, expectedSourceHash:string, bytes:Buffer, actor:FilesIdentity):Promise<FuseTrackedFile & { conflictPath?:string }> {
    const initial = await this.fuseRow(fileId);
    if (initial.native) throw Object.assign(new Error('Native source writes require the Electron publication transaction'), { status: 409, code: 'NATIVE_PUBLICATION_REQUIRED' });
    if (initial.storedNativeConflict) throw Object.assign(new Error('Files-only native conflict entries are read-only in the experimental mount'), { status: 409 });
    const root = this.rootForCollection(initial.collectionId);
    const mutations = this.rootMutations.get(root.id)!;
    const operationId = randomUUID();
    const stagedPath = `.sulla-trash/.operations/${ operationId }/${ basename(initial.path) }.write`;
    const backupPath = `.sulla-trash/.operations/${ operationId }/${ basename(initial.path) }.source`;
    const conflict = TrackedPathFilter.conflictPath(initial.path, `${ actor.deviceId || 'fuse' }-${ operationId.slice(0, 8) }`);
    const desiredHash = createHash('sha256').update(bytes).digest('hex');
    return this.serial(() => mutations.runExclusive([initial.path, stagedPath, backupPath, conflict], async() => {
      const current = await this.fuseRow(fileId);
      if (current.versionId !== expectedVersionId || current.sourceHash !== expectedSourceHash) {
        if (desiredHash === expectedSourceHash) {
          throw Object.assign(new Error('Tracked source changed before the no-op FUSE write was verified; no source bytes were replaced'), { status: 409 });
        }
        const output = await mutations.openPrivateExclusive(stagedPath);
        try {
          let offset = 0;
          while (offset < bytes.byteLength) {
            const result = await output.write(bytes, offset);
            if (!result.bytesWritten) throw new Error('FUSE staging made no write progress');
            offset += result.bytesWritten;
          }
          await output.sync();
        } finally { await output.close() }
        const publication = await mutations.publishVerified({ staged: stagedPath, target: conflict, verify: file => this.verifyHash(file, desiredHash) });
        await mutations.finalizePublication(publication);
        await this.scanRoot(root);
        throw Object.assign(new Error('Tracked source changed before the FUSE write was committed; the agent edit was preserved as a conflict'), { status: 409, conflictPath: conflict });
      }
      const verifyExpected = (file:PinnedRegularFile) => this.verifyHash(file, expectedSourceHash);
      if (desiredHash === expectedSourceHash) {
        const unchanged = await mutations.pinVerified(current.path, verifyExpected);
        try { await unchanged.assertUnchanged() } finally { await unchanged.close() }
        return current;
      }
      const output = await mutations.openPrivateExclusive(stagedPath);
      try {
        let offset = 0;
        while (offset < bytes.byteLength) {
          const result = await output.write(bytes, offset);
          if (!result.bytesWritten) throw new Error('FUSE staging made no write progress');
          offset += result.bytesWritten;
        }
        await output.sync();
      } finally { await output.close() }
      const verifyDesired = (file:PinnedRegularFile) => this.verifyHash(file, desiredHash);
      let receipt:ReplacementReceipt | undefined;
      try {
        receipt = await mutations.replaceVerified({ staged: stagedPath, target: current.path, backup: backupPath, conflict, verifyStaged: verifyDesired, verifyTarget: verifyExpected });
      } catch (error) {
        if (await mutations.exists(stagedPath).catch(() => false)) {
          const publication = await mutations.publishVerified({ staged: stagedPath, target: conflict, verify: verifyDesired });
          await mutations.finalizePublication(publication);
        }
        await this.scanRoot(root);
        throw Object.assign(new Error('Tracked source changed during the FUSE write; the agent edit was preserved as a conflict'), { status: 409, conflictPath: conflict, cause: error });
      }
      try {
        await this.scanRoot(root);
        const committed = await this.fuseRow(fileId);
        if (committed.sourceHash !== desiredHash || committed.versionId === expectedVersionId) throw new Error('Files ingestion did not durably record the replacement');
        await mutations.finalizeReplacement(receipt);
        return committed;
      } catch (error) {
        let preserved = false;
        try { await mutations.preserveReplacement(receipt, conflict, verifyDesired); preserved = true } catch { /* Keep both private recovery and current path; never overwrite after failed preservation. */ }
        await this.scanRoot(root).catch(() => undefined);
        throw Object.assign(new Error(preserved
          ? 'Files could not durably ingest the FUSE write; agent and prior-source bytes were retained for recovery'
          : 'Files could not durably ingest the FUSE write; automatic recovery stopped without overwriting the current path'), { status: 503, ...(preserved ? { conflictPath: conflict } : {}), cause: error });
      }
    }));
  }

  async fuseRow(fileId:string):Promise<FuseTrackedFile & { native?:boolean; storedNativeConflict?:boolean; sourceRevision?:string; sourceHandle?:string }> {
    const result = await this.db.query(`SELECT f.id::text,f.collection_id::text,f.path,f.mime,f.size,f.current_version_id::text AS version_id,
      COALESCE(n.source_hash,c.content_hash,w.content_hash) AS content_hash,
      COALESCE(EXTRACT(EPOCH FROM n.updated_at)*1000,EXTRACT(EPOCH FROM c.created_at)*1000,w.mtime_ms) AS mtime_ms,
      w.root_id,n.source_handle,n.source_revision,c.file_id AS native_conflict_file_id FROM files f
      LEFT JOIN files_native_sources n ON n.file_id=f.id AND n.state IN('active','conflict')
      LEFT JOIN files_native_conflicts c ON c.file_id=f.id
      LEFT JOIN watched_folder_state w ON w.file_id=f.id AND w.collection_id=f.collection_id
      WHERE f.id=$1 AND f.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM files_protected_files p WHERE p.file_id=f.id)`, [fileId]);
    const row = result.rows[0];
    if (!row || isProtectedPath(row.path)) throw Object.assign(new Error('Tracked file is unavailable'), { status: 404 });
    if (row.source_handle) return { id: row.id, collectionId: row.collection_id, path: row.path, mime: row.mime, size: Number(row.size), versionId: row.version_id, sourceHash: row.content_hash, mtimeMs: Number(row.mtime_ms), native: true, sourceRevision: row.source_revision, sourceHandle: row.source_handle };
    if (row.native_conflict_file_id) return { id: row.id, collectionId: row.collection_id, path: row.path, mime: row.mime, size: Number(row.size), versionId: row.version_id, sourceHash: row.content_hash, mtimeMs: Number(row.mtime_ms), storedNativeConflict: true };
    const root = this.rootForCollection(row.collection_id);
    if (row.root_id !== root.id) throw Object.assign(new Error('Tracked file is not watched by its configured Files root'), { status: 409 });
    return { id: row.id, collectionId: row.collection_id, path: row.path, mime: row.mime, size: Number(row.size), versionId: row.version_id, sourceHash: row.content_hash, mtimeMs: Number(row.mtime_ms) };
  }

  async readStoredVersion(fileId:string, versionId:string):Promise<Buffer> {
    const row = (await this.db.query(`SELECT v.chunk_collection_id,v.size,m.chunk_ids FROM file_versions v
      JOIN manifests m ON m.hash=v.manifest_hash WHERE v.id=$1 AND v.file_id=$2`, [versionId, fileId])).rows[0];
    if (!row || Number(row.size) > 64 * 1024 * 1024) throw Object.assign(new Error('Files version is unavailable or exceeds the native source bound'), { status: 413 });
    const keys = await this.config.keyring!.keys(row.chunk_collection_id);
    const chunks:Buffer[] = [];
    for (const id of row.chunk_ids as string[]) chunks.push(Buffer.from(await decryptChunk(await this.store.get(row.chunk_collection_id, id), keys.data, id)));
    const bytes = Buffer.concat(chunks).subarray(0, Number(row.size));
    if (bytes.byteLength !== Number(row.size)) throw new Error('Files version length does not match its manifest');
    return bytes;
  }

  private async verifyHash(file:PinnedRegularFile, expected:string):Promise<void> {
    const hash = createHash('sha256');
    for await (const chunk of file.createReadStream()) hash.update(chunk);
    if (hash.digest('hex') !== expected) throw Object.assign(new Error('Tracked source hash changed'), { status: 409 });
  }

  configureRoot(id:string, input:{ paused?:boolean; syncMode?:'local' | 'server'; exclusions?:string[] }):Promise<FileRootStatus> {
    return this.catalog.configure(id, input, () => this.rescan());
  }

  detachRoot(id:string):Promise<void> { return this.catalog.detach(id) }

  async recent(limit:number, exactPath?:string):Promise<any[]> {
    const result = await this.db.query(`SELECT f.id,f.path,f.mime,f.size,f.updated_at,(f.path ILIKE '%conflicted copy%') AS conflict,m.duration_seconds,r.state AS residency_state
      FROM files f
      LEFT JOIN recording_metadata m ON m.file_id=f.id
      LEFT JOIN file_residency r ON r.file_id=f.id
      WHERE NOT EXISTS(SELECT 1 FROM files_protected_files p WHERE p.file_id=f.id) AND f.deleted_at IS NULL AND ($1::text IS NULL OR f.path=$1) ORDER BY f.updated_at DESC LIMIT $2`, [exactPath ?? null, Math.max(1, Math.min(Number.isFinite(limit) ? limit : 4, 100))]);
    const syncState = this.status().state;
    return result.rows.filter(row => !isProtectedPath(row.path)).map(row => ({ id: row.id, path: row.path, mime: row.mime, size: Number(row.size), updatedAt: row.updated_at, conflict: row.conflict, durationSeconds: row.duration_seconds == null ? undefined : Number(row.duration_seconds), syncState: row.residency_state === 'online-only' ? 'online-only' : syncState === 'error' ? 'error' : syncState === 'syncing' ? 'syncing' : 'synced' }));
  }

  async setPaused(paused:boolean):Promise<RuntimeState> {
    this.paused = paused; await this.rootRepository.setRuntimePaused(paused);
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

  async applyPathOperations(action:'move' | 'copy', items:PathOperationItem[], actor:FilesIdentity):Promise<void> {
    const fileId = items[0]?.fileSnapshots[0]?.id;
    const collectionId = fileId ? await this.publisher.collectionOf(fileId) : undefined;
    const root = this.roots.find(item => this.rootCollections.get(item.id) === collectionId);
    if (!root) throw Object.assign(new Error('The watched Files root is unavailable'), { status: 409 });
    const paths = items.flatMap(item => [item.sourcePath, item.targetPath]);
    const mutations = this.rootMutations.get(root.id)!;
    return this.serial(() => mutations.runExclusive(paths, () => this.applyPathOperationsNow(action, items, actor, root, mutations)));
  }

  private applyPathOperationsNow(action:'move' | 'copy', items:PathOperationItem[], actor:FilesIdentity, root:FileRootConfig, mutations:FilesMutationCoordinator):Promise<void> {
    return this.publisher.publish(action, items, actor, root, mutations);
  }

  /** Reconcile durable native publications before the watcher can infer changes. */
  recoverPathOperations():Promise<void> { return this.recovery.recoverAll() }

  private recoverRemotePurgeOperation(input:PathOperationRow):Promise<void> { return this.recovery.recoverRemotePurge(input) }

  private verifyOperationPinned(pinned:PinnedRegularFile, expectedHash:string):Promise<void> { return this.recovery.verifyPinned(pinned, expectedHash) }

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

  private fail(error:unknown):void { this.lastError = error instanceof Error ? error.message : String(error); this.rootRepository.markRuntimeError(this.lastError).catch(dbError => console.error('[SullaFiles] failed to record runtime error', dbError)) }

  private ensureCollection(root:FileRootConfig):Promise<string> { return this.catalog.ensureCollection(root) }

  private safe(relativePath:string, root = this.roots.find(item => item.primary)!):string { return TrackedPathFilter.inside(root, relativePath) }
  private rootForCollection(collectionId:string):FileRootConfig {
    const root = this.roots.find(candidate => this.rootCollections.get(candidate.id) === collectionId);
    if (!root) throw Object.assign(new Error('Collection is not mapped to a configured Files root'), { status: 404 });
    return root;
  }

  private scanFolder():Promise<void> { return this.scanner.scanAll() }
  private scanRoot(root:FileRootConfig):Promise<void> { return this.scanner.scanRoot(root) }
  private ingest(root:FileRootConfig, collectionId:string, filePath:string, mtimeMs:number, old:WatchedRow | undefined, missing:Map<string, WatchedRow>):Promise<boolean> {
    return this.ingestor.ingest(root, collectionId, filePath, mtimeMs, old, missing);
  }

  private syncNow():Promise<void> { return this.legacySync.syncNow() }
  private pull(entry:any):Promise<void> { return this.puller.pull(entry) }
}
