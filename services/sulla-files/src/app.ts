// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.


import express from 'express';

import { FileAuditWriter } from './fileAudit.js';

import { chunkId, decryptAndVerifyChunk, encryptChunk } from './crypto.js';
import { ContentReadFailureLog } from './ContentReadFailureLog.js';
import { ManifestChunkRegistry } from './ManifestChunkRegistry.js';
import { loadFileContent } from './preview.js';
import { registerResidencyRoutes } from './residencyHttp.js';
import { SharesService } from './shares.js';
import { CatalogSyncService } from './cloudRemote/catalogSync.js';
import { DesktopRequestSyncService } from './cloudRemote/desktopRequests.js';
import { Store } from './store.js';
import { PersonalBackupScheduler } from './backup/scheduler.js';
import { BackupRuntimeRequests } from './backup/runtime.js';
import { configuredVaultFilesKeyBundleAuthority } from './vaultKeyBundleAuthority.js';
import { registerDocumentLifecycleRoutes } from './documentLifecycle.js';
import { AutomergeSnapshotRetention } from './automergeSnapshotRetention.js';
import type { FilesLifecycle } from './lifecycle.js';

import type { Config } from './config.js';
import type { LocalFilesManager } from './localManager.js';
import type { FileResidencyManager } from './residency.js';
import type { IndexingQueue } from './indexing.js';
import type { FileSearch } from './search.js';
import type { CloudSyncService } from './cloudSync/service.js';
import { registerCloudSyncRoutes } from './cloudSync/routes.js';
import { DatabaseHealthRepository } from './Repositories/DatabaseHealthRepository.js';
import type pg from 'pg';
import { VersionContentStager } from './VersionContentStager.js';
import { FilesMetrics } from './FilesMetrics.js';
import { LocalManagerGate } from './Http/LocalManagerGate.js';
import { VersionWriter } from './Services/VersionWriter.js';
import { VersionWriteRepository } from './Repositories/VersionWriteRepository.js';
import { AutomergeDocumentRepository } from './Repositories/AutomergeDocumentRepository.js';
import { AutomergeTextStore } from './Services/AutomergeTextStore.js';
import { LiveTextCoordinator } from './Services/LiveTextCoordinator.js';
import { TextVersionMerger } from './Services/TextVersionMerger.js';
import { LiveTextRoutes } from './routes/LiveTextRoutes.js';
import { AuditEventRoutes } from './routes/AuditEventRoutes.js';
import { AuditSpoolRepository } from './Repositories/AuditSpoolRepository.js';
import { LocalSourceRoutes } from './routes/LocalSourceRoutes.js';
import { HomeSystemFileRepository } from './Repositories/HomeSystemFileRepository.js';
import { AgentWriteRoutes } from './routes/AgentWriteRoutes.js';
import { AgentWriteRepository } from './Repositories/AgentWriteRepository.js';
import { AgentKeepRoutes } from './routes/AgentKeepRoutes.js';
import { AgentKeepRepository } from './Repositories/AgentKeepRepository.js';
import { FuseFileRoutes } from './routes/FuseFileRoutes.js';
import { FuseContentRoutes } from './routes/FuseContentRoutes.js';
import { FuseMetadataRoutes } from './routes/FuseMetadataRoutes.js';
import { FuseWriteRepository } from './Repositories/FuseWriteRepository.js';
import { FileMetadataRepository } from './Repositories/FileMetadataRepository.js';
import { FileWriteRoutes } from './routes/FileWriteRoutes.js';
import { FileContentWriteRoutes } from './routes/FileContentWriteRoutes.js';
import { FileWriteRepository } from './Repositories/FileWriteRepository.js';
import { VersionRestoreRepository } from './Repositories/VersionRestoreRepository.js';
import { FileListingQuery } from './FileListingQuery.js';
import { FileListingRepository } from './Repositories/FileListingRepository.js';
import { FileListingRoutes } from './routes/FileListingRoutes.js';
import { ShareRoutes } from './routes/ShareRoutes.js';
import { OriginalRevealRoutes } from './routes/OriginalRevealRoutes.js';
import { CollectionSyncRoutes } from './routes/CollectionSyncRoutes.js';
import { OrgCollectionRoutes } from './routes/OrgCollectionRoutes.js';
import { OrgCollectionEnrollment } from './Services/OrgCollectionEnrollment.js';
import { OrgCollectionEnrollmentRepository } from './Repositories/OrgCollectionEnrollmentRepository.js';
import { CollectionSyncRepository } from './Repositories/CollectionSyncRepository.js';
import { TrashRoutes, type OperationAccessFactory } from './routes/TrashRoutes.js';
import { TrashListingRepository } from './Repositories/TrashListingRepository.js';
import { FolderGuidanceRoutes } from './routes/FolderGuidanceRoutes.js';
import { RequestAuditLog } from './Http/RequestAuditLog.js';
import { AuditLogRepository } from './Repositories/AuditLogRepository.js';
import { CollectionSettingsRepository } from './Repositories/CollectionSettingsRepository.js';
import { FolderGuidanceRepository } from './Repositories/FolderGuidanceRepository.js';
import { LocalMaintenanceRoutes } from './routes/LocalMaintenanceRoutes.js';
import { LocalRootRoutes } from './routes/LocalRootRoutes.js';
import { SearchRoutes } from './routes/SearchRoutes.js';
import { StarRoutes } from './routes/StarRoutes.js';
import { FileDetailRoutes } from './routes/FileDetailRoutes.js';
import { FileFeedRoutes } from './routes/FileFeedRoutes.js';
import { FileDetailRepository } from './Repositories/FileDetailRepository.js';
import { AgentFileRoutes } from './routes/AgentFileRoutes.js';
import { AgentFileRepository } from './Repositories/AgentFileRepository.js';
import { FuseReadRoutes } from './routes/FuseReadRoutes.js';
import { FuseTreeRepository } from './Repositories/FuseTreeRepository.js';
import { FuseTreeSnapshotCache } from './Services/FuseTreeSnapshotCache.js';
import { ChunkRoutes } from './routes/ChunkRoutes.js';
import { ChunkAccessRepository } from './Repositories/ChunkAccessRepository.js';
import { VersionSyncRoutes } from './routes/VersionSyncRoutes.js';
import { RemoteVersionSync } from './Services/RemoteVersionSync.js';
import { RemoteVersionRepository } from './Repositories/RemoteVersionRepository.js';
import { RemoteVersionBundleValidator } from './Services/RemoteVersionBundleValidator.js';
import { FileResolveRoutes } from './routes/FileResolveRoutes.js';
import { FileOperationRoutes } from './routes/FileOperationRoutes.js';
import { FileLocatorRepository } from './Repositories/FileLocatorRepository.js';
import { ScratchMaintenanceRepository } from './Repositories/ScratchMaintenanceRepository.js';
import { SearchScopeRepository } from './Repositories/SearchScopeRepository.js';
import { StarRepository } from './Repositories/StarRepository.js';
import { CollectionFilesFeed } from './CollectionFilesFeed.js';
import type { FilesIdentity } from './auth.js';
import type { FilesBootstrapAuthority } from './bootstrapAuthority.js';
import { DatabaseFailureClassifier, TransactionRunner } from './FilesTransaction.js';
import { FilesAccessGate, type RequestWithIdentity } from './Http/FilesAccessGate.js';
import { BackupDestinationOpener } from './backup/BackupDestinationOpener.js';
import { BackupDestinationRequestParser } from './backup/BackupDestinationRequestParser.js';
import { LocalBackupRoutes } from './routes/LocalBackupRoutes.js';
import { LocalBackupDestinationRepository } from './Repositories/LocalBackupDestinationRepository.js';
import { FilesRequestPipeline } from './Http/FilesRequestPipeline.js';
import { InFlightRequestTracker } from './Http/InFlightRequestTracker.js';
import { FilesErrorHandlers } from './Http/FilesErrorHandlers.js';
import { FilesBootstrapRoutes } from './routes/FilesBootstrapRoutes.js';
import { HealthRoutes } from './routes/HealthRoutes.js';
import { AutomergeSnapshotPruner } from './Services/AutomergeSnapshotPruner.js';

