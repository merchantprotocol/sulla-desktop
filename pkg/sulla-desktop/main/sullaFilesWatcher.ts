// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { traceAsync, traceEvent } from '@pkg/utils/startupTrace';
import fs from 'node:fs';
import path from 'node:path';

import { app } from 'electron';

import { SullaFilesBootstrapFacade } from './sullaFilesBootstrapFacade';
import { NativeSourceRevalidator } from './NativeSourceRevalidator';
import { VaultFilesStartup, type VaultFilesStartupSnapshot } from './VaultFilesStartup';
import { boundedFilesResponseReader } from './sullaFilesBoundedResponse';
import { getSullaFilesMountManager } from './sullaFilesMountManager';
import { SullaFilesNativeBroker } from './sullaFilesNativeBroker';
import { getSullaFilesSourceGateway, lockSullaFilesSourceGateway, unlockSullaFilesSourceGateway } from './sullaFilesSourceGateway';
import { FINDER_BADGE_MIN_INTERVAL_MS } from './sullaFinderBadges';
import { SullaUseCaseFiles } from './sullaUseCaseFiles';
import { SullaUseCaseFilesRequest } from './SullaUseCaseFilesRequest';
import { UseCaseSuggestionCompositionRoot } from '@pkg/agent/useCases/UseCaseSuggestionCompositionRoot';
import type { SuggestionOptions, UseCaseSuggestion } from '@pkg/agent/useCases/UseCaseSuggestionIndex';
import { getBuiltinSkillSpecs } from '@pkg/agent/builtinSkills';
import { postgresClient } from '@pkg/agent/database/PostgresClient';
import { redisClient } from '@pkg/agent/database/RedisClient';
import { RedisUseCaseChangeTransport } from '@pkg/agent/useCases/UseCaseChangeBus';

import { SullaSettingsModel } from '@pkg/agent/database/models/SullaSettingsModel';
import Logging from '@pkg/utils/logging';
import { sullaFilesNativeSourceRolloutRequested, type SullaFilesNativeRuntimeStatus } from '@pkg/utils/sullaFilesNativeSource';
import { resolveSullaFilesUserRoot } from '@pkg/utils/sullaFilesPaths';

const console = Logging.background;
import { DEFAULT_IGNORES, NATIVE_POLL_ACTIVE_MS, NATIVE_POLL_IDLE_MAX_MS, UNLOCK_RETRY_DELAYS_MS, ignored, type NativeSourceIngestInput, type NativeSourceFileResult, type RecentSullaFile, type SullaFilesCapabilityContext, type SullaFilesRootStatus, type SullaFilesStatus } from './SullaFilesWatcherSupport';
import { SullaFilesWatcherRequestService } from './SullaFilesWatcherRequestService';
import { SullaFilesWatcherTrackedRoots, type SullaFilesTrackedRoot } from './SullaFilesWatcherTrackedRoots';
import { SullaFilesWatcherOperations } from './SullaFilesWatcherOperations';
import { SullaFilesGenerationRun } from './SullaFilesGenerationRun';

