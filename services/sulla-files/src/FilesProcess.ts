// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { startVectorBackfill } from './vectorBackfill.js';
import { startSearchCleanup } from './searchCleanup.js';
import { startRetiredSystemAreaCleanup } from './retiredSystemAreas.js';
import { readFile } from 'node:fs/promises';
import http, { type RequestListener } from 'node:http';
import https from 'node:https';

import type pg from 'pg';

import { installAuditContext } from './auditContext.js';
import { ensureSystemAreas } from './systemAreas.js';
import { migrateSullaCollection, trashStrayDocs } from './sullaCollectionMigration.js';
import { FilesApplication } from './app.js';
import { LoopbackHealthListener } from './LoopbackHealthListener.js';
import { backup, nightlyBackups, restore } from './backup.js';
import { FilesBootstrapAuthority } from './bootstrapAuthority.js';
import { loadConfig, type Config } from './config.js';
import { connect, migrate } from './db.js';
import { storedIndexSource } from './indexSource.js';
import { IndexingQueue } from './indexing.js';
import { FilesKeyBundleRecovery } from './keyBundleRecovery.js';
import { SecureCollectionKeyExchange } from './keyExchange.js';
import { FilesKeyring } from './keyring.js';
import { LegacySigningKeySelector } from './Services/LegacySigningKeySelector.js';
import { runLegacyPreflight } from './legacyPreflight.js';
import { FilesLifecycle } from './lifecycle.js';
import { LocalFilesManager } from './localManager.js';
import { PotionEmbedder } from './potionEmbedder.js';
import { RecordingEnrichmentQueue } from './recordingEnrichment.js';
import { FileResidencyManager } from './residency.js';
import { HttpResidencyTransport, loadResidencySyncBundle } from './residencyHttp.js';
import { FileSearch } from './search.js';
import { FilesStartupDiagnostics, type FilesStartupStage } from './startupDiagnostics.js';
import { Store } from './store.js';
import { CachingStore, createChunkStore, type CloudChunkSource } from './chunkCache/index.js';
import { cleanupStaleUploads } from './uploadCleanup.js';
import { configuredVaultFilesKeyBundleAuthority } from './vaultKeyBundleAuthority.js';
import { VaultPrincipalAdoption } from './vaultPrincipal.js';
import { ProcessGuard } from './ProcessGuard.js';
import { MemoryTelemetry } from './MemoryTelemetry.js';
import { FilesCloudBroker } from './cloudBroker.js';
import { FilesCloudChunkSource } from './cloudSync/chunkSource.js';
import { FilesSyncCloudApi } from './cloudSync/cloudApi.js';
import { CloudRootKeyStore } from './cloudSync/keyStore.js';
import { CloudSyncService } from './cloudSync/service.js';
import { OrgRootKeyCache } from './cloudSync/OrgRootKeyCache.js';
import { ProfileIdentity } from './ProfileIdentity.js';
import { ProfileCaches } from './ProfileCaches.js';

/** The long-lived services the Files process composes before it serves the API. */
interface FilesServices {
  keyring:FilesKeyring;
  orgRootKeys:OrgRootKeyCache;
  profileCaches:ProfileCaches;
  cloudBroker?:FilesCloudBroker;
  chunkStore:ReturnType<typeof createChunkStore>;
  vaultAuthority:ReturnType<typeof configuredVaultFilesKeyBundleAuthority>;
  keyRecovery?:FilesKeyBundleRecovery;
  vaultPrincipalAdoption:VaultPrincipalAdoption;
  indexer:IndexingQueue;
  manager?:LocalFilesManager;
  residency?:FileResidencyManager;
  enrichment?:RecordingEnrichmentQueue;
  search:FileSearch;
}

/**
 * The Files service process: answers liveness while it starts, migrates, composes services and the
 * HTTP application, then runs background jobs until a signal stops it. Its mutable state (the active
 * request handler and the in-flight initialization) lives on this instance.
 */