// search_text (450 MB) and search_vector (378 MB) must never be serialized to API responses or loaded into bulk result sets.
const FILE_COLUMNS_SQL = 'f.id,f.collection_id,f.path,f.current_version_id,f.deleted_at,f.expires_at,f.created_by_type,f.created_by_id,f.mime,f.size,f.created_at,f.updated_at,f.extracted_at,f.extraction_status,f.person_id,f.extraction_reason_code,f.extraction_reason,f.draft_version_id,f.published_version_id,f.versioning_enabled,f.major_minor_enabled,f.require_approval,f.require_checkout,f.checked_out_by_user_id,f.checked_out_by_device_id,f.checked_out_at,f.retention_mode,f.retain_until,f.retention_event_type,f.retention_event_at,f.retention_duration_days,f.record_lock_type,f.record_locked_at,f.record_locked_by,f.disposal_status,f.disposal_review_at,f.disposal_extended_until,f.lifecycle_generation,f.operation_revision';
const FILE_ROW_JSON_SQL = `row_to_json((SELECT x FROM (SELECT ${FILE_COLUMNS_SQL}) x))`;

/** Everything the Files HTTP API is composed from (built once by the process entry). */
export interface FilesApplicationDependencies {
  db:pg.Pool;
  config:Config;
  manager?:LocalFilesManager;
  search?:FileSearch;
  onUnlock?:()=>Promise<void>;
  onLock?:()=>Promise<void>;
  onRecover?:(master:Buffer)=>Promise<number>;
  residency?:FileResidencyManager;
  filesLifecycle?:FilesLifecycle;
  bootstrapAuthority?:FilesBootstrapAuthority;
  indexer?:IndexingQueue;
  chunkStore?:Store;
  cloudSync?:CloudSyncService;
  /** Drops the served principal's cached keys when Desktop signs out or locks. */
  profileCaches?:{ invalidateCurrent():void };
}