export class SullaFilesWatcher {
  readonly folder = resolveSullaFilesUserRoot().activePath;
  private readonly filesRequests = new SullaFilesWatcherRequestService(() => this.ensureUnlocked(), () => this.appUnlocked(), () => this.stopped);
  private rescanTimer?: NodeJS.Timeout;
  private safetyTimer?: NodeJS.Timeout;
  private badgeTimer?: NodeJS.Timeout;
  private nativeTimer?: NodeJS.Timeout;
  private nativeRevalidationTimer?: NodeJS.Timeout;
  private nativeRevalidationFailures = 0;
  private nativeRevalidationRun?: Promise<void>;
  private nativePolling = false;
  private unlocking = 0;
  private nativePollRunning = false;
  private nativePollDelayMs = NATIVE_POLL_ACTIVE_MS;
  private nativeNextPollAt = 0;
  private readonly suggestionRoot = new UseCaseSuggestionCompositionRoot(postgresClient, getBuiltinSkillSpecs().map(skill => skill.slug), new RedisUseCaseChangeTransport(redisClient));
  private readonly useCaseFilesRequest = new SullaUseCaseFilesRequest(
    (endpoint, init = {}) => this.requestFiles(endpoint, init),
    (endpoint, init = {}) => this.requestNativeFiles(endpoint, init),
  );
  private readonly useCases = new SullaUseCaseFiles((endpoint, init = {}) => this.useCaseFilesRequest.send(endpoint, init), this.suggestionRoot.notifier);
  private nativeEnabled = false;
  private started = false;
  private stopped = false;
  private lockGeneration = 0;
  private unlockRetryEpoch = 0;
  private unlockPermitted = false;
  private lockPromise?: Promise<void>;
  private readonly bootstrap = new SullaFilesBootstrapFacade();
  private filesRecoveryRun?:Promise<void>;
  private readonly ensureUnlockedRuns = new SullaFilesGenerationRun();
  private readonly startup:VaultFilesStartup;
  private readonly nativeSourceRevalidator:NativeSourceRevalidator;
  private readonly nativeBroker = new SullaFilesNativeBroker({
    actions: async() => {
      const response = await this.filesRequests.rawLocalRequest('/v1/local/native-sources/actions');

      if (!response.ok) throw new Error(`Native publication actions failed (${ response.status })`);
      return response.json();
    },
    sources: () => this.filesRequests.listNativeSourcesRaw(),
    content: async(operationId) => {
      const response = await this.filesRequests.rawLocalRequest(`/v1/local/native-sources/actions/${ encodeURIComponent(operationId) }/content`);

      return boundedFilesResponseReader.read(response);
    },
    read:      handle => getSullaFilesSourceGateway().read(handle),
    signature: handle => getSullaFilesSourceGateway().signature(handle),
    write:    (handle, expectedRevision, bytes) => getSullaFilesSourceGateway().write(handle, expectedRevision, bytes),
    ingest:   input => this.ingestNativeSource(input),
    finish:   (operationId, result) => this.finishNativePublication(operationId, result),
    logError: (message, error) => console.debug(`[SullaFiles] ${ message }:`, error),
  });

  constructor(startup:VaultFilesStartup, createNativeSourceRevalidator:(post:ConstructorParameters<typeof NativeSourceRevalidator>[0]['post']) => NativeSourceRevalidator) {
    this.startup = startup;
    this.nativeSourceRevalidator = createNativeSourceRevalidator((handles, replaceExisting) => this.filesRequests.rawLocalRequest('/v1/local/native-sources/revalidate', {
      method: 'POST', body: JSON.stringify({ handles, replaceExisting }),
    }));
  }

  private async appUnlocked(): Promise<boolean> {
    const { getVaultKeyService } = await import('@pkg/agent/services/VaultKeyService');
    return getVaultKeyService().isUnlocked();
  }

  private async requireAppUnlocked(): Promise<void> {
    if (this.stopped || !await this.appUnlocked()) throw new Error('Files is locked with the application');
  }

  async lockService(): Promise<void> {
    if (this.lockPromise) return this.lockPromise;
    this.unlockRetryEpoch++;
    if (this.nativeRevalidationTimer) clearTimeout(this.nativeRevalidationTimer);
    this.nativeRevalidationTimer = undefined;
    this.useCases.stop();
    this.lockGeneration++;
    this.unlockPermitted = false;
    this.startup.vaultLocked();
    this.nativePolling = false;
    const lock = (async() => {
      // Stop guest admission first so dirty FUSE handles can flush through the
      // still-live broker. Then drain publication work, revoke host handles,
      // and finally zero Files keys.
      await getSullaFilesMountManager().stop();
      await this.nativeBroker.suspendAndDrain(lockSullaFilesSourceGateway);
      const response = await this.filesRequests.rawLocalRequest('/v1/local/lock', { method: 'POST' }).catch(() => undefined);

      await this.bootstrap.settled();
      const postHelper = await this.filesRequests.rawLocalRequest('/v1/local/lock', { method: 'POST' });

      if (!response?.ok || !postHelper.ok) throw new Error('Files service could not be locked');
    })();

    this.lockPromise = lock;
    try { await lock } finally { if (this.lockPromise === lock) this.lockPromise = undefined; }
  }