export class FilesProcess {
  private requestHandler:RequestListener = (_request, response) => {
    response.writeHead(503, { 'content-type': 'application/json' }); response.end('{"status":"starting"}');
  };

  private initialization:Promise<void> | undefined;

  async run(argv:string[] = process.argv):Promise<void> {
    // Crash -> non-zero exit -> Docker's restart policy. Files keeps its own signal handling
    // below: it refuses to exit before live text is persisted.
    new ProcessGuard({ name: 'SullaFiles' }).catchCrashes();
    const config = loadConfig(); const command = argv[2];
    if (command === 'backup') { if (argv.includes('--watch')) await nightlyBackups(config); else await backup(config); process.exit(0) }
    if (command === 'restore') { await restore(config, argv[3]); process.exit(0) }
    const server = await this.listen(config);

    const db = await connect(config.databaseUrl); await migrate(db);
    installAuditContext(db);
    await this.prepareStorage(db, config);
    const services = await this.composeServices(db, config);
    await this.serve(server, db, config, services);
  }

  /** Starts the TLS (desktop) or plain listener that answers 503 "starting" until the app is ready. */
  private async listen(config:Config):Promise<http.Server | https.Server> {
    const tlsEnabled = Boolean(config.tlsCertificatePath && config.tlsPrivateKeyPath);
    if (config.mode === 'desktop' && !tlsEnabled) throw new Error('Files TLS identity is required in desktop mode');
    const listening = () => { console.log(`[SullaFiles] ${ config.mode } liveness listening on ${ config.port }`) };
    const server = tlsEnabled
      ? https.createServer({ cert: await readFile(config.tlsCertificatePath!), key: await readFile(config.tlsPrivateKeyPath!) },
        (request, response) => this.requestHandler(request, response)).listen(config.port, '0.0.0.0', listening)
      : http.createServer((request, response) => this.requestHandler(request, response)).listen(config.port, '0.0.0.0', listening);
    new LoopbackHealthListener(() => this.requestHandler, Number(process.env.SULLA_FILES_HEALTH_PORT ?? 8793)).listen();
    return server;
  }

  /** Desktop only: clears interrupted uploads and runs the legacy preflight over the watched root. */
  private async prepareStorage(db:pg.Pool, config:Config):Promise<void> {
    const processDiagnostics = new FilesStartupDiagnostics();
    if (config.mode === 'desktop') {
      await cleanupStaleUploads(db, new Store(config.chunkRoot)).catch(error => processDiagnostics.cleanupFailed(error));
    }
    if (config.mode === 'desktop' && config.filesRoot) {
      processDiagnostics.stage('preflight');
      try {
        config.legacyPreflight = await runLegacyPreflight(db, config.filesRoot, { caseInsensitive: config.caseInsensitiveRoot });
        processDiagnostics.completed('preflight');
      } catch (error) {
        processDiagnostics.failed('preflight', error);
        throw error;
      }
    }
  }