/** The request-independent services every route group shares, built once per app. */
interface FilesCore {
  store:Store;
  ready:() => boolean;
  metrics:FilesMetrics;
  transactions:TransactionRunner;
  databaseFailures:DatabaseFailureClassifier;
  contentReadFailures:ContentReadFailureLog;
  shares:SharesService;
  filesFeed:CollectionFilesFeed;
}

/** The access, audit and write services the route groups are built from. */
interface FilesRouteServices {
  accessGate:FilesAccessGate;
  requestAudit:RequestAuditLog;
  managers:LocalManagerGate;
  versionWriter:VersionWriter;
  automergeTexts:AutomergeTextStore;
  liveText:LiveTextCoordinator;
  textMerger:TextVersionMerger;
  originalReveal:OriginalRevealRoutes;
  actorScope:(actor:FilesIdentity) => string;
  operationAccess:OperationAccessFactory;
}

/**
 * Composition root of the Files HTTP API: builds the shared services once and mounts the
 * request pipeline, every route group (classes under routes/) and the error handlers in
 * their fixed order. Middleware order is load-bearing: auth before handlers, the ready gate
 * before file routes, error handlers last.
 */
export class FilesApplication {
  private readonly snapshotPruner:AutomergeSnapshotPruner;

  constructor(private readonly dependencies:FilesApplicationDependencies) {
    this.snapshotPruner = new AutomergeSnapshotPruner(AutomergeSnapshotRetention.fromEnvironment(dependencies.db));
  }

  build():express.Express {
    const app = express();
    const core = this.core(app);
    this.snapshotPruner.start();
    this.mountPipeline(app, core);
    registerCloudSyncRoutes(app, this.dependencies.config, this.dependencies.cloudSync);
    const services = this.routeServices(app, core);
    this.mountEarlyRoutes(app, core, services);
    this.mountBackups(app, core);
    this.mountFileRoutes(app, core, services);
    services.originalReveal.registerErrorHandler(app);
    new FilesErrorHandlers(core.databaseFailures).register(app);
    return app;
  }

  /** Stops the background work this application started (snapshot retention). */
  stop():void { this.snapshotPruner.stop() }