  async unlockService():Promise<void> {
    if (this.lockPromise) await this.lockPromise;
    this.startup.vaultUnlocking();
    this.lockGeneration++;
    this.unlockPermitted = true;
    this.unlocking++;
    try { await traceAsync('files ensureUnlocked', () => this.ensureUnlocked()) } finally { this.unlocking-- }
    // Roots may have tried to enroll while a restarted Files container was
    // still locked. Retry each stored root once after unlock succeeds.
    const { getSullaFilesRootRegistry } = await import('./sullaFilesRootRegistry');
    for (const root of await getSullaFilesRootRegistry().stored()) {
      await this.enrollRoot(root).catch(error => console.warn(`[SullaFiles] tracked root ${ root.id } re-enrollment after unlock failed:`, error));
    }
    this.suggestionRoot.start();
    this.useCases.start();
  }

  /**
   * Startup unlock that survives a transient failure, such as the Files
   * container restarting or being replaced by an image update mid-bootstrap.
   * Retries with backoff until it succeeds; stands down when Files is locked
   * or the watcher stops, and only then rethrows the last error.
   */
  async unlockServiceWithRetry():Promise<void> {
    const epoch = ++this.unlockRetryEpoch;
    let lastReason:string | undefined;

    for (let failures = 0; ; failures++) {
      try {
        await this.unlockService();
        if (lastReason) console.log('[SullaFiles] Files unlock recovered');
        return;
      } catch (error) {
        if (epoch !== this.unlockRetryEpoch || this.stopped || !await this.appUnlocked()) throw error;
        const reason = error instanceof Error ? error.message : String(error);
        if (reason === 'Files unlock was superseded') {
          failures--;
          continue;
        }
        const delay = UNLOCK_RETRY_DELAYS_MS[Math.min(failures, UNLOCK_RETRY_DELAYS_MS.length - 1)];

        if (reason !== lastReason || (failures + 1) % 5 === 0) {
          console.warn(`[SullaFiles] Files unlock attempt ${ failures + 1 } failed; retrying in ${ delay / 1000 }s:`, error);
        }
        lastReason = reason;
        await new Promise(resolve => setTimeout(resolve, delay).unref());
        if (epoch !== this.unlockRetryEpoch || this.stopped) return;
      }
    }
  }

  /** Re-bootstrap promptly after the supervisor restarts Files without relocking the app vault. */
  async recoverAfterContainerRestart():Promise<void> {
    if (this.filesRecoveryRun) return this.filesRecoveryRun;
    this.startup.filesLocked();
    const run = (async() => {
      if (!await this.appUnlocked() || this.stopped) return;
      await this.unlockServiceWithRetry();
    })().finally(() => { if (this.filesRecoveryRun === run) this.filesRecoveryRun = undefined });
    this.filesRecoveryRun = run;
    return run;
  }

  private ensureUnlocked():Promise<void> {
    return this.ensureUnlockedRuns.run(this.lockGeneration, generation => this.performEnsureUnlocked(generation));
  }

  private async performEnsureUnlocked(generation:number): Promise<void> {
    this.assertUnlockGeneration(generation);
    await this.requireAppUnlocked();
    this.startup.filesUnlocking();
    this.assertUnlockGeneration(generation);
    const response = await traceAsync('files /healthz', () => this.filesRequests.rawLocalRequest('/healthz', {}, 120_000));

    this.assertUnlockGeneration(generation);
    if (!response.ok) throw new Error(`Files service is unavailable at /healthz (${ response.status })`);
    const health = await response.json();

    this.assertUnlockGeneration(generation);
    // Never send a master key to an older image with no memory-only protocol.
    if (typeof health.locked !== 'boolean') throw new Error('Files service requires a keychain-compatible update');
    if (!health.legacyImport || !['clear', 'secure-import-required'].includes(health.legacyImport.state)) throw new Error('Files service requires a legacy-preflight-compatible update');
    if (health.locked) {
      const result = await traceAsync('files secure bootstrap', () => this.bootstrap.initialize());

      this.assertUnlockGeneration(generation);
      if (!result.ok || result.state !== 'unlocked') throw new Error(result.code ?? 'Files secure bootstrap failed');
    }
    await this.requireAppUnlocked();
    this.assertUnlockGeneration(generation);
    this.startup.filesUnlocked();
    unlockSullaFilesSourceGateway();
    if (this.nativeEnabled) {
      // Revalidation is optional native-source capability, not a prerequisite
      // for Files itself. Retry it independently if Files is still starting.
      void this.revalidateNativeSources(generation);
      // The Files service remains usable when the optional guest FUSE adapter
      // cannot start (for example, an older VM kernel lacks /dev/fuse). The
      // mount reports its own error state and can be retried on the next
      // unlock; it must not make Files unlock fail or block desktop startup.
      // Not awaited: the mount manager retries on its own schedule, and the
      // guest mount must never hold up unlock or startup.
      traceEvent('ensureUnlocked: handing off to mount manager (not awaited)');
      traceAsync('mount manager start', () => getSullaFilesMountManager().start(
        () => this.filesRequests.fuseMountCredentials(),
        () => this.startup.mountTokenWritten(),
        () => this.startup.mounted(),
      )).catch(error => {
        console.warn('[SullaFiles] guest FUSE mount unavailable; continuing without the mount:', error);
      });
    } else {
      // Native mounting is off by design here, so Files is ready without a token.
      this.startup.mountNotRequired();
    }
  }

