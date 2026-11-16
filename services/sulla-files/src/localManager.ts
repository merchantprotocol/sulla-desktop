// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { TransactionRunner } from './FilesTransaction.js';

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, realpath } from 'node:fs/promises';
import { basename, sep } from 'node:path';

import { decryptChunk } from './crypto.js';
import { CloudRenameSuccessor } from './Repositories/CloudRenameSuccessor.js';
import { copyLockedFile } from './fileOperations.js';
import { isProtectedPath } from './protectedFiles.js';
import { PublicationLifecyclePolicy } from './publicationLifecyclePolicy.js';
import { CollectionPolicyRepository } from './Repositories/CollectionPolicyRepository.js';
import { FilesMutationCoordinator } from './safeFilesystem.js';
import { NativeOperationJournal } from './nativeOperationJournal.js';
import { queryNativeSourcePage, type NativeSourcePage, type NativeSourcePageRow } from './nativeSourcePaging.js';
import { streamFileContent } from './fileStream.js';
import type { DatabaseOperationAccess } from './databaseOperations.js';
import { Store } from './store.js';
import { assertStoredFilePath, assertStoredFolderPath, ensureStoredFileParents, ensureStoredFolder, lockStoredNamespace } from './storedNamespace.js';

import type { FilesIdentity } from './auth.js';
import type { Config, FileRootConfig } from './config.js';
import type { IndexingQueue } from './indexing.js';
import type { OriginalRevealTarget } from './originalReveal.js';
import type { EvictionReceipt, PinnedRegularFile, PublicationReceipt, ReplacementReceipt } from './safeFilesystem.js';
import type pg from 'pg';
import { NativeRootScanner } from './NativeRootScanner.js';
import { WatchedFolderRepository, type WatchedRow } from './Repositories/WatchedFolderRepository.js';
import { ScanProgress } from './ScanProgress.js';
import { TrackedPathFilter } from './TrackedPathFilter.js';
import { PathOperationRecovery } from './PathOperationRecovery.js';
import { PathOperationRepository } from './Repositories/PathOperationRepository.js';
import { TrashReceiptExpiry } from './TrashReceiptExpiry.js';
import { LegacyFolderSync } from './LegacyFolderSync.js';
import { RemoteFilesClient } from './RemoteFilesClient.js';
import { RemotePurgeApplier } from './RemotePurgeApplier.js';
import { ReplicationPuller } from './ReplicationPuller.js';
import { LegacySyncRepository } from './Repositories/LegacySyncRepository.js';
import { RemotePurgeRepository } from './Repositories/RemotePurgeRepository.js';
import { ReplicationRepository } from './Repositories/ReplicationRepository.js';
import { OperationFingerprint, type PathOperationPlanEntry, type PathOperationRow } from './PathOperationPlan.js';
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
    let intentCreated = false; let commitAttempted = false;
    const runner=new TransactionRunner(this.db);
    try {
      const {lockedRows,storedFolders,plan}=await runner.run('path-operation-plan',async client=>{
      await lockStoredNamespace(client, collectionId);
      const lockedRows:any[][] = [];
      const storedFolders:{ sourcePath:string; targetPath:string }[] = [];
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
          await assertStoredFilePath(client, collectionId, nextPath);
        }
        if (item.folder) {
          const folders = await client.query(`SELECT path FROM file_folders WHERE collection_id=$1 AND (path=$2 OR starts_with(path,$2||'/')) ORDER BY path FOR UPDATE`, [collectionId, item.sourcePath]);
          for (const folder of folders.rows) storedFolders.push({ sourcePath: folder.path, targetPath: `${ item.targetPath }${ folder.path.slice(item.sourcePath.length) }` });
          await assertStoredFolderPath(client, collectionId, item.targetPath);
          const occupied = await client.query('SELECT 1 FROM file_folders WHERE collection_id=$1 AND path=$2 LIMIT 1', [collectionId, item.targetPath]);
          if (occupied.rowCount) throw Object.assign(new Error(`A folder already exists at ${ item.targetPath }`), { status: 409 });
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
      await client.query(
        `INSERT INTO files_path_operations(operation_id,action,state,plan) VALUES($1,$2,'planned',$3::jsonb)`,
        [operationId, action, JSON.stringify(plan)],
      );
      return {lockedRows,storedFolders,plan}; });
      durablePlan=plan; intentCreated = true;
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
              fingerprint: OperationFingerprint.serialize(completed.at(-1)!.publication.fingerprint),
            }])],
          );
        }
      }
      await runner.run('path-operation-commit',async client=>{
      await lockStoredNamespace(client,collectionId);
      // Locks were intentionally released while filesystem copying/fsync ran. Revalidate
      // every source and destination before attaching the durable publications to metadata.
      for(const [index,item] of items.entries()){
        const expected=lockedRows[index];
        const current=(await client.query(`SELECT f.id,f.path,f.current_version_id,w.content_hash FROM files f
          JOIN watched_folder_state w ON w.file_id=f.id AND w.collection_id=f.collection_id
          WHERE f.id=ANY($1::uuid[]) AND f.collection_id=$2 AND f.deleted_at IS NULL
          AND NOT EXISTS(SELECT 1 FROM files_protected_files p WHERE p.file_id=f.id) FOR UPDATE OF f,w`,[expected.map(row=>row.id),collectionId])).rows;
        if(current.length!==expected.length||expected.some(row=>!current.some(now=>now.id===row.id&&now.path===row.path&&now.current_version_id===row.current_version_id&&now.content_hash===row.content_hash)))
          throw Object.assign(new Error('Source changed while preparing filesystem publication; preserved copies will be reconciled'),{status:409});
        for(const row of expected)await assertStoredFilePath(client,collectionId,`${item.targetPath}${row.watched_path.slice(item.sourcePath.length)}`);
        if(item.folder){
          const original=storedFolders.filter(folder=>folder.sourcePath===item.sourcePath||folder.sourcePath.startsWith(`${item.sourcePath}/`));
          // Bounded at one past the planned count: any extra folder already fails the equality check below.
          const folders=(await client.query(`SELECT path FROM file_folders WHERE collection_id=$1 AND (path=$2 OR starts_with(path,$2||'/')) ORDER BY path LIMIT $3 FOR UPDATE`,[collectionId,item.sourcePath,original.length+1])).rows;
          if(folders.length!==original.length||folders.some(folder=>!original.some(old=>old.sourcePath===folder.path)))throw Object.assign(new Error('Folder changed during publication'),{status:409});
          await assertStoredFolderPath(client,collectionId,item.targetPath);
          if((await client.query('SELECT 1 FROM file_folders WHERE collection_id=$1 AND path=$2',[collectionId,item.targetPath])).rowCount)throw Object.assign(new Error('Destination folder appeared during publication'),{status:409});
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
            const parentFollows = item.folder && row.watched_path.startsWith(`${ item.sourcePath }/`);
            const versionId = await new CloudRenameSuccessor(actor).versionFor(client, { fileId: row.id, currentVersionId: row.current_version_id, parentFollows });
            await client.query("INSERT INTO journal(collection_id,file_id,version_id,op) VALUES($1,$2,$3,'rename')", [collectionId, row.id, versionId]);
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
        }
      }
      if (action === 'copy') {
        for (const folder of storedFolders) await ensureStoredFolder(client, collectionId, folder.targetPath, actor);
      } else {
        for (const folder of [...storedFolders].sort((left, right) => right.sourcePath.length - left.sourcePath.length)) {
          await client.query('UPDATE file_folders SET path=$3,updated_at=NOW() WHERE collection_id=$1 AND path=$2', [collectionId, folder.sourcePath, folder.targetPath]);
        }
        for (const folder of storedFolders) await ensureStoredFolder(client, collectionId, folder.targetPath, actor);
      }
      for (const [index, item] of items.entries()) {
        for (const row of lockedRows[index]) await ensureStoredFileParents(client, collectionId, `${ item.targetPath }${ row.watched_path.slice(item.sourcePath.length) }`, actor);
      }
      await client.query("UPDATE files_path_operations SET state='db-committed',updated_at=NOW() WHERE operation_id=$1", [operationId]);
      commitAttempted = true;
      });
    } catch (error) {
      if (commitAttempted) {
        throw Object.assign(new Error(`The database commit outcome is being reconciled; published files were preserved: ${ error instanceof Error ? error.message : String(error) }`), { status: 503 });
      }
      const preservationErrors:string[] = [];
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
    }
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