  private core(app:express.Express):FilesCore {
    const { db, config, filesLifecycle, chunkStore } = this.dependencies;
    const store = chunkStore ?? new Store(config.chunkRoot);
    const shares = new SharesService(db, config, store);
    const ready = () => filesLifecycle ? filesLifecycle.ready : Boolean(config.keyring?.unlocked);
    app.locals.catalogSync = new CatalogSyncService(db, config, ready);
    app.locals.desktopRequests = new DesktopRequestSyncService(db, config, store, shares);
    const metrics = new FilesMetrics();
    return { store, ready, shares, metrics, transactions: new TransactionRunner(db, undefined, undefined, undefined, undefined, undefined, metrics), databaseFailures: new DatabaseFailureClassifier(),
      contentReadFailures: new ContentReadFailureLog(), filesFeed: new CollectionFilesFeed(db, FILE_COLUMNS_SQL) };
  }

  /** In-flight tracking, bootstrap, body parsing, auth, FUSE actor, lock, ready gate, audit context, in that order. */
  private mountPipeline(app:express.Express, core:FilesCore):void {
    const { config, bootstrapAuthority, filesLifecycle, onLock } = this.dependencies;
    const inFlight = new InFlightRequestTracker();
    app.locals.inFlightRequests = inFlight.counts;
    const pipeline = new FilesRequestPipeline(config, core.ready);
    const bootstrap = new FilesBootstrapRoutes(config, bootstrapAuthority, filesLifecycle, onLock);
    app.disable('x-powered-by');
    app.use(inFlight.middleware);
    bootstrap.registerBootstrap(app);
    app.use(pipeline.json);
    app.use(pipeline.authenticate);
    app.use(pipeline.fuseActor);
    bootstrap.registerLock(app);
    app.use(pipeline.readyGate);
    app.use(pipeline.audit);
  }

  private routeServices(app:express.Express, core:FilesCore):FilesRouteServices {
    const { db, config, manager } = this.dependencies;
    const { store, transactions } = core;
    const contentStager = new VersionContentStager({ keys: id => config.keyring!.keys(id) }, store, { chunkId, encryptChunk, decryptAndVerifyChunk }, core.metrics);
    const accessGate = new FilesAccessGate(db);
    const requestAudit = new RequestAuditLog(accessGate, new AuditLogRepository(db), core.metrics);
    const managers = new LocalManagerGate(config, manager);
    const versionWriter = new VersionWriter(config, accessGate, store, contentStager, new ManifestChunkRegistry(), new VersionWriteRepository(),
      collectionId => this.dependencies.cloudSync?.versionCommitted(collectionId));
    const automergeDocuments = new AutomergeDocumentRepository(db); const automergeTexts = new AutomergeTextStore(automergeDocuments);
    const liveText = new LiveTextCoordinator(db, config, store, accessGate, transactions, versionWriter, automergeDocuments, automergeTexts, requestAudit);
    app.locals.liveTextSessions = liveText.sessions;
    const textMerger = new TextVersionMerger(automergeDocuments, automergeTexts, liveText.sessions, managers);
    const { requireCollection, requirePath, requireFile } = accessGate;
    const operationAccess:OperationAccessFactory = request => ({
      custody: manager?.operationCustody(),
      prepare: async(collectionId:string) => { await requireCollection(request, collectionId, 'edit') },
      file: (client:pg.PoolClient,id:string) => requireFile(request,id,'edit',client),
      path: async(client:pg.PoolClient,collectionId:string,path:string) => { await requirePath(request,collectionId,path,'edit',client) },
    });
    const actorScope = (actor:FilesIdentity):string => actor.jobId
      ? `job:${ actor.jobId }:agent:${ actor.agentId ?? '' }:thread:${ actor.threadId ?? '' }:device:${ actor.deviceId }`
      : `device:${ actor.deviceId || config.deviceId }`;
    return { accessGate, requestAudit, managers, versionWriter, automergeTexts, liveText, textMerger, operationAccess, actorScope,
      originalReveal: new OriginalRevealRoutes(config, accessGate, manager) };
  }