  private revalidateNativeSources(generation:number):Promise<void> {
    if (this.nativeRevalidationRun) return this.nativeRevalidationRun;
    if (this.nativeRevalidationTimer) clearTimeout(this.nativeRevalidationTimer);
    this.nativeRevalidationTimer = undefined;
    const run = traceAsync('files native-sources revalidate', async() => {
      await this.nativeSourceRevalidator.revalidate(getSullaFilesSourceGateway().activeHandles());
      this.assertUnlockGeneration(generation);
      this.nativeRevalidationFailures = 0;
      this.startup.filesUnlocked();
      if (!this.nativePolling) {
        this.nativeBroker.resume();
        this.nativePolling = true;
      }
    }).catch(error => {
      if (!this.unlockPermitted || generation !== this.lockGeneration || this.stopped) return;
      const failures = ++this.nativeRevalidationFailures;
      if (failures === 1 || failures % 5 === 0) {
        console.warn(`[SullaFiles] native source features degraded; revalidation attempt ${ failures } failed:`, error);
      }
      this.startup.degrade(`Native source revalidation failed: ${ error instanceof Error ? error.message : String(error) }`);
      const delay = UNLOCK_RETRY_DELAYS_MS[Math.min(failures - 1, UNLOCK_RETRY_DELAYS_MS.length - 1)];

      if (this.nativeRevalidationTimer) clearTimeout(this.nativeRevalidationTimer);
      this.nativeRevalidationTimer = setTimeout(() => {
        this.nativeRevalidationTimer = undefined;
        void this.revalidateNativeSources(generation);
      }, delay);
      this.nativeRevalidationTimer.unref();
    }).finally(() => { if (this.nativeRevalidationRun === run) this.nativeRevalidationRun = undefined });

    this.nativeRevalidationRun = run;
    return run;
  }

  private assertUnlockGeneration(generation:number):void {
    if (!this.unlockPermitted || this.stopped) throw new Error('Files is shutting down');
    if (generation !== this.lockGeneration) throw new Error('Files unlock was superseded');
  }

  async initialize():Promise<void> {
    if (this.started) return; this.started = true; this.stopped = false;
    this.nativeEnabled = sullaFilesNativeSourceRolloutRequested();
    const { getSullaFilesRootRegistry } = await import('./sullaFilesRootRegistry');
    const registry = getSullaFilesRootRegistry();
    await traceAsync('files startBookmarks', () => registry.startBookmarks());
    app.once('before-quit', () => { registry.stopBookmarks(); this.shutdown().catch(error => console.warn('[SullaFiles] shutdown failed:', error)) }); await fs.promises.mkdir(this.folder, { recursive: true, mode: 0o700 });
    const storedRoots=await traceAsync('files registry.stored', () => registry.stored());
    await this.trackedRoots.configureFinderRoots(storedRoots.map(root=>root.path));
    for (const root of storedRoots) {
      this.trackedRoots.watchRoot(root.id, root.path);
    }
    // Enrollment talks to Files and must not race the locked boot state.
    // unlockService() enrolls every stored root after secure bootstrap succeeds.
    this.safetyTimer = setInterval(() => this.notifyRescan().catch(error => console.debug('[SullaFiles] periodic rescan failed:', error)), 5 * 60_000); this.safetyTimer.unref();
    this.badgeTimer = setInterval(() => this.refreshFinderBadges().catch(error => console.debug('[SullaFiles] Finder badge refresh failed:', error)), FINDER_BADGE_MIN_INTERVAL_MS + 5_000); this.badgeTimer.unref();
    setTimeout(() => this.notifyRescan().catch(error => console.debug('[SullaFiles] startup rescan failed:', error)), 2_000).unref();
    const pauseUntil = Number(await SullaSettingsModel.get('sullaFilesPauseUntil', 0));
    if (pauseUntil > Date.now()) await this.pauseFor(pauseUntil - Date.now());
    else if (pauseUntil) await SullaSettingsModel.set('sullaFilesPauseUntil', 0, 'number');
    if (this.nativeEnabled) {
      this.nativeTimer = setInterval(() => this.pollNativePublications().catch(error => console.debug('[SullaFiles] native publication poll failed:', error)), 250);
      this.nativeTimer.unref();
    }
  }