  private async composeServices(db:pg.Pool, config:Config):Promise<FilesServices> {
    const keyring = config.keyring = new FilesKeyring(db, undefined, undefined, undefined, new LegacySigningKeySelector(new Store(config.chunkRoot)), () => ProfileIdentity.fromCloudUserId(config.userId));
    // Org roots live in the same principal-keyed partitions as the collection keys above.
    const orgRootKeys = new OrgRootKeyCache(() => ProfileIdentity.fromCloudUserId(config.userId));
    const profileCaches = new ProfileCaches([keyring, orgRootKeys], () => config.userId);
    // Cloud sync and its chunk source exist only when the vault broker identity is configured.
    const cloudBroker = config.mode === 'desktop' && config.vaultBrokerServiceToken ? new FilesCloudBroker(config) : undefined;
    const cloudChunkSource:CloudChunkSource | undefined = cloudBroker
      ? new FilesCloudChunkSource(db, new FilesSyncCloudApi(cloudBroker), new CloudRootKeyStore(config.keyring))
      : undefined;
    const chunkStore = createChunkStore({ db, root: config.chunkRoot, keyring: config.keyring, source: config.mode === 'desktop' && !config.filesRoot ? cloudChunkSource : undefined });
    const vaultAuthority = configuredVaultFilesKeyBundleAuthority(config);
    // Adoption zeroizes the previous principal's partition the moment config.userId changes.
    const vaultPrincipalAdoption = new VaultPrincipalAdoption(db, undefined, undefined, previousUserId => profileCaches.invalidatePrincipal(previousUserId));
    const keyRecovery = vaultAuthority && config.keyring instanceof FilesKeyring
      ? new FilesKeyBundleRecovery(db, config.keyring, vaultAuthority)
      : undefined;
    const embedder = PotionEmbedder.load(config.modelDir);
    const indexer = new IndexingQueue(db, storedIndexSource(db, config, chunkStore), embedder);
    const manager = config.mode === 'desktop' ? new LocalFilesManager(db, config, indexer, undefined, chunkStore) : undefined;
    const residency = manager && config.filesRoot && config.serverUrl && vaultAuthority && keyRecovery && config.keyring instanceof FilesKeyring
      ? new FileResidencyManager(
        db,
        new Store(config.chunkRoot),
        config.keyring,
        new SecureCollectionKeyExchange(db, config.keyring, vaultAuthority, keyRecovery),
        new HttpResidencyTransport({
          serverUrl: config.serverUrl,
          principalId: () => config.userId,
          deviceId: config.deviceId,
          capabilitySigningKey: config.capabilitySigningKey,
          bundleFor: version => loadResidencySyncBundle(db, version),
        }),
        manager.mutations,
      )
      : undefined;
    const enrichment = config.mode === 'desktop' && config.filesRoot ? new RecordingEnrichmentQueue(db, config.filesRoot) : undefined;
    // Search has a separate, deliberately small pool so expensive recall cannot starve FUSE or listings.
    const searchDb = await connect(config.databaseUrl, 2);
    const search = new FileSearch(searchDb, embedder);
    return { keyring, orgRootKeys, profileCaches, cloudBroker, chunkStore, vaultAuthority, keyRecovery, vaultPrincipalAdoption, indexer, manager, residency, enrichment, search };
  }

  /** Brings up identity, collections, the watched folder, indexing and enrichment once per unlock. */
  private initialize(db:pg.Pool, config:Config, services:FilesServices, reportStage:(stage:FilesStartupStage)=>void):Promise<void> {
    const { vaultAuthority, vaultPrincipalAdoption, manager, keyRecovery, residency, indexer, enrichment } = services;
    this.initialization ??= (async() => {
      if (vaultAuthority) {
        reportStage('identity-adoption');
        const { principalId } = await vaultAuthority.unlockedPrincipal();
        await vaultPrincipalAdoption.adopt(config, principalId);
      }
      await migrateSullaCollection(db, config);
      await trashStrayDocs(db, config).catch(error => console.warn('[SullaFiles] stray Docs cleanup failed:', error));
      await ensureSystemAreas(db, config);
      if (manager) {
        reportStage('manager-initialization');
        await manager.initialize(async() => {
          if (keyRecovery) {
            reportStage('recovery-enrollment');
            await keyRecovery.enrollAllCollections(config.userId);
          }
          if (residency) {
            reportStage('residency-recovery');
            await residency.recoverPending();
          }
          reportStage('manager-initialization');
        });
      } else if (keyRecovery) {
        reportStage('recovery-enrollment');
        await keyRecovery.enrollAllCollections(config.userId);
      }
      reportStage('indexer');
      await indexer.start();
      if (enrichment) {
        reportStage('enrichment');
        await enrichment.start();
      }
    })().catch(error => { this.initialization = undefined; throw error });
    return this.initialization;
  }

  private async lock(services:FilesServices):Promise<void> {
    await Promise.all([services.manager?.close(), services.indexer.close(), services.enrichment?.close()]);
    this.initialization = undefined;
  }

