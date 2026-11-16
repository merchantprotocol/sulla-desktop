// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { randomUUID } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';

import type * as Automerge from '@automerge/automerge';
import express from 'express';

import { auditContext } from './auditContext.js';
import type { TextDocument } from './automergeText.js';
import { FileAuditWriter } from './fileAudit.js';

import { healthPayload } from './health.js';
import { verifyFilesIdentity, type FilesIdentity } from './auth.js';
import { chunkId, encryptChunk } from './crypto.js';
import { trashFileWithoutReceipt } from './databaseOperations.js';
import { ContentReadFailureLog } from './ContentReadFailureLog.js';
import { ManifestChunkRegistry } from './ManifestChunkRegistry.js';
import { FilesBootstrapAuthority, FilesBootstrapError } from './bootstrapAuthority.js';
import { loadFileContent } from './preview.js';
import { assertUnprotectedFile } from './protectedFiles.js';
import { registerResidencyRoutes } from './residencyHttp.js';
import { SharesService } from './shares.js';
import { CatalogSyncService } from './cloudRemote/catalogSync.js';
import { DesktopRequestSyncService } from './cloudRemote/desktopRequests.js';
import { Store } from './store.js';
import { assertStoredFilePath, ensureStoredFileParents, lockStoredNamespace, storedParentPaths } from './storedNamespace.js';
import { streamUploadChunks, commitStreamedUpload } from './streamingUpload.js';
import { beginUploadIntent, completeUploadIntent } from './uploadCleanup.js';
import { BACKUP_ROOT, checkedBackupDirectory, localBackupRoot, LocalBackupObjectStore, openBackupDestination, type BackupDestinationConfig } from './backup/destinations.js';
import { PersonalBackupScheduler } from './backup/scheduler.js';
import { BackupRuntimeRequests } from './backup/runtime.js';
import { AwsS3BackupClient } from './backup/s3.js';
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
import { DatabaseFailureClassifier, RetryableDatabaseError, TransactionRunner } from './FilesTransaction.js';
import { VersionContentStager } from './VersionContentStager.js';
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
import { FileListingQuery } from './FileListingQuery.js';
import { HttpError } from './Http/HttpError.js';
import { FilesRequestInput } from './Http/FilesRequestInput.js';
import { FilesAccessGate, type RequestWithIdentity } from './Http/FilesAccessGate.js';
import { FileListingRepository } from './Repositories/FileListingRepository.js';
import { FileListingRoutes } from './routes/FileListingRoutes.js';
import { ShareRoutes } from './routes/ShareRoutes.js';
import { OriginalRevealRoutes } from './routes/OriginalRevealRoutes.js';
import { CollectionSyncRoutes } from './routes/CollectionSyncRoutes.js';
import { CollectionSyncRepository } from './Repositories/CollectionSyncRepository.js';
import { TrashRoutes } from './routes/TrashRoutes.js';
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

// search_text (450 MB) and search_vector (378 MB) must never be serialized to API responses or loaded into bulk result sets.
const FILE_COLUMNS_SQL = 'f.id,f.collection_id,f.path,f.current_version_id,f.deleted_at,f.expires_at,f.created_by_type,f.created_by_id,f.mime,f.size,f.created_at,f.updated_at,f.extracted_at,f.extraction_status,f.person_id,f.extraction_reason_code,f.extraction_reason,f.draft_version_id,f.published_version_id,f.versioning_enabled,f.major_minor_enabled,f.require_approval,f.require_checkout,f.checked_out_by_user_id,f.checked_out_by_device_id,f.checked_out_at,f.retention_mode,f.retain_until,f.retention_event_type,f.retention_event_at,f.retention_duration_days,f.record_lock_type,f.record_locked_at,f.record_locked_by,f.disposal_status,f.disposal_review_at,f.disposal_extended_until,f.lifecycle_generation,f.operation_revision';
const FILE_ROW_JSON_SQL = `row_to_json((SELECT x FROM (SELECT ${FILE_COLUMNS_SQL}) x))`;
const { cleanPath, numberedPath, bearer, UUID } = FilesRequestInput;

async function availableStoredPath(client:pg.PoolClient, collectionId:string, requestedPath:string, keepBoth:boolean):Promise<string> {
  const blockedParent = await client.query('SELECT path FROM files WHERE collection_id=$1 AND path=ANY($2::text[]) ORDER BY length(path),path LIMIT 1', [collectionId, storedParentPaths(requestedPath)]);
  if (blockedParent.rowCount) throw new HttpError(409, `A file already occupies ${ blockedParent.rows[0].path }, so ${ requestedPath } cannot be stored there.`);
  for (let index = 0; index <= 10_000; index++) {
    const candidate = index ? numberedPath(requestedPath, index) : requestedPath;
    const occupied = await client.query(`SELECT 1 FROM files WHERE collection_id=$1 AND path=$2
      UNION ALL SELECT 1 FROM file_folders WHERE collection_id=$1 AND path=$2 LIMIT 1`, [collectionId, candidate]);
    if (!occupied.rowCount) return candidate;
    if (!keepBoth) throw new HttpError(409, 'A file or folder already exists at that Files path.');
  }
  throw new HttpError(409, 'Files could not reserve a distinct path for this upload.');
}

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
}

/**
 * Composition root of the Files HTTP API. Route groups live as classes under routes/ and take
 * their repositories and services by constructor; composeFilesApp still holds the groups that
 * have not moved there yet, in their original mount order.
 */
export class FilesApplication {
  constructor(private readonly dependencies:FilesApplicationDependencies) {}

