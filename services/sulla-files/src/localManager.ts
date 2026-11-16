// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { TransactionRunner } from './FilesTransaction.js';

import { mkdir, realpath } from 'node:fs/promises';
import { sep } from 'node:path';

import { isProtectedPath } from './protectedFiles.js';
import { PublicationLifecyclePolicy } from './publicationLifecyclePolicy.js';
import { CollectionPolicyRepository } from './Repositories/CollectionPolicyRepository.js';
import { FilesMutationCoordinator } from './safeFilesystem.js';
import type { NativeOperationJournal } from './nativeOperationJournal.js';
import { queryNativeSourcePage, type NativeSourcePage, type NativeSourcePageRow } from './nativeSourcePaging.js';
import type { DatabaseOperationAccess } from './databaseOperations.js';
import { Store } from './store.js';

import type { FilesIdentity } from './auth.js';
import type { Config, FileRootConfig } from './config.js';
import type { IndexingQueue } from './indexing.js';
import type { OriginalRevealTarget } from './originalReveal.js';
import type { PinnedRegularFile } from './safeFilesystem.js';
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
import { NativeCustody } from './NativeCustody.js';
import { TrackedFuseMount } from './TrackedFuseMount.js';
import { TrackedFileRepository } from './Repositories/TrackedFileRepository.js';
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
  private readonly files:TrackedFileRepository;
  private readonly custody:NativeCustody;
  private readonly mount:TrackedFuseMount;
  private readonly ingestor:WatchedFileIngestor;
  private readonly scanner:NativeRootScanner;
  private get nativeJournal():NativeOperationJournal { return this.custody.journal }

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
    return this.serial(() => this.custody.originalRevealTarget(file));
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
    this.files = new TrackedFileRepository(db);
    this.custody = new NativeCustody(db, config, this.store, this.roots, this.rootCollections, this.rootMutations, this.files, (pinned, hash) => this.recovery.verifyPinned(pinned, hash));
    this.mount = new TrackedFuseMount(config, this.store, this.files, this.rootMutations, { serial: operation => this.serial(operation), scanRoot: root => this.scanRoot(root),
      rootIn: collectionId => this.roots.find(candidate => this.rootCollections.get(candidate.id) === collectionId), rootFor: collectionId => this.rootForCollection(collectionId) });
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
  fuseSnapshot(collectionId:string):Promise<FuseTrackedFile[]> { return this.mount.snapshot(collectionId) }
  fuseRead(fileId:string):Promise<{ file:FuseTrackedFile; bytes:Buffer }> { return this.mount.read(fileId) }
  fuseWrite(fileId:string, expectedVersionId:string, expectedSourceHash:string, bytes:Buffer, actor:FilesIdentity):Promise<FuseTrackedFile & { conflictPath?:string }> {
    return this.mount.write(fileId, expectedVersionId, expectedSourceHash, bytes, actor);
  }
  fuseRow(fileId:string):Promise<FuseTrackedFile & { native?:boolean; storedNativeConflict?:boolean; sourceRevision?:string; sourceHandle?:string }> { return this.mount.row(fileId) }
  readStoredVersion(fileId:string, versionId:string):Promise<Buffer> { return this.mount.readStoredVersion(fileId, versionId) }

  configureRoot(id:string, input:{ paused?:boolean; syncMode?:'local' | 'server'; exclusions?:string[] }):Promise<FileRootStatus> {
    return this.catalog.configure(id, input, () => this.rescan());
  }

  detachRoot(id:string):Promise<void> { return this.catalog.detach(id) }

  async recent(limit:number, exactPath?:string):Promise<any[]> {
    const rows = await this.files.recent(exactPath ?? null, Math.max(1, Math.min(Number.isFinite(limit) ? limit : 4, 100)));
    const syncState = this.status().state;
    return rows.filter(row => !isProtectedPath(row.path)).map(row => ({ id: row.id, path: row.path, mime: row.mime, size: Number(row.size), updatedAt: row.updated_at, conflict: row.conflict, durationSeconds: row.duration_seconds == null ? undefined : Number(row.duration_seconds), syncState: row.residency_state === 'online-only' ? 'online-only' : syncState === 'error' ? 'error' : syncState === 'syncing' ? 'syncing' : 'synced' }));
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
      const watched = new Set(await this.files.watchedUnder(collectionId, item.sourcePath, item.folder));
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