  /** Files sync must wait until initialization and the current unlock both settle. */
  isReadyForSync():boolean { return this.started && !this.stopped && this.unlockPermitted && this.unlocking === 0 }

  startupStatus():VaultFilesStartupSnapshot { return this.startup.snapshot() }

  async shutdown():Promise<void> { this.stopped = true; this.nativePolling = false; this.useCases.stop(); this.suggestionRoot.stop(); await this.lockService().catch(() => undefined); this.trackedRoots.shutdown(); this.operations.stop(); if (this.rescanTimer) clearTimeout(this.rescanTimer); if (this.safetyTimer) clearInterval(this.safetyTimer); if (this.badgeTimer) clearInterval(this.badgeTimer); if (this.nativeTimer) clearInterval(this.nativeTimer); this.started = false }
  private scheduleRescan():void {
    if (this.rescanTimer) clearTimeout(this.rescanTimer);
    this.rescanTimer = setTimeout(() => {
      this.rescanTimer = undefined;
      this.notifyRescan().catch(error => console.debug('[SullaFiles] debounced rescan failed:', error));
    }, 350);
  }

  private async patterns():Promise<string[]> { try { return [...DEFAULT_IGNORES, ...(await fs.promises.readFile(path.join(this.folder, '.sullaignore'), 'utf8')).split(/\r?\n/)] } catch { return DEFAULT_IGNORES } }
  private async changed(relativePath:string):Promise<void> {
    if (ignored(relativePath, await this.patterns())) return; const absolute = path.resolve(this.folder, relativePath); if (!absolute.startsWith(`${ this.folder }${ path.sep }`)) return;
    try { const first = await fs.promises.stat(absolute); if (!first.isFile()) return; await new Promise(resolve => setTimeout(resolve, 600)); const second = await fs.promises.stat(absolute); if (first.size !== second.size || first.mtimeMs !== second.mtimeMs) return this.changed(relativePath); } catch { /* rename/delete: rescan now */ }
    this.scheduleRescan();
  }

  async prepareNativeSourceSession():Promise<void> {
    // This also advances the gateway unlock epoch only after Files and the
    // application vault have both proved they are unlocked.
    await this.ensureUnlocked();
  }

  async listNativeSources():Promise<Awaited<ReturnType<SullaFilesWatcherRequestService['listNativeSources']>>> { return this.filesRequests.listNativeSources() }

  nativeRuntimeStatus():SullaFilesNativeRuntimeStatus {
    return getSullaFilesMountManager().status();
  }

  async requestFiles(endpoint:string, init:RequestInit = {}, server = false, capability:SullaFilesCapabilityContext = {}):Promise<Response> { return this.filesRequests.requestFiles(endpoint, init, server, capability) }
  async requestNativeFiles(endpoint:string, init:RequestInit = {}):Promise<Response> { return this.filesRequests.requestNativeFiles(endpoint, init) }
  async requestFilesStream(endpoint:string, init:RequestInit = {}, signal?:AbortSignal):Promise<Response> { return this.filesRequests.requestFilesStream(endpoint, init, signal) }

  async notifyRescan():Promise<void> {
    return this.notifyRescanNow();
  }

  private async notifyRescanNow():Promise<void> {
    try {
      const response = await this.filesRequests.localRequest('/v1/local/rescan', { method: 'POST' }); if (!response.ok) throw new Error(`HTTP ${ response.status }`);
      await this.refreshFinderBadges();
    } catch (error) { console.debug('[SullaFiles] optional container is offline; folder remains local-only:', error) }
  }