  private async serve(server:http.Server | https.Server, db:pg.Pool, config:Config, services:FilesServices):Promise<void> {
    const { keyring, orgRootKeys, profileCaches, cloudBroker, chunkStore, vaultAuthority, keyRecovery, indexer, manager, residency, enrichment, search } = services;
    const recover = keyRecovery && vaultAuthority
      ? async(master:Buffer) => {
        const { principalId } = await vaultAuthority.unlockedPrincipal();
        return keyRecovery.recoverDeviceMaster(master, principalId);
      }
      : undefined;
    // Desktop's sign-out/lock reaches this through POST /v1/desktop/org-profiles/invalidate-current.
    const lifecycle = new FilesLifecycle(db, config, keyring, { initialize: reportStage => this.initialize(db, config, services, reportStage), stop: async()=>{orgRootKeys.clear();await this.lock(services)}, recover });
    const bootstrapAuthority = config.mode === 'desktop'
      ? new FilesBootstrapAuthority(
        config.bootstrapServiceId ?? 'sulla-desktop-files-bootstrap',
        config.bootstrapToken ?? (() => { throw new Error('SULLA_FILES_BOOTSTRAP_TOKEN is required in desktop mode') })(),
        lifecycle,
      )
      : undefined;
    const cloudSync = cloudBroker && config.keyring instanceof FilesKeyring
      ? new CloudSyncService(db, config, config.keyring, chunkStore, cloudBroker, orgRootKeys)
      : undefined;
    if (manager && cloudSync) manager.setCloudCommitWakeup(collectionId => cloudSync.versionCommitted(collectionId));
    if (chunkStore instanceof CachingStore) await chunkStore.start();
    const app = new FilesApplication({ db, config, manager, search, residency, filesLifecycle: lifecycle, bootstrapAuthority, indexer, chunkStore, cloudSync, profileCaches }).build();
    const memoryTelemetry = new MemoryTelemetry(() => ({
      requests: Object.fromEntries(app.locals.inFlightRequests ?? []),
      indexer: indexer.diagnosticJob,
      enrichment: enrichment?.diagnosticJob ?? null,
    }));
    memoryTelemetry.start();
    process.once('SIGTERM', () => memoryTelemetry.close());
    process.once('SIGINT', () => memoryTelemetry.close());
    this.requestHandler = app;
    startSearchCleanup(db);
    startRetiredSystemAreaCleanup(db, (collectionId, chunkId) => chunkStore.delete(collectionId, chunkId));
    startVectorBackfill(db);
    if(config.mode==='desktop') app.locals.backupScheduler.start();
    if(config.mode==='desktop') app.locals.catalogSync.start();
    if(config.mode==='desktop') app.locals.desktopRequests.start();
    cloudSync?.start();
    const auditTimer=setInterval(()=>{ if (lifecycle.ready) void app.locals.auditWriter.drain().catch((error:unknown)=>console.error('[SullaFiles] audit delivery failed; retry pending',error)) },1000);
    auditTimer.unref();
    console.log(`[SullaFiles] ${ config.mode } service ready on ${ config.port }`);
    for (const signal of ['SIGTERM', 'SIGINT']) {
      process.on(signal, async() => {
        clearInterval(auditTimer);
        cloudSync?.stop();
        if (chunkStore instanceof CachingStore) await chunkStore.stop();
        app.locals.backupScheduler.stop();
        app.locals.catalogSync.stop();
        app.locals.desktopRequests.stop();
        app.locals.backupRuntime.stop();
        try{await app.locals.liveTextSessions.close();}catch(error){console.error('[SullaFiles] live flush failed; refusing shutdown before persistence',error);return;}
        server.closeAllConnections();
        server.close(() => {
          lifecycle.lock().finally(() => {
            return db.end().finally(() => process.exit(0));
          }).catch(() => process.exit(1));
        });
      });
    }
  }
}