  /** Audit delivery, original reveal, residency, live text and health. */
  private mountEarlyRoutes(app:express.Express, core:FilesCore, services:FilesRouteServices):void {
    const { db, config, residency, filesLifecycle } = this.dependencies;
    const { store } = core; const { versionWriter, accessGate } = services;
    const auditWriter=new FileAuditWriter(db, async(id,versionId) => {
      const content=await loadFileContent(db,config,store,id,versionId);
      if (!content) throw new Error('Audit log content unavailable');
      return content.buffer;
    }, (collectionId,bytes) => versionWriter.stage(collectionId,bytes), (client,collectionId,path,bytes,staged,fileId) => versionWriter.insert(client,{collectionId,path,bytes,staged,fileId,mime:'application/x-ndjson',
      actor:{userId:config.userId,deviceId:config.deviceId,kind:'capability'},createdByType:'user',createdById:'sulla-files',message:'Append audit event'}));
    app.locals.auditWriter=auditWriter;
    new AuditEventRoutes(new AuditSpoolRepository(db), auditWriter).register(app);
    services.originalReveal.register(app);
    if (residency) registerResidencyRoutes(app, residency, async(request, fileId) => { await accessGate.requireFile(request as RequestWithIdentity, fileId, 'edit') });
    new LiveTextRoutes(accessGate, services.liveText).register(app);
    new HealthRoutes(config, core.ready, new DatabaseHealthRepository(db), filesLifecycle, core.metrics).register(app);
  }

  /** Desktop personal backups; the scheduler and runtime queue are started and stopped by the process. */
  private mountBackups(app:express.Express, core:FilesCore):void {
    const { db, config } = this.dependencies;
    const backupRuntime = new BackupRuntimeRequests();
    const opener = new BackupDestinationOpener(backupRuntime, configuredVaultFilesKeyBundleAuthority(config));
    const backupScheduler = new PersonalBackupScheduler(db, config, { ready: core.ready, open: (id, destination) => opener.open(id, destination) });
    app.locals.backupScheduler = backupScheduler;
    app.locals.backupRuntime = backupRuntime;
    new LocalBackupRoutes(config, new LocalBackupDestinationRepository(db), new BackupDestinationRequestParser(), backupRuntime, backupScheduler, core.transactions).register(app);
  }