  private readonly operations = new SullaFilesWatcherOperations(this.filesRequests, this.folder);
  private readonly trackedRoots = new SullaFilesWatcherTrackedRoots({
    filesRequests: this.filesRequests,
    rootStatuses: () => this.operations.rootStatuses(),
    requestFiles: (endpoint, init) => this.requestFiles(endpoint, init),
    refreshFinderBadges: () => this.operations.refreshFinderBadges(),
    clearBadge: id => this.operations.clearBadge(id),
  });

  async enrollRoot(root:SullaFilesTrackedRoot):Promise<SullaFilesRootStatus> { return this.trackedRoots.enrollRoot(root) }
  async forgetRoot(id:string):Promise<void> { await this.trackedRoots.forgetRoot(id) }
  private refreshFinderBadges():Promise<void> { return this.operations.refreshFinderBadges() }
  async status():Promise<SullaFilesStatus> { return this.operations.status() }
  async setPaused(paused:boolean):Promise<SullaFilesStatus> { return this.operations.setPaused(paused) }
  async rootStatuses():Promise<SullaFilesRootStatus[]> { return this.operations.rootStatuses() }
  async configureRoot(id:string, input:{ paused?:boolean; syncMode?:'local' | 'server'; exclusions?:string[] }):Promise<SullaFilesRootStatus> { return this.operations.configureRoot(id, input) }
  async detachRoot(id:string):Promise<void> { return this.operations.detachRoot(id) }
  async pauseFor(ms:number):Promise<SullaFilesStatus> { return this.operations.pauseFor(ms) }
  async recentFiles(limit = 4):Promise<RecentSullaFile[]> { return this.operations.recentFiles(limit) }
  async findFile(relativePath:string):Promise<RecentSullaFile | undefined> { return this.operations.findFile(relativePath) }
  async ingestNativeSource(input:NativeSourceIngestInput):Promise<NativeSourceFileResult> { return this.operations.ingestNativeSource(input) }
  async planNativePublication(input:{ operationId:string; handle:string; sourceRevision:string; contentHash:string; fileId:string; baseVersionId:string }):Promise<void> { return this.operations.planNativePublication(input) }
  async finishNativePublication(operationId:string, result:{ nextSourceRevision?:string; originalSourceRevision?:string; originalSourceHash?:string; currentSourceHash?:string; filesBaseVersionId?:string; currentFilesVersionId?:string; error?:string; conflictFileId?:string; currentSourceRevision?:string }):Promise<void> { return this.operations.finishNativePublication(operationId, result) }
  async reselectInterruptedNativePublication(input:{ fileId:string; previousHandle:string; handle:string; sourceRevision:string; sourceHash:string }):Promise<boolean> { return this.operations.reselectInterruptedNativePublication(input) }

  /**
   * Publication poll. Runs every 250 ms only while publications are active;
   * otherwise backs off to NATIVE_POLL_IDLE_MAX_MS. Never overlaps itself.
   */
  private async pollNativePublications():Promise<void> {
    if (!this.nativePolling || this.stopped || this.nativePollRunning || Date.now() < this.nativeNextPollAt) return;
    this.nativePollRunning = true;
    try {
      await this.nativeBroker.poll();
    } finally {
      this.nativePollRunning = false;
      this.nativePollDelayMs = this.nativeBroker.lastPollActive ? NATIVE_POLL_ACTIVE_MS : Math.min(NATIVE_POLL_IDLE_MAX_MS, this.nativePollDelayMs * 2);
      this.nativeNextPollAt = Date.now() + this.nativePollDelayMs;
    }
  }

  async queryUseCaseSuggestions(text:string, options?:SuggestionOptions):Promise<UseCaseSuggestion[]> { return this.suggestionRoot.index.suggest(text, options); }

  async folderForCollection(collectionId?:string):Promise<string> { return this.operations.folderForCollection(collectionId) }
  async openFolder(collectionId?:string):Promise<void> { return this.operations.openFolder(collectionId) }
}

export { SullaFilesWatcherProvider, sullaFilesWatcherProvider, getSullaFilesWatcher } from './SullaFilesWatcherProvider';
export type { NativeSourceFileResult, NativeSourceIngestInput, RecentSullaFile, SullaFilesCapabilityContext, SullaFilesRootStatus, SullaFilesStatus } from './SullaFilesWatcherSupport';