  build():express.Express {
    const d = this.dependencies;
    return composeFilesApp(d.db, d.config, d.manager, d.search, d.onUnlock, d.onLock, d.onRecover, d.residency, d.filesLifecycle, d.bootstrapAuthority, d.indexer, d.chunkStore, d.cloudSync);
  }
}

/** Positional entry kept for the process entry and specs; delegates to FilesApplication. */
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

function composeFilesApp(
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
):express.Express {
  const app = express(); const listingQuery = new FileListingQuery(); const filesFeed = new CollectionFilesFeed(db, FILE_COLUMNS_SQL); const store = chunkStore ?? new Store(config.chunkRoot); const contentStager = new VersionContentStager({ keys: id => config.keyring!.keys(id) }, store, { chunkId, encryptChunk }); const transactions = new TransactionRunner(db); const contentReadFailures = new ContentReadFailureLog(); const chunkRegistry = new ManifestChunkRegistry(); const shares = new SharesService(db, config, store); const jsonParser = express.json({ limit: '20mb' });
  const inFlightRequests = new Map<string, number>();
  app.locals.inFlightRequests = inFlightRequests;
  const snapshotRetention = AutomergeSnapshotRetention.fromEnvironment(db);
  const snapshotPruner = setInterval(() => { void snapshotRetention.prune().catch(error => console.warn('[SullaFiles] Automerge snapshot retention failed:', error)); }, 60_000);
  snapshotPruner.unref();
  const ready = () => filesLifecycle ? filesLifecycle.ready : Boolean(config.keyring?.unlocked);
  app.locals.catalogSync = new CatalogSyncService(db, config, ready);
  app.locals.desktopRequests = new DesktopRequestSyncService(db, config, store, shares);
  const bootstrapJsonParser = express.json({ limit: '32kb' });
  app.disable('x-powered-by');
  app.use((request, response, next) => {
    const path = request.path.slice(0, 200);
    inFlightRequests.set(path, (inFlightRequests.get(path) ?? 0) + 1);
    let finished = false;
    const release = () => {
      if (finished) return;
      finished = true;
      const remaining = (inFlightRequests.get(path) ?? 1) - 1;
      if (remaining) inFlightRequests.set(path, remaining);
      else inFlightRequests.delete(path);
    };
    response.once('finish', release);
    response.once('close', release);
    next();
  });
  app.post('/v1/bootstrap/challenge', bootstrapJsonParser, async(request, response) => {
    if (config.mode !== 'desktop' || !bootstrapAuthority) return response.sendStatus(404);
    try { return response.json(await bootstrapAuthority.challenge(request.body)) } catch (error) {
      const failure = error instanceof FilesBootstrapError ? error : new FilesBootstrapError('FILES_BOOTSTRAP_FAILED', 503, 'Files bootstrap failed');
      return response.status(failure.status).json({ code: failure.code, error: failure.message });
    }
  });
  app.post('/v1/bootstrap/unlock', bootstrapJsonParser, async(request, response) => {
    if (config.mode !== 'desktop' || !bootstrapAuthority) return response.sendStatus(404);
    try { return response.json(await bootstrapAuthority.unlock(request.body)) } catch (error) {
      const failure = error instanceof FilesBootstrapError ? error : new FilesBootstrapError('FILES_BOOTSTRAP_FAILED', 503, 'Files bootstrap failed');
      return response.status(failure.status).json({ code: failure.code, error: failure.message });
    }
  });
  app.use((request, response, next) => ['/v1/files/import', '/v1/local/native-sources/ingest', '/v1/local/system-areas/ingest'].includes(request.path) ||
    /^\/v1\/fuse\/files\/[0-9a-f-]+\/content\/stream$/i.test(request.path) ? next() : jsonParser(request, response, next));
  app.use((request:RequestWithIdentity, response, next) => {
    if (request.path === '/healthz') return next();
    if (request.path === '/v1/system/audit-events') {
      if (!config.localToken || request.header('x-sulla-files-token') !== config.localToken) return response.status(401).json({error:'unauthorized service request'});
      return next();
    }
    if (request.path.startsWith('/v1/local/')) { if (!config.localToken || request.header('x-sulla-files-token') !== config.localToken) return response.status(401).json({ error: 'unauthorized local request' }); return next() }
    const token = bearer(request);
    try { request.filesIdentity = verifyFilesIdentity(token, config.capabilitySigningKey) } catch {
      response.status(401).json({ error: 'unauthorized' });
    }
    if (request.filesIdentity) next();
  });
  app.use((request:RequestWithIdentity,response,next)=>{
    const value=request.header('x-sulla-actor');
    if (!value || !request.path.startsWith('/v1/fuse/')) return next();
    const match=/^([A-Za-z0-9._-]{1,128}):([A-Za-z0-9._:-]{1,256})$/.exec(value);
    if (!match) return response.status(400).json({error:'X-Sulla-Actor must be <agentId>:<jobId>'});
    if (request.filesIdentity?.kind!=='capability') return response.status(403).json({error:'X-Sulla-Actor requires the FUSE capability token'});
    request.filesIdentity={...request.filesIdentity,agentId:match[1],jobId:match[2]};
    next();
  });
  app.post('/v1/local/lock', async(_request, response) => {
    if (config.mode !== 'desktop') return response.sendStatus(404);
    if (filesLifecycle) await filesLifecycle.lock();
    else { await onLock?.(); config.keyring?.close() }
    bootstrapAuthority?.invalidate();
    response.json({ ok: true });
  });
  app.use((request, response, next) => {
    if (!['/healthz','/v1/system/audit-events'].includes(request.path) && !ready()) return response.status(503).json({ code: 'FILES_LOCKED', error: 'Files is locked; secure bootstrap is required' });
    next();
  });
  app.use((request:RequestWithIdentity,_response,next) => {
    const actor=request.filesIdentity;
    auditContext.run({actor:actor?.agentId ?? actor?.jobId ?? (actor ? 'human' : 'sulla-files'),
      requestId:request.header('x-request-id')?.slice(0,256) ?? randomUUID(),
      action:request.body?.action === 'copy' || (Array.isArray(request.body?.items) && request.body.items.some((item:any)=>item?.action==='copy')) ? 'copy' : /\/restore$/.test(request.path) ? 'restore' : undefined},next);
  });
  registerCloudSyncRoutes(app, config, cloudSync);
  const accessGate = new FilesAccessGate(db);
  const { identity, collectionRow, requireCollection, requirePath, fileRow, requireFile, visibleVersion } = accessGate;
  const requestAudit = new RequestAuditLog(accessGate, new AuditLogRepository(db)); const audit = requestAudit.record;
  const managers = new LocalManagerGate(config, manager); const requireFuseExperiment = managers.fuseExperiment;
  const versionWriter = new VersionWriter(config, accessGate, store, contentStager, chunkRegistry, new VersionWriteRepository());
  const { stage: stageVersionContent, insert: insertVersion } = versionWriter;
  const automergeDocuments = new AutomergeDocumentRepository(db); const automergeTexts = new AutomergeTextStore(automergeDocuments);
  const saveAutomergeVersion = (client:pg.PoolClient, fileId:string, versionId:string, document:Automerge.Doc<TextDocument>) => automergeTexts.save(client, fileId, versionId, document);
  const liveText = new LiveTextCoordinator(db, config, store, accessGate, transactions, versionWriter, automergeDocuments, automergeTexts, requestAudit);
  const live = liveText.sessions; const adoptLive = liveText.adopt;
  app.locals.liveTextSessions = live;
  const textMerger = new TextVersionMerger(automergeDocuments, automergeTexts, live, managers); const textSave = textMerger.merge;
  const auditWriter=new FileAuditWriter(db, async(id,versionId) => {
    const content=await loadFileContent(db,config,store,id,versionId);
    if (!content) throw new Error('Audit log content unavailable');
    return content.buffer;
  }, (collectionId,bytes) => stageVersionContent(collectionId,bytes), (client,collectionId,path,bytes,staged,fileId) => insertVersion(client,{collectionId,path,bytes,staged,fileId,mime:'application/x-ndjson',
    actor:{userId:config.userId,deviceId:config.deviceId,kind:'capability'},createdByType:'user',createdById:'sulla-files',message:'Append audit event'}));
  app.locals.auditWriter=auditWriter;
  new AuditEventRoutes(new AuditSpoolRepository(db), auditWriter).register(app);
  const actorScope = (actor:FilesIdentity):string => actor.jobId
    ? `job:${ actor.jobId }:agent:${ actor.agentId ?? '' }:thread:${ actor.threadId ?? '' }:device:${ actor.deviceId }`
    : `device:${ actor.deviceId || config.deviceId }`;
  const originalReveal = new OriginalRevealRoutes(config, accessGate, manager);
  originalReveal.register(app);
  if (residency) registerResidencyRoutes(app, residency, async(request, fileId) => { await requireFile(request as RequestWithIdentity, fileId, 'edit') });
  new LiveTextRoutes(accessGate, liveText).register(app);

  // 503 while Postgres is unreachable (Desktop treats that as temporarily unavailable and
  // retries); the body keeps the unlock-handshake fields either way.
  const databaseHealth = new DatabaseHealthRepository(db);
  app.get('/healthz', async(_request, response) => {
    const payload = healthPayload(config, ready(), filesLifecycle?.status());
    if (await databaseHealth.reachable()) response.json(payload);
    else response.status(503).json({ ...payload, ok: false, error: 'database_unavailable' });
  });
  app.use('/v1/local/backups',(_request,response,next)=>config.mode==='desktop'?next():response.sendStatus(404));
  const backupRuntime=new BackupRuntimeRequests();
  const backupVault=configuredVaultFilesKeyBundleAuthority(config);
  const backupScheduler=new PersonalBackupScheduler(db,config,{ready,open:async(id,destination)=>{
    if(destination.kind==='local') {
      const root=await checkedBackupDirectory(localBackupRoot(destination.root));
      return new LocalBackupObjectStore(await checkedBackupDirectory(`${ root }/destinations/${ id }`));
    }
    if(destination.kind==='nas') {
      await backupRuntime.prepare(id);
      const point=`${ BACKUP_ROOT }/nas-${ id }`;
      const mounts=(await readFile('/proc/self/mountinfo','utf8')).split('\n');
      if(!mounts.some(line=>{const parts=line.split(' ');const separator=parts.indexOf('-');return parts[4]===point && ['cifs','nfs','nfs4'].includes(parts[separator+1]) && ['nosuid','nodev','noexec'].every(flag=>parts[5].split(',').includes(flag))})) throw new Error('NAS mount did not propagate into Files');
      const handle=await open(point,'r');
      try { return new LocalBackupObjectStore(await checkedBackupDirectory(`${ point }/sulla-files-backups/${ id }`),()=>handle.close()) } catch(error) {await handle.close();throw error}
    }
    if(!backupVault) throw new Error('Vault backup credential authority is unavailable');
    const client=new AwsS3BackupClient(destination.endpoint,await backupVault.backupCredentials(destination.vaultCredentialId,destination.endpoint),destination.region);
    try { return await openBackupDestination({...destination,prefix:[destination.prefix,`destinations/${ id }`].filter(Boolean).join('/')},{s3:client}) } catch(error) {client.close();throw error}
  }});
  app.locals.backupScheduler=backupScheduler;
  app.locals.backupRuntime=backupRuntime;
  app.get('/v1/local/backups', async(_request,response,next)=>{ try {
    const destinations=(await db.query(`SELECT id,kind,label,config,enabled,created_at,updated_at FROM files_backup_destinations ORDER BY created_at`)).rows;
    const status=(await db.query(`SELECT DISTINCT ON(destination_id) destination_id,state,started_at,finished_at,error_message,snapshot_id
      FROM files_backup_runs ORDER BY destination_id,started_at DESC`)).rows;
    response.json({destinations:destinations.map(item=>({...item,status:status.find(run=>run.destination_id===item.id)})),runtimeRequests:backupRuntime.list(),retention:{hourly:24,daily:30,weekly:12}});
  } catch(error){next(error)} });
  app.post('/v1/local/backups/runtime/:id',async(request,response)=>{
    if(!backupRuntime.complete(request.params.id,request.body?.ok===true)) return response.sendStatus(404);
    response.sendStatus(204);
  });
  app.post('/v1/local/backups/destinations',async(request,response,next)=>{ try {
    const kind=request.body?.kind; const label=String(request.body?.label??'').trim(); const fields=request.body?.config;
    if (!['local','nas','s3'].includes(kind) || fields?.kind!==kind || !label || label.length>200) throw new HttpError(400,'Invalid backup destination');
    if(fields.vaultCredentialId && (typeof fields.vaultCredentialId!=='string' || !UUID.test(fields.vaultCredentialId))) throw new HttpError(400,'Enter a valid Vault item UUID');
    let destination:BackupDestinationConfig;
    if (kind==='local') {
      try { destination={kind,root:localBackupRoot(fields.root)} } catch { throw new HttpError(400,'Local backups require a valid subfolder on the Sulla VM backup disk') }
    } else if(kind==='nas') {
      let share:URL;
      try {share=new URL(fields.share)} catch {throw new HttpError(400,'Enter a valid NAS share URL')}
      if(!['smb','nfs'].includes(fields.protocol) || share.protocol!==`${ fields.protocol }:` || !share.hostname || share.pathname==='/' || share.username || share.password || share.search || share.hash || share.port) throw new HttpError(400,'Enter an smb://server/share or nfs://server/export URL without credentials');
      if(fields.protocol==='smb' && !fields.vaultCredentialId) throw new HttpError(400,'SMB backups require Vault credentials');
      destination={kind,share:fields.share,protocol:fields.protocol,...(fields.vaultCredentialId?{vaultCredentialId:String(fields.vaultCredentialId)}:{})};
    } else {
      let endpoint:URL;
      try {endpoint=new URL(fields.endpoint)} catch {throw new HttpError(400,'Enter a valid HTTPS S3 endpoint')}
      if(endpoint.protocol!=='https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !fields.bucket || !fields.vaultCredentialId) throw new HttpError(400,'S3 backups require HTTPS, a bucket, and Vault credentials');
      if(fields.region && (typeof fields.region!=='string' || !/^[A-Za-z0-9-]{1,64}$/.test(fields.region))) throw new HttpError(400,'Invalid S3 signing region');
      destination={kind:'s3',endpoint:fields.endpoint,bucket:String(fields.bucket),vaultCredentialId:String(fields.vaultCredentialId),...(fields.region?{region:fields.region}:{}),...(fields.prefix?{prefix:String(fields.prefix)}:{})};
    }
    const id=randomUUID(); const row=(await db.query(`INSERT INTO files_backup_destinations(id,kind,label,config) VALUES($1,$2,$3,$4) RETURNING *`,[id,kind,label,destination])).rows[0]; response.status(201).json(row);
  } catch(error){next(error)} });
  app.delete('/v1/local/backups/destinations/:id',async(request,response,next)=>{
    const client=await db.connect();
    try {
      await client.query('BEGIN');
      const locked=(await client.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked',[`files-backup:${ request.params.id }`])).rows[0].locked;
      if(!locked) throw new HttpError(409,'Wait for the running backup before removing this destination');
      const row=(await client.query('SELECT id,kind FROM files_backup_destinations WHERE id::text=$1 FOR UPDATE',[request.params.id])).rows[0];
      if(!row) throw new HttpError(404,'Backup destination not found');
      if(row.kind==='nas') await backupRuntime.prepare(row.id,'unmount');
      await client.query('DELETE FROM files_backup_destinations WHERE id=$1',[row.id]);
      await client.query('COMMIT');response.sendStatus(204);
    } catch(error) {await client.query('ROLLBACK');next(error)} finally {client.release()}
  });
  app.post('/v1/local/backups/:id/run',async(request,response,next)=>{ try {
    const destination=(await db.query('SELECT * FROM files_backup_destinations WHERE id::text=$1 AND enabled=TRUE',[request.params.id])).rows[0]; if(!destination) throw new HttpError(404,'Backup destination not found');
    try { response.status(202).json({runId:await backupScheduler.enqueue(destination.id,destination.config,'hourly')}) } catch { throw new HttpError(409,'Backup is already running or the service is unavailable') }
  } catch(error){next(error)} });
  new LocalSourceRoutes(db, config, accessGate, managers, versionWriter, transactions, new HomeSystemFileRepository(db), manager).register(app);
  const operationAccess = (request:RequestWithIdentity) => ({
    custody: manager?.operationCustody(),
    prepare: async(collectionId:string) => { await requireCollection(request, collectionId, 'edit') },
    file: (client:pg.PoolClient,id:string) => requireFile(request,id,'edit',client),
    path: async(client:pg.PoolClient,collectionId:string,path:string) => { await requirePath(request,collectionId,path,'edit',client) },
  });
  const fuseWrites = new FuseWriteRepository(db);
  const fuseFiles = new FuseFileRoutes(db, accessGate, managers, versionWriter, transactions, fuseWrites, requestAudit, operationAccess);
  fuseFiles.registerSnapshot(app);
  const fuseTree = new FuseTreeRepository(db);
  new FuseReadRoutes(accessGate, fuseTree, new FuseTreeSnapshotCache(fuseTree, config.userId), requireFuseExperiment, config.userId).register(app);
  fuseFiles.register(app);
  new FuseContentRoutes(db, config, store, accessGate, managers, versionWriter, transactions, fuseWrites, textMerger, automergeTexts, liveText, requestAudit, contentReadFailures).register(app);
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
  collectionSync.registerListing(app);
  const agentFiles = new AgentFileRoutes(db, config, store, accessGate, new AgentFileRepository(db, FILE_COLUMNS_SQL), requestAudit);
  agentFiles.registerQuery(app);
  new AgentWriteRoutes(db, config, store, accessGate, versionWriter, transactions, new AgentWriteRepository(db), requestAudit).register(app);
  agentFiles.register(app);
  collectionSync.register(app);
  new ChunkRoutes(config, store, accessGate, new ChunkAccessRepository(db), actorScope).register(app);
  new VersionSyncRoutes(new RemoteVersionSync(db, store, accessGate, transactions, new RemoteVersionRepository(), new RemoteVersionBundleValidator(), actorScope)).register(app);

  new FolderGuidanceRoutes(accessGate, new FolderGuidanceRepository(db), new CollectionSettingsRepository(db), transactions, requestAudit).register(app);
  app.post('/v1/files/empty', async(request:RequestWithIdentity,response,next)=>{ try {
    const collectionId=String(request.body.collectionId??''); const filePath=cleanPath(request.body.path,false);
    await requirePath(request,collectionId,filePath,'edit'); const actor=identity(request);
    const bytes=Buffer.alloc(0); const staged=await stageVersionContent(collectionId,bytes);
    const file=await transactions.run('create-empty',async client=>{
    await requirePath(request,collectionId,filePath,'edit',client); await lockStoredNamespace(client,collectionId);
    const occupied=await client.query(`SELECT 1 FROM files WHERE collection_id=$1 AND path=$2
      UNION ALL SELECT 1 FROM file_folders WHERE collection_id=$1 AND path=$2 LIMIT 1`,[collectionId,filePath]);
    if(occupied.rowCount) throw new HttpError(409,'A file or folder already exists at that Files path.');
    return insertVersion(client,{collectionId,path:filePath,mime:'text/plain',bytes,staged,actor,message:'Created empty file'});
    }); await audit(request,'create-empty-file',file); response.status(201).json(file);
  } catch(error){next(error)} });
  app.delete('/v1/folders', async(request:RequestWithIdentity, response, next) => { try {
    const collectionId = String(request.query.collectionId ?? '');
    const folderPath = cleanPath(String(request.query.path ?? ''), false);
    await requirePath(request, collectionId, folderPath, 'edit');
    await transactions.run('remove-folder',async client=>{
    await requirePath(request,collectionId,folderPath,'edit',client);
    await lockStoredNamespace(client, collectionId);
    const active = await client.query(`SELECT 1 FROM files WHERE collection_id=$1
      AND (path=$2 OR starts_with(path,$2||'/')) LIMIT 1`, [collectionId, folderPath]);
    if (active.rowCount) throw new HttpError(409, 'Use receipt-backed folder Trash; folders containing files or retained tombstones cannot be removed.');
    const retained = await client.query(`SELECT 1 FROM file_folders WHERE collection_id=$1 AND deleted_at IS NOT NULL AND (path=$2 OR starts_with(path,$2||'/')) LIMIT 1`, [collectionId, folderPath]);
    if (retained.rowCount) throw new HttpError(409, 'Retained folder tombstones cannot be removed through this action.');
    const removed = await client.query(`DELETE FROM file_folders WHERE collection_id=$1 AND (path=$2 OR starts_with(path,$2||'/'))`, [collectionId, folderPath]);
    if (!removed.rowCount) throw new HttpError(404, 'folder not found');
    await client.query(`DELETE FROM file_stars WHERE collection_id=$1 AND folder_path IS NOT NULL
      AND (folder_path=$2 OR starts_with(folder_path,$2||'/'))`, [collectionId, folderPath]);
    });
    response.status(204).end();
  } catch (error) { next(error) } });
  new FileFeedRoutes(accessGate, filesFeed).register(app);
  new FileListingRoutes(accessGate, new FileListingRepository(db, FILE_COLUMNS_SQL), listingQuery).register(app);
  app.post('/v1/files/:id/conflicts/keep-both', async(request:RequestWithIdentity, response, next) => { try {
    const conflictFileId = request.params.id;
    const conflictVersionId = String(request.body.currentVersionId ?? '');
    const sourceFileId = String(request.body.sourceFileId ?? '');
    const sourceVersionId = String(request.body.sourceVersionId ?? '');
    if (![conflictFileId, conflictVersionId, sourceFileId, sourceVersionId].every(value => UUID.test(value))) throw new HttpError(400, 'valid conflict and version identities are required');
    const displayedConflict = await requireFile(request, conflictFileId, 'edit');
    const displayedSource = await requireFile(request, sourceFileId, 'edit');
    if (displayedConflict.collection_id !== displayedSource.collection_id) throw new HttpError(409, 'The displayed conflict source is no longer in the same collection. Refresh Files and try again.');
    await transactions.run('keep-both',async client=>{
    await lockStoredNamespace(client, displayedConflict.collection_id);
    const relation = (await client.query('SELECT source_file_id FROM files_native_conflicts WHERE file_id=$1 FOR UPDATE', [conflictFileId])).rows[0];
    if (!relation || relation.source_file_id !== sourceFileId) throw new HttpError(409, 'This conflict changed. Refresh Files and try again.');
    const locked = await client.query('SELECT id,current_version_id,deleted_at FROM files WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE', [[conflictFileId, sourceFileId]]);
    const conflict = locked.rows.find(row => row.id === conflictFileId);
    const source = locked.rows.find(row => row.id === sourceFileId);
    if (!conflict || !source || conflict.deleted_at || source.deleted_at || conflict.current_version_id !== conflictVersionId || source.current_version_id !== sourceVersionId) throw new HttpError(409, 'One of the preserved files changed. Refresh Files and review both copies again.');
    const unresolved = await client.query(`SELECT operation_id FROM files_native_source_operations
      WHERE file_id=ANY($1::uuid[]) AND state IN('publishing','recovery-required') ORDER BY operation_id FOR UPDATE`, [[conflictFileId, sourceFileId]]);
    if (unresolved.rowCount) throw new HttpError(409, 'Native source publication is still unresolved. Restore native access or finish recovery before acknowledging both copies.');
    const removed = await client.query('DELETE FROM files_native_conflicts WHERE file_id=$1 AND source_file_id=$2', [conflictFileId, sourceFileId]);
    if (removed.rowCount !== 1) throw new HttpError(409, 'This conflict was already changed. Refresh Files and try again.');
    await client.query(`INSERT INTO audit_log(who_type,who_id,device_or_run_id,file_id,version_id,action,details)
      VALUES($1,$2,$3,$4,$5,'conflict-keep-both',$6)`, [identity(request).kind === 'capability' ? 'agent-or-device' : 'user', identity(request).userId, identity(request).deviceId || null, conflictFileId, conflictVersionId, JSON.stringify({ sourceFileId, sourceVersionId })]);
    });
    response.status(204).end();
  } catch (error) { next(error) } });
  app.post('/v1/files/:id/reindex', async(request:RequestWithIdentity, response, next) => { try {
    if (!indexer) return response.status(503).json({ error: 'indexing unavailable' });
    await requireFile(request, request.params.id, 'edit');
    await indexer.retry(request.params.id);
    await audit(request, 'reindex', await fileRow(request.params.id));
    response.status(202).json({ accepted: true });
  } catch (error) { next(error) } });
  new FileDetailRoutes(db, config, store, accessGate, new FileDetailRepository(db), requestAudit, contentReadFailures).register(app);
  app.put('/v1/files/:id/content', async(request:RequestWithIdentity, response, next) => { try {
    const baseVersionId=String(request.body?.baseVersionId??''); const content=request.body?.content;
    if(!UUID.test(baseVersionId)||typeof content!=='string') throw new HttpError(400,'baseVersionId and text content are required');
    const file=await requireFile(request,request.params.id,'edit');
    const base=(await db.query('SELECT id FROM file_versions WHERE id=$1 AND file_id=$2 AND NOT deleted',[baseVersionId,file.id])).rows[0];
    if(!base){return response.status(409).json({code:'VERSION_CONFLICT',error:'The edited Files version is no longer available.',currentVersionId:file.current_version_id})}
    const readVersion=async(fileId:string,versionId:string):Promise<Buffer>=>{const loaded=await loadFileContent(db,config,store,fileId,versionId);if(!loaded)throw new HttpError(409,'Files version content is unavailable');return loaded.buffer};
    const currentBytes=await readVersion(file.id,file.current_version_id); let saved;
    try{saved=await textSave(db as unknown as pg.PoolClient,file,baseVersionId,Buffer.from(content,'utf8'),currentBytes,readVersion)}catch(error){
      if(!databaseFailures.isConnectionLoss(error)&&baseVersionId!==file.current_version_id){return response.status(409).json({code:'VERSION_CONFLICT',error:'The edited version could not be merged safely.',currentVersionId:file.current_version_id})}
      throw error;
    }
    const actor=identity(request); const staged=await stageVersionContent(file.collection_id,saved.bytes);
    const result=await transactions.run('web-editor-save',async client=>{
    await lockStoredNamespace(client,file.collection_id,file.path);
    const current=await requireFile(request,file.id,'edit',client);
    if(current.current_version_id!==file.current_version_id||current.path!==file.path||current.collection_id!==file.collection_id)throw new HttpError(409,'Files version changed while preparing save; retry');
    const result=await insertVersion(client,{collectionId:file.collection_id,fileId:file.id,path:file.path,mime:file.mime,bytes:saved.bytes,staged,actor,
      createdByType:actor.agentId?'agent':actor.jobId?'agent-run':undefined,createdById:actor.agentId??actor.jobId??actor.userId,message:'Saved with version check',baseVersionId:file.current_version_id});
    if(saved.document)await saveAutomergeVersion(client,file.id,result.current_version_id,saved.document); return result; }); if(saved.document)adoptLive(request,file.id,saved.document);
    await audit(request,'version-checked-save',result,{baseVersionId,merged:saved.merged,versionId:result.current_version_id});
    response.json({status:saved.merged?'merged':'saved',fileId:result.id,path:result.path,mime:result.mime,content:saved.bytes.toString('utf8'),versionId:result.current_version_id});
  }catch(error){next(error)} });
  app.put('/v1/files/upload', async(request:RequestWithIdentity, response, next) => { const uploadId = randomUUID(); try {
    const collectionId = String(request.query.collectionId ?? ''); const path = cleanPath(String(request.query.path ?? ''), false); const actor = identity(request);
    const lengthHeader = request.header('content-length') ?? request.header('x-sulla-expected-bytes');
    const expectedBytes = lengthHeader === undefined ? undefined : Number(lengthHeader);
    if (expectedBytes !== undefined && (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0 || expectedBytes > 2 * 1024 * 1024 * 1024)) throw new HttpError(400, 'valid content-length is required');
    const baseVersionId = typeof request.query.baseVersionId === 'string' ? request.query.baseVersionId : undefined;
    const conflict = (current:any) => response.status(409).json({ code: 'VERSION_CONFLICT', error: 'The Files version this upload was based on is no longer current.', currentVersionId: current?.current_version_id ?? null });
    const authorize = async(row:any,client:pg.Pool|pg.PoolClient=db) => {
      if (row) { await assertUnprotectedFile(client, row); try { await requirePath(request, collectionId, path, 'edit',client) } catch (error:any) { if (error.status !== 403) throw error; await requireFile(request, row.id, 'edit',client) } }
      else await requirePath(request, collectionId, path, 'edit',client);
    };
    await beginUploadIntent(db, uploadId, collectionId);
    // Authorize and fail fast BEFORE reading the body. The body is streamed into chunks with no
    // transaction open: a slow client must never hold BEGIN or the namespace lock (Postgres kills
    // idle-in-transaction sessions after 60 s, and the lock would block every other writer).
    const before = (await db.query('SELECT * FROM files WHERE collection_id=$1 AND path=$2', [collectionId, path])).rows[0];
    await authorize(before);
    if (baseVersionId !== undefined && (!UUID.test(baseVersionId) || before?.current_version_id !== baseVersionId || before?.deleted_at)) return conflict(before);
    const streamed = await streamUploadChunks(config, store, { uploadId, collectionId, expectedBytes, maxBytes: 2 * 1024 * 1024 * 1024, body: request, intentDb: db });
    // Short metadata transaction: re-read under the lock and re-check what may have changed while streaming.
    const outcome=await transactions.run('upload',async client=>{
    await lockStoredNamespace(client, collectionId);
    const existing = (await client.query('SELECT * FROM files WHERE collection_id=$1 AND path=$2 FOR UPDATE', [collectionId, path])).rows[0];
    if (existing?.id !== before?.id) await authorize(existing,client); else if (existing) await assertUnprotectedFile(client, existing);
    if (baseVersionId !== undefined && (existing?.current_version_id !== baseVersionId || existing?.deleted_at)) { return {conflict:existing} }
    const file = await commitStreamedUpload(client, { uploadId, collectionId, path, mime: request.header('content-type') ?? 'application/octet-stream', expectedBytes, maxBytes: 2 * 1024 * 1024 * 1024, actor, body: request, intentDb: db, existingFile: existing ? { id: existing.id, current_version_id: existing.current_version_id } : undefined, message: 'Uploaded' }, streamed);
    return {file}; });
    if(!outcome.file)return conflict(outcome.conflict); const file=outcome.file;
    await completeUploadIntent(db, uploadId).catch(()=>undefined); await audit(request, 'upload', file); response.status(201).json(file);
  } catch (error) { next(error) } });
  app.put('/v1/files/import', async(request:RequestWithIdentity, response, next) => { const uploadId = randomUUID(); try {
    const collectionId = String(request.query.collectionId ?? '');
    const requestedPath = cleanPath(String(request.query.path ?? ''), false);
    const keepBoth = request.query.conflict === 'keep-both';
    await requirePath(request, collectionId, requestedPath, 'edit');
    // Desktop streams through Chromium, which sends chunked bodies and forbids a
    // caller-set content-length, so it declares the size in x-sulla-expected-bytes.
    // The streaming writer rejects any body that does not match the declared size.
    const declaredBytes = Number(request.header('content-length') ?? request.header('x-sulla-expected-bytes'));
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0 || declaredBytes > 2 * 1024 * 1024 * 1024) throw new HttpError(400, 'valid content-length is required');
    const actor = identity(request);
    await beginUploadIntent(db, uploadId, collectionId);
    // Stream the body into chunks first (no transaction held during the network transfer), then
    // pick the path and write metadata in a short transaction.
    const streamed = await streamUploadChunks(config, store, { uploadId, collectionId, expectedBytes: declaredBytes, body: request, intentDb: db });
    const result=await transactions.run('import',async client=>{
    await lockStoredNamespace(client, collectionId);
    const path = await availableStoredPath(client, collectionId, requestedPath, keepBoth);
    if (path !== requestedPath) await requirePath(request, collectionId, path, 'edit',client);
    await assertStoredFilePath(client, collectionId, path);
    await ensureStoredFileParents(client, collectionId, path, actor);
    const file = await commitStreamedUpload(client, {
      uploadId, collectionId, path, mime: request.header('content-type') ?? 'application/octet-stream',
      expectedBytes: declaredBytes, actor, body: request, intentDb: db,
      message: path === requestedPath ? 'Imported into Files' : `Imported as ${ path } to preserve both files`,
    }, streamed);
    return {file,path}; });
    const {file,path}=result;
    await completeUploadIntent(db, uploadId).catch(() => undefined);
    response.status(201).json({ ...file, requested_path: requestedPath, conflict_resolution: path === requestedPath ? 'none' : 'kept-both' });
  } catch (error:any) { if (error?.code === '23505') return response.status(409).json({ error: 'A file or folder already exists at that Files path.' }); next(error) } });
  app.delete('/v1/files/:id', async(request:RequestWithIdentity, response, next) => { try {
    await trashFileWithoutReceipt(db, request.params.id, identity(request), operationAccess(request));
    response.status(204).end();
  } catch (error) { next(error) } });
  new TrashRoutes(db, accessGate, new TrashListingRepository(db, FILE_COLUMNS_SQL), operationAccess, store, manager).register(app);
  app.post('/v1/files/:id/restore', async(request:RequestWithIdentity, response, next) => { try { const file = await requireFile(request, request.params.id, 'edit'); const actor = identity(request); const authorized = await visibleVersion(request, file, String(request.body.versionId ?? '')); const source = (await db.query('SELECT * FROM file_versions WHERE id=$1 AND file_id=$2 AND NOT deleted', [authorized, file.id])).rows[0]; if (!source) throw new HttpError(404, 'version not found'); const version=await transactions.run('restore-version',async client=>{ await lockStoredNamespace(client,file.collection_id,file.path); const current=await requireFile(request,file.id,'edit',client); if(current.current_version_id!==file.current_version_id)throw new HttpError(409,'Files version changed while preparing restore'); const available=await client.query('SELECT id FROM file_versions WHERE id=$1 AND file_id=$2 AND NOT deleted FOR UPDATE',[source.id,file.id]);if(!available.rowCount)throw new HttpError(409,'Restore source changed'); const version = (await client.query(`INSERT INTO file_versions(file_id,chunk_collection_id,parent_version_id,manifest_hash,size,created_by_type,created_by_id,message,version_comment,version_kind,publication_status,device_id,base_server_version_id) VALUES($1,$2,$3,$4,$5,'user',$6,'Restored version',$7,'minor',NULL,$8,$3) RETURNING id`, [file.id, source.chunk_collection_id, file.current_version_id, source.manifest_hash, source.size, actor.userId, request.body.comment ?? 'Restored as a new version', actor.deviceId || 'server-web'])).rows[0]; await client.query('UPDATE chunks SET refcount=refcount+1 WHERE collection_id=$1 AND id IN (SELECT jsonb_array_elements_text(chunk_ids) FROM manifests WHERE hash=$2)', [source.chunk_collection_id, source.manifest_hash]); await client.query('UPDATE files SET current_version_id=$2,deleted_at=NULL,size=$3,updated_at=NOW() WHERE id=$1', [file.id, version.id, source.size]); await client.query("INSERT INTO journal(collection_id,file_id,version_id,op) VALUES($1,$2,$3,'restore')", [file.collection_id, file.id, version.id]); return version; }); await audit(request, 'version-restore', { ...file, current_version_id: version.id }); response.json({ ok: true, versionId: version.id }) } catch (error) { next(error) } });

  new AgentKeepRoutes(db, config, store, accessGate, versionWriter, transactions, new AgentKeepRepository(db, FILE_COLUMNS_SQL), requestAudit).register(app);
  agentFiles.registerRunEnd(app);
  registerDocumentLifecycleRoutes(app, db, { identity, requireFile, audit,
    deleteChunk:(collectionId,chunkId)=>store.delete(collectionId,chunkId),
    ...(manager?{disposeTrashReceipt:(receiptId:string)=>manager.disposeTrashReceipt(receiptId)}:{}),
  });
  originalReveal.registerErrorHandler(app);
  app.use('/v1/database-file-operations', (error:any, _request:any, response:any, _next:any) => {
    const status = error.status ?? (error.code === '23505' ? 409 : 500);
    response.status(status).json({ error: status < 500 ? error.message : 'Database operation failed', code: error.code ?? 'operation-failed' });
  });
  // A lost database connection is transient: answer 503 + Retry-After with a stable code so the
  // mount and other clients retry, instead of an opaque 500 that surfaces to agents as EIO.
  const databaseFailures = new DatabaseFailureClassifier();
  app.use((error:any, _request:any, response:any, next:any) => {
    if (!(error instanceof RetryableDatabaseError) && error?.code !== 'FILES_DB_RETRYABLE' && !databaseFailures.isConnectionLoss(error)) return next(error);
    console.warn('[SullaFiles] request failed on a lost database connection; client may retry', { path: _request.path, error: String(error?.cause?.message ?? error?.message ?? error) });
    response.setHeader('Retry-After', '1');
    return response.status(503).json({ error: error instanceof RetryableDatabaseError || error?.code === 'FILES_DB_RETRYABLE' ? error.message : 'Files lost its database connection; retry the request', code: 'FILES_DB_RETRYABLE', retryable: true });
  });
  app.use((error:any, _request:any, response:any, _next:any) => response.status(error.status ?? (error.code === '23505' ? 409 : error.code === '55000' ? 423 : 500)).json({ error: _request.path.startsWith('/v1/bootstrap/') || error.type === 'entity.parse.failed' ? 'Invalid request' : error.message ?? 'server error', ...((error.status === 423 || error.code === '55000') ? {code:'FILE_LOCKED'} : error.code === 'EROFS' ? {code:'EROFS'} : error.code === 'FILE_OFFLINE' ? {code:'FILE_OFFLINE'} : {}), ...(error.conflictPath ? { conflictPath: error.conflictPath } : {}) })); return app;
}