  /** Every file, FUSE, agent and collection route group, in their original mount order. */
  private mountFileRoutes(app:express.Express, core:FilesCore, services:FilesRouteServices):void {
    const { db, config, manager, search, indexer } = this.dependencies;
    const { store, transactions, shares, contentReadFailures, databaseFailures } = core;
    const { accessGate, requestAudit, managers, versionWriter, automergeTexts, liveText, textMerger, operationAccess, actorScope } = services;
    new LocalSourceRoutes(db, config, accessGate, managers, versionWriter, transactions, new HomeSystemFileRepository(db), manager).register(app);
    const fuseWrites = new FuseWriteRepository(db);
    const fuseFiles = new FuseFileRoutes(db, accessGate, managers, versionWriter, transactions, fuseWrites, requestAudit, operationAccess, core.metrics);
    fuseFiles.registerSnapshot(app);
    const fuseTree = new FuseTreeRepository(db);
    // Pass the live config, never config.userId: Vault unlock re-owns Files after the app is built.
    new FuseReadRoutes(accessGate, fuseTree, new FuseTreeSnapshotCache(fuseTree, config), managers.fuseExperiment, config).register(app);
    fuseFiles.register(app);
    new FuseContentRoutes(db, config, store, accessGate, managers, versionWriter, transactions, fuseWrites, textMerger, automergeTexts, liveText, requestAudit, contentReadFailures, core.metrics).register(app);
    new FuseMetadataRoutes(db, accessGate, transactions, new FileMetadataRepository(db)).register(app);
    const fileLocator = new FileLocatorRepository(db);
    new FileResolveRoutes(accessGate, fileLocator).register(app);
    new LocalRootRoutes(manager).register(app);
    new LocalMaintenanceRoutes(db, config, store, transactions, new ScratchMaintenanceRepository(), manager).register(app);

    new SearchRoutes(new SearchScopeRepository(db), search).register(app);
    new StarRoutes(accessGate, new StarRepository(db)).register(app);
    new FileOperationRoutes(db, accessGate, fileLocator, operationAccess, manager).register(app);
    new ShareRoutes(accessGate, shares, contentReadFailures).register(app);

    const collectionSync = new CollectionSyncRoutes(db, accessGate, new CollectionSyncRepository(db, FILE_ROW_JSON_SQL));
    new OrgCollectionRoutes(config, new OrgCollectionEnrollment(new OrgCollectionEnrollmentRepository(db), config), this.dependencies.cloudSync, this.dependencies.profileCaches).register(app);
    collectionSync.registerListing(app);
    const agentFiles = new AgentFileRoutes(db, config, store, accessGate, new AgentFileRepository(db, FILE_COLUMNS_SQL), requestAudit);
    agentFiles.registerQuery(app);
    new AgentWriteRoutes(db, config, store, accessGate, versionWriter, transactions, new AgentWriteRepository(db), requestAudit).register(app);
    agentFiles.register(app);
    collectionSync.register(app);
    new ChunkRoutes(config, store, accessGate, new ChunkAccessRepository(db), actorScope).register(app);
    new VersionSyncRoutes(new RemoteVersionSync(db, store, accessGate, transactions, new RemoteVersionRepository(), new RemoteVersionBundleValidator(), actorScope)).register(app);

    new FolderGuidanceRoutes(accessGate, new FolderGuidanceRepository(db), new CollectionSettingsRepository(db), transactions, requestAudit).register(app);
    const fileWriteRows = new FileWriteRepository(db);
    const fileWrites = new FileWriteRoutes(db, accessGate, versionWriter, transactions, fileWriteRows, new VersionRestoreRepository(db), requestAudit, operationAccess, indexer);
    fileWrites.registerCreateAndRemove(app);
    new FileFeedRoutes(accessGate, core.filesFeed).register(app);
    new FileListingRoutes(accessGate, new FileListingRepository(db, FILE_COLUMNS_SQL), new FileListingQuery()).register(app);
    fileWrites.registerConflictAndReindex(app);
    new FileDetailRoutes(db, config, store, accessGate, new FileDetailRepository(db), requestAudit, contentReadFailures).register(app);
    new FileContentWriteRoutes(db, config, store, accessGate, versionWriter, transactions, fileWriteRows, textMerger, automergeTexts, liveText, requestAudit, databaseFailures).register(app);
    fileWrites.registerTrash(app);
    new TrashRoutes(db, accessGate, new TrashListingRepository(db, FILE_COLUMNS_SQL), operationAccess, store, manager).register(app);
    fileWrites.registerRestore(app);

    new AgentKeepRoutes(db, config, store, accessGate, versionWriter, transactions, new AgentKeepRepository(db, FILE_COLUMNS_SQL), requestAudit).register(app);
    agentFiles.registerRunEnd(app);
    registerDocumentLifecycleRoutes(app, db, { identity: accessGate.identity, requireFile: accessGate.requireFile, audit: requestAudit.record,
      deleteChunk:(collectionId,chunkId)=>store.delete(collectionId,chunkId),
      ...(manager?{disposeTrashReceipt:(receiptId:string)=>manager.disposeTrashReceipt(receiptId)}:{}),
    });
  }
}

/** Positional entry kept for the specs; delegates to FilesApplication. */
export function createApp(
  db:pg.Pool,
  config:Config,
  manager?:LocalFilesManager,
  search?:FileSearch,
  onUnlock?:()=>Promise<void>,
  onLock?:()=>Promise<void>,
  onRecover?:(master:Buffer)=>Promise<number>,
  residency?:FileResidencyManager,
  filesLifecycle?:FilesLifecycle,
  bootstrapAuthority?:FilesBootstrapAuthority,
  indexer?:IndexingQueue,
  chunkStore?:Store,
  cloudSync?:CloudSyncService,
) {
  return new FilesApplication({ db, config, manager, search, onUnlock, onLock, onRecover, residency, filesLifecycle, bootstrapAuthority, indexer, chunkStore, cloudSync }).build();
}
