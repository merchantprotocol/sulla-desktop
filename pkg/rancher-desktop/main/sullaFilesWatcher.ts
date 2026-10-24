import { traceAsync, traceEvent } from '@pkg/utils/startupTrace';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { app, powerMonitor, shell } from 'electron';

import { SullaFilesBootstrapFacade } from './sullaFilesBootstrapFacade';
import { readBoundedResponse } from './sullaFilesBoundedResponse';
import { getSullaFilesMountManager } from './sullaFilesMountManager';
import { SullaFilesNativeBroker } from './sullaFilesNativeBroker';
import { getSullaFilesSourceGateway, lockSullaFilesSourceGateway, unlockSullaFilesSourceGateway } from './sullaFilesSourceGateway';
import { FINDER_BADGE_ATTRIBUTE, FinderBadgeSync } from './sullaFinderBadges';
import { SullaFilesSystemIngestJob, type SystemIngestRequest, type SystemIngestStatus } from './sullaFilesSystemIngest';
import { sullaAppGroupDefaultsDomain } from './sullaAppGroup';
import { desktopFilesFetch, FILES_HTTPS_ORIGIN } from './sullaFilesTls';
import { SullaUseCaseFiles } from './sullaUseCaseFiles';

import {
  resolveSullaConversationsDir,
  resolveSullaDocsDir,
  resolveSullaLogsDir,
} from '@pkg/agent/utils/sullaPaths';
import { SullaSettingsModel } from '@pkg/agent/database/models/SullaSettingsModel';
import { getDesktopDeviceId } from '@pkg/main/deviceIdentity';
import { spawnFile } from '@pkg/utils/childProcess';
import Logging from '@pkg/utils/logging';
import { sullaFilesCapabilityKey } from '@pkg/utils/sullaFilesKey';
import { sullaFilesNativeSourceRolloutRequested, type SullaFilesNativeRuntimeStatus } from '@pkg/utils/sullaFilesNativeSource';
import { resolveSullaFilesUserRoot } from '@pkg/utils/sullaFilesPaths';

const console = Logging.background;
const DEFAULT_IGNORES = ['.DS_Store', '._*', '*.tmp', '~$*', '.git/', 'node_modules/', '*.sulla-conflict-*', '.sulla-trash/'];
const API = FILES_HTTPS_ORIGIN;
const NATIVE_POLL_ACTIVE_MS = 250;
const NATIVE_POLL_IDLE_MAX_MS = 2_000;
const NATIVE_SOURCE_PAGE_SIZE = 500;
const NATIVE_SOURCE_MAX_PAGES = 40;
const UNLOCK_RETRY_DELAYS_MS = [2_000, 5_000, 10_000, 30_000, 60_000];


export interface SullaFilesStatus {
  state:             'synced' | 'syncing' | 'paused' | 'error' | 'conflict';
  pendingFiles:      number;
  pendingBytes?:     number;
  processedBytes?:   number;
  totalBytes?:       number;
  estimatedSeconds?: number;
  lastError?:        string;
  lastScanAt?:       string;
  lastSyncAt?:       string;
  serverConfigured:  boolean;
  location?:         'local' | 'server' | 'cloud';
  serverLabel?:      string;
}

export interface SullaFilesRootStatus {
  id:               string;
  name:             string;
  collectionId:     string;
  syncMode:         'local' | 'server';
  paused:           boolean;
  exclusions:       string[];
  state:            'idle' | 'scanning' | 'syncing' | 'paused' | 'offline' | 'error' | 'detached';
  pendingFiles:     number;
  serverConfigured: boolean;
  lastError?:       string;
  lastScanAt?:      string;
  lastSyncAt?:      string;
}

export interface NativeSourceFileResult {
  id:                 string;
  current_version_id: string;
  path:               string;
  mime:               string;
  size:               number;
}

export interface RecentSullaFile {
  id:               string;
  path:             string;
  mime:             string;
  size:             number;
  updatedAt:        string;
  conflict:         boolean;
  durationSeconds?: number;
  syncState:        'synced' | 'syncing' | 'error';
}

export interface SullaFilesCapabilityContext {
  agentId?:  string;
  jobId?:    string;
  threadId?: string;
}

function requestHeaders(initHeaders:HeadersInit | undefined, internal:Record<string, string>, defaults:Record<string, string> = {}):Headers {
  const headers = new Headers(initHeaders);

  for (const [name, value] of Object.entries(defaults)) {
    if (!headers.has(name)) headers.set(name, value);
  }
  for (const [name, value] of Object.entries(internal)) headers.set(name, value);

  return headers;
}

function ignored(relativePath:string, patterns:string[]):boolean {
  const normalized = relativePath.split(path.sep).join('/'); const parts = normalized.split('/');
  return patterns.some(raw => { const pattern = raw.trim().replace(/^\//, ''); if (!pattern || pattern.startsWith('#')) return false; if (pattern.endsWith('/')) return parts.slice(0, -1).includes(pattern.slice(0, -1)); const expression = new RegExp(`^${ pattern.split('*').map(value => value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&')).join('.*') }$`); return expression.test(normalized) || parts.some(part => expression.test(part)) });
}
function isSensitiveTrackedPath(relativePath:string):boolean {
  return relativePath.split(/[\\/]/).some(part=>{const value=part.toLowerCase();return value.includes('wallet')||value==='vault'||value==='vaults'});
}
function trackedMime(relativePath:string):string {
  const extension=path.extname(relativePath).toLowerCase();
  return ({'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.pdf':'application/pdf','.json':'application/json','.md':'text/markdown','.txt':'text/plain','.csv':'text/csv','.html':'text/html'} as Record<string,string>)[extension]??'application/octet-stream';
}



interface NativeSourceIngestInput {
  operationId:    string;
  handle:         string;
  sourceRevision: string;
  contentHash:    string;
  name:           string;
  mime?:          string;
  bytes:          Buffer;
  fileId?:        string;
  baseVersionId?: string;
  filesPath?:     string;
  collectionId?:  string;
  internal?:      boolean;
}

class SullaFilesWatcher {
  readonly folder = resolveSullaFilesUserRoot().activePath;
  private watchers = new Map<string, fs.FSWatcher>();
  private brokeredFingerprints = new Map<string, string>();
  private brokeredFingerprintsLoaded = false;
  private brokeredScans = new Map<string, Promise<void>>();
  private brokeredRescanQueued = new Set<string>();
  private rescanTimer?: NodeJS.Timeout;
  private safetyTimer?: NodeJS.Timeout;
  private resumeTimer?: NodeJS.Timeout;
  private nativeTimer?: NodeJS.Timeout;
  private docsWatcher?: fs.FSWatcher;
  private nativePolling = false;
  private unlocking = 0;
  private customerWork = 0;
  private nativePollRunning = false;
  private nativePollDelayMs = NATIVE_POLL_ACTIVE_MS;
  private nativeNextPollAt = 0;
  private customerServicePending = false;
  private customerStatusAt = 0;
  private customerStatusRefreshing = false;
  private readonly useCases = new SullaUseCaseFiles((endpoint, init = {}) => this.requestFiles(endpoint, init));
  private nativeEnabled = false;
  private started = false;
  private stopped = false;
  private lockGeneration = 0;
  private unlockRetryEpoch = 0;
  private unlockPermitted = false;
  private lockPromise?: Promise<void>;
  private readonly bootstrap = new SullaFilesBootstrapFacade();
  private readonly nativeBroker = new SullaFilesNativeBroker({
    actions: async() => {
      const response = await this.rawLocalRequest('/v1/local/native-sources/actions');

      if (!response.ok) throw new Error(`Native publication actions failed (${ response.status })`);
      return response.json();
    },
    sources: () => this.listNativeSourcesRaw(),
    content: async(operationId) => {
      const response = await this.rawLocalRequest(`/v1/local/native-sources/actions/${ encodeURIComponent(operationId) }/content`);

      return readBoundedResponse(response);
    },
    read:      handle => getSullaFilesSourceGateway().read(handle),
    signature: handle => getSullaFilesSourceGateway().signature(handle),
    write:    (handle, expectedRevision, bytes) => getSullaFilesSourceGateway().write(handle, expectedRevision, bytes),
    ingest:   input => this.ingestNativeSource(input),
    finish:   (operationId, result) => this.finishNativePublication(operationId, result),
    logError: (message, error) => console.debug(`[SullaFiles] ${ message }:`, error),
  });

  /** Native handles stay in Electron; guests only see Files identities and encrypted snapshots. */
  private readonly systemIngest = new SullaFilesSystemIngestJob({
    // Read-only inputs, in priority order of their lanes (P1 Sulla, P2 training data, P3 logs).
    sources: () => [
      { area: 'sulla', lane: 'sulla', root: resolveSullaDocsDir(), prefix: 'Docs/', filter: () => true, ignore: rel => ignored(rel, DEFAULT_IGNORES) },
      { area: 'training-data', lane: 'training', root: resolveSullaConversationsDir(), prefix: '', filter: name => name.endsWith('.jsonl') },
      { area: 'logs', lane: 'logs', root: resolveSullaLogsDir(), prefix: 'app/', filter: () => true },
    ],
    fetchAreas: async() => {
      const response = await this.rawLocalRequest('/v1/local/system-areas');
      if (!response.ok) throw new Error(`System collections unavailable (${ response.status })`);
      return response.json();
    },
    ingest: request => this.ingestSystemAreaFile(request),
    customerBusy: () => this.customerFilesBusy(),
    active:    () => this.nativePolling && !this.stopped,
    busy:      () => Boolean(this.lockPromise) || this.unlocking > 0,
    onBattery: () => powerMonitor?.isOnBatteryPower?.() ?? false,
    statePath: () => path.join(app.getPath('userData'), 'sulla-files-system-ingest.json'),
    log:       message => console.log(message),
    debug:     (message, error) => console.debug(message, error),
  });

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
    this.useCases.stop();
    this.lockGeneration++;
    this.unlockPermitted = false;
    this.nativePolling = false;
    // Cancel the background system-area ingest at its next file; never wait on it.
    this.systemIngest.pause().catch(() => undefined);
    const lock = (async() => {
      // Stop guest admission first so dirty FUSE handles can flush through the
      // still-live broker. Then drain publication work, revoke host handles,
      // and finally zero Files keys.
      await getSullaFilesMountManager().stop();
      await this.nativeBroker.suspendAndDrain(lockSullaFilesSourceGateway);
      const response = await this.rawLocalRequest('/v1/local/lock', { method: 'POST' }).catch(() => undefined);

      await this.bootstrap.settled();
      const postHelper = await this.rawLocalRequest('/v1/local/lock', { method: 'POST' });

      if (!response?.ok || !postHelper.ok) throw new Error('Files service could not be locked');
    })();

    this.lockPromise = lock;
    try { await lock } finally { if (this.lockPromise === lock) this.lockPromise = undefined; }
  }

  async unlockService():Promise<void> {
    if (this.lockPromise) await this.lockPromise;
    this.lockGeneration++;
    this.unlockPermitted = true;
    this.unlocking++;
    try { await traceAsync('files ensureUnlocked', () => this.ensureUnlocked()) } finally { this.unlocking-- }
    this.startBackgroundIngest();
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
        const delay = UNLOCK_RETRY_DELAYS_MS[Math.min(failures, UNLOCK_RETRY_DELAYS_MS.length - 1)];

        if (reason !== lastReason) console.warn(`[SullaFiles] Files unlock failed; retrying in ${ delay / 1000 }s:`, error);
        lastReason = reason;
        await new Promise(resolve => setTimeout(resolve, delay).unref());
        if (epoch !== this.unlockRetryEpoch || this.stopped) return;
      }
    }
  }

  /**
   * Arms the system-area ingest (logs, training data, docs, use cases). It only
   * sets an unref'd timer for after the startup grace delay; the work never runs
   * inside the unlock or lifecycle promise chain.
   */
  startBackgroundIngest():void {
    if (this.nativeEnabled && this.nativePolling && !this.stopped) this.systemIngest.start();
  }

  systemIngestStatus():SystemIngestStatus {
    return this.systemIngest.status();
  }

  private async ensureUnlocked(): Promise<void> {
    const generation = this.lockGeneration;

    this.assertUnlockGeneration(generation);
    await this.requireAppUnlocked();
    this.assertUnlockGeneration(generation);
    const response = await traceAsync('files /healthz', () => this.rawLocalRequest('/healthz'));

    this.assertUnlockGeneration(generation);
    if (!response.ok) throw new Error('Files service is unavailable');
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
    unlockSullaFilesSourceGateway();
    if (this.nativeEnabled) {
      const handles = getSullaFilesSourceGateway().activeHandles();
      const revalidated = await traceAsync('files native-sources revalidate', () => this.rawLocalRequest('/v1/local/native-sources/revalidate', { method: 'POST', body: JSON.stringify({ handles }) }));

      this.assertUnlockGeneration(generation);
      if (!revalidated.ok) throw new Error('Native source sessions could not be revalidated');
      if (!this.nativePolling) {
        this.nativeBroker.resume();
        this.nativePolling = true;
      }
      // The Files service remains usable when the optional guest FUSE adapter
      // cannot start (for example, an older VM kernel lacks /dev/fuse). The
      // mount reports its own error state and can be retried on the next
      // unlock; it must not make Files unlock fail or block desktop startup.
      // Not awaited: the mount manager retries on its own schedule, and the
      // guest mount must never hold up unlock or startup.
      traceEvent('ensureUnlocked: handing off to mount manager (not awaited)');
      traceAsync('mount manager start', () => getSullaFilesMountManager().start(() => this.fuseMountCredentials())).catch(error => {
        console.warn('[SullaFiles] guest FUSE mount unavailable; continuing without the mount:', error);
      });
    }
  }

  private assertUnlockGeneration(generation:number):void {
    if (!this.unlockPermitted || generation !== this.lockGeneration || this.stopped) throw new Error('Files is shutting down');
  }

  private async rawLocalRequest(endpoint:string, init:RequestInit = {}, timeoutMs = 30_000):Promise<Response> {
    const token = await SullaSettingsModel.getServicePassword();
    const headers = requestHeaders(init.headers, { 'x-sulla-files-token': token }, { 'content-type': 'application/json' });

    return desktopFilesFetch(`${ API }${ endpoint }`, { ...init, headers, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
  }

  private async isLockedResponse(response: Response): Promise<boolean> {
    if (response.status !== 503) return false;
    const body = await response.clone().json().catch(() => ({}));
    return body.code === 'FILES_LOCKED';
  }

  private async localRequest(endpoint:string, init:RequestInit):Promise<Response> {
    await this.ensureUnlocked();
    const response = await this.rawLocalRequest(endpoint, init);
    if (!await this.isLockedResponse(response)) return response;
    // A restart between the health check and request is safe to retry once:
    // locked services reject requests before executing any operation.
    await this.ensureUnlocked();
    return this.rawLocalRequest(endpoint, init);
  }

  async initialize():Promise<void> {
    if (this.started) return; this.started = true; this.stopped = false;
    this.nativeEnabled = sullaFilesNativeSourceRolloutRequested();
    const { getSullaFilesRootRegistry } = await import('./sullaFilesRootRegistry');
    const registry = getSullaFilesRootRegistry();
    await traceAsync('files startBookmarks', () => registry.startBookmarks());
    app.once('before-quit', () => { registry.stopBookmarks(); this.shutdown().catch(error => console.warn('[SullaFiles] shutdown failed:', error)) }); await fs.promises.mkdir(this.folder, { recursive: true, mode: 0o700 });
    const storedRoots=await traceAsync('files registry.stored', () => registry.stored());
    await this.configureFinderRoots(storedRoots.map(root=>root.path));
    for (const root of storedRoots) {
      this.watchRoot(root.id,root.path);
      this.enrollRoot(root).catch(error=>console.warn(`[SullaFiles] tracked root ${root.id} enrollment failed:`,error));
    }
    try {
      const docsRoot = resolveSullaDocsDir();
      this.docsWatcher = fs.watch(docsRoot, { recursive: process.platform !== 'linux', persistent: false }, () => {
        this.systemIngest.nudge('sulla');
      });
    } catch (error) {
      console.warn('[SullaFiles] bundled docs watcher unavailable; periodic native scans remain active:', error);
    }
    this.safetyTimer = setInterval(() => this.notifyRescan().catch(error => console.debug('[SullaFiles] periodic rescan failed:', error)), 5 * 60_000); this.safetyTimer.unref();
    setTimeout(() => this.notifyRescan().catch(error => console.debug('[SullaFiles] startup rescan failed:', error)), 2_000).unref();
    const pauseUntil = Number(await SullaSettingsModel.get('sullaFilesPauseUntil', 0));
    if (pauseUntil > Date.now()) await this.pauseFor(pauseUntil - Date.now());
    else if (pauseUntil) await SullaSettingsModel.set('sullaFilesPauseUntil', 0, 'number');
    if (this.nativeEnabled) {
      this.nativeTimer = setInterval(() => this.pollNativePublications().catch(error => console.debug('[SullaFiles] native publication poll failed:', error)), 250);
      this.nativeTimer.unref();
    }
  }

  private watchRoot(id:string,rootPath:string):void {
    this.watchers.get(id)?.close();
    try { this.watchers.set(id,fs.watch(rootPath,{recursive:process.platform !== 'linux',persistent:false},()=>{
      this.scanBrokeredRoot(id,rootPath).catch(error=>console.warn(`[SullaFiles] tracked root ${id} scan failed:`,error));
    })) } catch(error){console.warn(`[SullaFiles] watcher unavailable for root ${id}:`,error)}
  }

  private async configureFinderRoots(paths:string[]):Promise<void>{
    if(process.platform!=='darwin')return;
    try{
      // The sandboxed Finder extension reads UserDefaults(suiteName:) from the group container, not ~/Library/Preferences.
      const domain=sullaAppGroupDefaultsDomain();
      await spawnFile('/usr/bin/defaults',['write',domain,'FilesRoots','-array',...paths]);
      if(paths[0])await spawnFile('/usr/bin/defaults',['write',domain,'FilesRoot',paths[0]]);
    }catch(error){console.warn('[SullaFiles] Finder extension roots configuration failed:',error)}
  }

  async enrollRoot(root:{id:string;name:string;path:string;syncMode:'local'|'server';paused:boolean;exclusions:string[]}):Promise<SullaFilesRootStatus>{
    const attached=await this.rawLocalRequest('/v1/local/roots',{method:'POST',body:JSON.stringify({id:root.id,name:root.name,syncMode:root.syncMode,paused:root.paused,exclusions:root.exclusions})});
    if(!attached.ok)throw new Error(`Files rejected the tracked folder (${attached.status}): ${await attached.text()}`);
    this.watchRoot(root.id,root.path);
    const {getSullaFilesRootRegistry}=await import('./sullaFilesRootRegistry');
    await this.configureFinderRoots((await getSullaFilesRootRegistry().stored()).map(item=>item.path));
    if(!root.paused)this.scanBrokeredRoot(root.id,root.path).catch(error=>console.warn(`[SullaFiles] tracked root ${root.id} scan failed:`,error));
    return (await this.rootStatuses()).find(item=>item.id===root.id)!;
  }

  async forgetRoot(id:string):Promise<void>{
    this.watchers.get(id)?.close(); this.watchers.delete(id); this.finderBadges.delete(id);
    const {getSullaFilesRootRegistry}=await import('./sullaFilesRootRegistry');
    await this.configureFinderRoots((await getSullaFilesRootRegistry().stored()).filter(root=>root.id!==id).map(root=>root.path));
  }

  private scanBrokeredRoot(id:string,rootPath:string):Promise<void>{
    // A change that lands mid-scan queues exactly one follow-up pass instead of being dropped.
    const running=this.brokeredScans.get(id); if(running){this.brokeredRescanQueued.add(id);return running}
    const scan=this.scanBrokeredRootNow(id,rootPath).finally(()=>{
      if(this.brokeredScans.get(id)===scan)this.brokeredScans.delete(id);
      if(this.brokeredRescanQueued.delete(id))this.scanBrokeredRoot(id,rootPath).catch(error=>console.warn(`[SullaFiles] tracked root ${id} scan failed:`,error));
    });
    this.brokeredScans.set(id,scan); return scan;
  }

  private async scanBrokeredRootNow(id:string,rootPath:string):Promise<void>{
    const roots=await this.rootStatuses(); const root=roots.find(item=>item.id===id); if(!root||root.paused)return;
    const state=async(state:'scanning'|'idle'|'error',pendingFiles=0,lastError?:string)=>{const response=await this.rawLocalRequest(`/v1/local/roots/${encodeURIComponent(id)}/scan-state`,{method:'POST',body:JSON.stringify({state,pendingFiles,lastError})});if(!response.ok)throw new Error(`Files scan state failed (${response.status})`)};
    try{
      await state('scanning'); let count=0;
      if(!this.brokeredFingerprintsLoaded){const saved=await SullaSettingsModel.get('sullaFilesRootFingerprints',{});if(saved&&typeof saved==='object'&&!Array.isArray(saved))for(const [key,value] of Object.entries(saved))if(typeof value==='string')this.brokeredFingerprints.set(key,value);this.brokeredFingerprintsLoaded=true}
      const currentResponse=await this.requestFiles(`/v1/files?collectionId=${encodeURIComponent(root.collectionId)}&path=&trash=false`);
      if(!currentResponse.ok)throw new Error(`Could not read tracked collection (${currentResponse.status})`);
      const current=new Map((await currentResponse.json() as {path:string;size:number}[]).map(file=>[file.path,Number(file.size)]));
      const walk=async(directory:string):Promise<void>=>{for(const entry of await fs.promises.readdir(directory,{withFileTypes:true})){
        const absolute=path.join(directory,entry.name); const relative=path.relative(rootPath,absolute).split(path.sep).join('/');
        if(ignored(relative,DEFAULT_IGNORES)||ignored(relative,root.exclusions)||isSensitiveTrackedPath(relative))continue;
        if(entry.isSymbolicLink())continue; if(entry.isDirectory()){await walk(absolute);continue} if(!entry.isFile())continue;
        if(++count>100_000)throw new Error('Tracked folder exceeds the 100,000-file safety limit');
        if(count%25===0)await state('scanning',count);
        const stat=await fs.promises.stat(absolute); if(stat.size>2*1024*1024*1024)throw new Error(`${relative} exceeds the 2 GB tracked-file limit`);
        // Unchanged size + mtime means the stored version is current; skip reading the file at all.
        const key=`${id}:${relative}`; const stamp=`${stat.size}:${stat.mtimeMs}`;
        if(this.brokeredFingerprints.get(key)?.startsWith(`${stamp}:`)&&current.get(relative)===stat.size)continue;
        const bytes=await fs.promises.readFile(absolute); const fingerprint=`${stamp}:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
        if(this.brokeredFingerprints.get(key)?.split(':').pop()===fingerprint.split(':').pop()&&current.get(relative)===stat.size){this.brokeredFingerprints.set(key,fingerprint);continue}
        const response=await this.requestFiles(`/v1/files/upload?collectionId=${encodeURIComponent(root.collectionId)}&path=${encodeURIComponent(relative)}`,{method:'PUT',headers:{'content-type':trackedMime(relative)},body:bytes});
        if(!response.ok)throw new Error(`Could not index ${relative} (${response.status})`); this.brokeredFingerprints.set(key,fingerprint); current.set(relative,stat.size);
      }};
      await walk(rootPath); await SullaSettingsModel.set('sullaFilesRootFingerprints',Object.fromEntries(this.brokeredFingerprints),'json'); await state('idle',0); await this.refreshFinderBadges();
    }catch(error){const message=error instanceof Error?error.message:String(error);await state('error',0,message).catch(()=>undefined);throw error}
  }

  async shutdown():Promise<void> { this.stopped = true; this.nativePolling = false; this.useCases.stop(); this.systemIngest.pause().catch(() => undefined); await this.lockService().catch(() => undefined); for (const watcher of this.watchers.values()) watcher.close(); this.watchers.clear(); this.docsWatcher?.close(); this.docsWatcher = undefined; if (this.rescanTimer) clearTimeout(this.rescanTimer); if (this.safetyTimer) clearInterval(this.safetyTimer); if (this.nativeTimer) clearInterval(this.nativeTimer); if (this.resumeTimer) clearTimeout(this.resumeTimer); this.started = false }
  private scheduleRescan():void {
    if (this.rescanTimer) clearTimeout(this.rescanTimer);
    this.rescanTimer = setTimeout(() => {
      this.rescanTimer = undefined;
      this.notifyRescan().catch(error => console.debug('[SullaFiles] debounced rescan failed:', error));
    }, 350);
  }

  /** P0: the user's own Files work (watch events, rescans, user-picked native sources) in flight. */
  private async trackCustomerWork<T>(work:Promise<T>):Promise<T> {
    this.customerWork++;
    try { return await work } finally { this.customerWork-- }
  }

  /**
   * True while the user's own Files have pending work, so the system-area job
   * starts nothing new. Combines local in-flight work with the Files service's
   * watched-folder scan state (cached; refreshed in the background).
   */
  private customerFilesBusy():boolean {
    if (this.customerWork > 0 || this.rescanTimer) return true;
    if (Date.now() - this.customerStatusAt > 2_000 && !this.customerStatusRefreshing) {
      this.customerStatusRefreshing = true;
      this.rawLocalRequest('/v1/local/status', {}, 5_000)
        .then(async response => {
          const status = response.ok ? await response.json() as Partial<SullaFilesStatus> : undefined;
          this.customerServicePending = status?.state === 'syncing' && Number(status.pendingFiles) > 0;
        })
        .catch(() => { this.customerServicePending = false })
        .finally(() => { this.customerStatusAt = Date.now(); this.customerStatusRefreshing = false });
    }
    return this.customerServicePending;
  }
  private async patterns():Promise<string[]> { try { return [...DEFAULT_IGNORES, ...(await fs.promises.readFile(path.join(this.folder, '.sullaignore'), 'utf8')).split(/\r?\n/)] } catch { return DEFAULT_IGNORES } }
  private async changed(relativePath:string):Promise<void> {
    if (ignored(relativePath, await this.patterns())) return; const absolute = path.resolve(this.folder, relativePath); if (!absolute.startsWith(`${ this.folder }${ path.sep }`)) return;
    try { const first = await fs.promises.stat(absolute); if (!first.isFile()) return; await new Promise(resolve => setTimeout(resolve, 600)); const second = await fs.promises.stat(absolute); if (first.size !== second.size || first.mtimeMs !== second.mtimeMs) return this.changed(relativePath); } catch { /* rename/delete: rescan now */ }
    this.scheduleRescan();
  }

  private async request(endpoint:string, init:RequestInit = {}):Promise<Response> {
    return this.localRequest(endpoint, init);
  }

  async prepareNativeSourceSession():Promise<void> {
    // This also advances the gateway unlock epoch only after Files and the
    // application vault have both proved they are unlocked.
    await this.ensureUnlocked();
  }

  async listNativeSources():Promise<{ fileId: string; versionId: string; path: string; handle: string; name: string; sourceRevision: string; sourceHash: string; state: string; lastError?: string; recovery: Record<string, unknown> }[]> {
    const response = await this.request('/v1/local/native-sources');
    if (!response.ok) throw new Error(`Native source inventory failed (${ response.status })`);
    return response.json();
  }

  /** Pages the native source inventory (bounded keyset pages; never one unbounded full-table query). */
  private async listNativeSourcesRaw():Promise<{ fileId: string; versionId: string; path: string; handle: string; name: string; sourceRevision: string; sourceHash: string; state: string; lastError?: string; recovery: Record<string, unknown> }[]> {
    const all:Awaited<ReturnType<SullaFilesWatcher['listNativeSourcesRaw']>> = [];
    let after:string | undefined;
    for (let page = 0; page < NATIVE_SOURCE_MAX_PAGES; page++) {
      const query = new URLSearchParams({ limit: String(NATIVE_SOURCE_PAGE_SIZE) });
      if (after) query.set('after', after);
      const response = await this.rawLocalRequest(`/v1/local/native-sources?${ query }`);

      if (!response.ok) throw new Error(`Native source inventory failed (${ response.status })`);
      const rows = await response.json() as typeof all;
      all.push(...rows);
      after = response.headers.get('x-sulla-next-cursor') ?? undefined;
      // An older Files image ignores paging and returns everything without a cursor.
      if (!after || rows.length < NATIVE_SOURCE_PAGE_SIZE) break;
    }
    return all;
  }

  private async localPrincipalId():Promise<string> {
    const response = await this.rawLocalRequest('/v1/local/identity');
    if (!response.ok) throw new Error('Files service identity is unavailable');
    const body = await response.json() as { principalId?: unknown };
    if (typeof body.principalId !== 'string' || !body.principalId) throw new Error('Files service returned an invalid identity');

    return body.principalId;
  }

  private async capabilityToken(userId = process.env.SULLA_FILES_USER_ID ?? 'desktop-user', context: SullaFilesCapabilityContext = {}, scopes = ['files/*'], collectionId?:string):Promise<string> {
    const key = sullaFilesCapabilityKey(await SullaSettingsModel.getServicePassword()); const now = Math.floor(Date.now() / 1_000); const encode = (value:string) => Buffer.from(value).toString('base64url'); const header = encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const deviceId = await getDesktopDeviceId().catch(() => os.hostname());
    const payload = encode(JSON.stringify({
      sub:       userId,
      device_id: deviceId,
      scopes,
      agent_id:  context.agentId,
      job_id:    context.jobId,
      thread_id: context.threadId,
      ...(collectionId ? { collection_id: collectionId } : {}),
      v:         1,
      iss:       'sulla-files',
      aud:       'sulla-tools',
      iat:       now,
      exp:       now + 300,
      jti:       crypto.randomUUID(),
    }));

    return `${ header }.${ payload }.${ crypto.createHmac('sha256', key).update(`${ header }.${ payload }`).digest('base64url') }`;
  }

  nativeRuntimeStatus():SullaFilesNativeRuntimeStatus {
    return getSullaFilesMountManager().status();
  }

  private async fuseMountCredentials():Promise<{ token:string }> {
    await this.requireAppUnlocked();
    const principalId = await this.localPrincipalId();
    return {
      token: await this.capabilityToken(principalId, {}, ['files/fuse']),
    };
  }

  async requestFiles(endpoint:string, init:RequestInit = {}, server = false, capability: SullaFilesCapabilityContext = {}):Promise<Response> {
    const base = server && process.env.SULLA_FILES_SERVER_URL ? process.env.SULLA_FILES_SERVER_URL : API;
    const url = new URL(endpoint, base);
    if (url.origin !== new URL(base).origin) throw new Error('Files endpoint must use the configured service');
    if (base !== API) {
      const token = await this.capabilityToken(undefined, capability);
      const headers = requestHeaders(init.headers, { authorization: `Bearer ${ token }` });

      return fetch(url, { ...init, headers, redirect: 'error', signal: init.signal ?? AbortSignal.timeout(30_000) });
    }
    await this.ensureUnlocked();
    let principalId = await this.localPrincipalId();
    const send = async() => {
      const token = await this.capabilityToken(principalId, capability);
      const headers = requestHeaders(init.headers, { authorization: `Bearer ${ token }` });

      return desktopFilesFetch(url, { ...init, headers, redirect: 'error' as const, signal: init.signal ?? AbortSignal.timeout(30_000) });
    };
    const response = await send();
    if (!await this.isLockedResponse(response)) return response;
    await response.body?.cancel();
    await this.ensureUnlocked();
    principalId = await this.localPrincipalId();

    return send();
  }

  /**
   * Calls a local endpoint that requires both Desktop principal authority and
   * the native service secret. This is deliberately separate from
   * requestFiles(): ordinary Files calls must never gain native-main custody.
   */
  async requestNativeFiles(endpoint:string, init:RequestInit = {}):Promise<Response> {
    const url = new URL(endpoint, API);
    if (url.origin !== new URL(API).origin) throw new Error('Native Files endpoints must use the local service');
    await this.ensureUnlocked();
    let principalId = await this.localPrincipalId();
    const send = async() => {
      const [localToken, capability] = await Promise.all([
        SullaSettingsModel.getServicePassword(),
        this.capabilityToken(principalId),
      ]);
      const headers = requestHeaders(init.headers, {
        'x-sulla-files-token': localToken,
        authorization:         `Bearer ${ capability }`,
      }, init.body ? { 'content-type': 'application/json' } : {});

      return desktopFilesFetch(url, { ...init, headers, redirect: 'error' as const, signal: init.signal ?? AbortSignal.timeout(30_000) });
    };
    const response = await send();
    if (!await this.isLockedResponse(response)) return response;
    await response.body?.cancel();
    await this.ensureUnlocked();
    principalId = await this.localPrincipalId();

    return send();
  }

  async requestFilesStream(endpoint:string, init:RequestInit = {}, signal?:AbortSignal):Promise<Response> {
    const url = new URL(endpoint, API);
    if (url.origin !== new URL(API).origin) throw new Error('Files endpoint must use the local service');
    await this.ensureUnlocked();
    let principalId = await this.localPrincipalId();
    const send = async() => {
      const token = await this.capabilityToken(principalId);
      const headers = requestHeaders(init.headers, { authorization: `Bearer ${ token }` });

      return desktopFilesFetch(url, { ...init, headers, redirect: 'error' as const, signal });
    };
    const response = await send();
    if (!await this.isLockedResponse(response)) return response;
    await response.body?.cancel();
    await this.ensureUnlocked();
    principalId = await this.localPrincipalId();

    return send();
  }

  async notifyRescan():Promise<void> {
    return this.trackCustomerWork(this.notifyRescanNow());
  }

  private async notifyRescanNow():Promise<void> {
    try {
      const response = await this.request('/v1/local/rescan', { method: 'POST' }); if (!response.ok) throw new Error(`HTTP ${ response.status }`);
      await this.refreshFinderBadges();
    } catch (error) { console.debug('[SullaFiles] optional container is offline; folder remains local-only:', error) }
  }

  private finderBadges = new Map<string, FinderBadgeSync>();

  private async refreshFinderBadges():Promise<void> {
    if (process.platform !== 'darwin') return;
    const {getSullaFilesRootRegistry}=await import('./sullaFilesRootRegistry');
    for(const root of await getSullaFilesRootRegistry().list()){
      if(root.activation!=='active'||!root.collectionId)continue;
      let badges=this.finderBadges.get(root.id);
      if(!badges){badges=new FinderBadgeSync(root.path,async(target,state)=>{const{setAttribute}=await import('@napi-rs/xattr');await setAttribute(target,FINDER_BADGE_ATTRIBUTE,state)});this.finderBadges.set(root.id,badges)}
      if(!badges.begin())continue;
      try{const response=await this.requestFiles(`/v1/files?collectionId=${encodeURIComponent(root.collectionId)}&path=&trash=false`);if(response.ok)await badges.apply(await response.json() as {path:string;sync_state?:string}[])}finally{badges.end()}
    }
  }

  async status():Promise<SullaFilesStatus> {
    try {
      const response = await this.request('/v1/local/status'); if (!response.ok) throw new Error(`HTTP ${ response.status }`);
      const status = await response.json() as SullaFilesStatus;
      const serverUrl = process.env.SULLA_FILES_SERVER_URL;
      const serverLabel = serverUrl ? new URL(serverUrl).hostname : status.serverConfigured ? 'Sulla Server' : undefined;

      return { ...status, location: !status.serverConfigured ? 'local' : serverLabel?.endsWith('sulla.cloud') ? 'cloud' : 'server', serverLabel: serverLabel?.endsWith('sulla.cloud') ? 'Sulla Cloud' : serverLabel };
    } catch {
      return { state: 'error', pendingFiles: 0, lastError: 'Files container is off; files remain safely in ~/sulla/files', serverConfigured: false, location: 'local' };
    }
  }

  async setPaused(paused:boolean):Promise<SullaFilesStatus> { const response = await this.request('/v1/local/pause', { method: 'POST', body: JSON.stringify({ paused }) }); if (!response.ok) throw new Error(`Files pause failed (${ response.status })`); return await response.json() as SullaFilesStatus }

  async rootStatuses():Promise<SullaFilesRootStatus[]> {
    const response = await this.rawLocalRequest('/v1/local/roots');
    if (!response.ok) throw new Error(`Files roots are unavailable (${ response.status })`);
    const roots = await response.json() as SullaFilesRootStatus[];
    if (!roots.length) throw new Error('Files roots are locked or have not initialized');
    return roots;
  }

  async configureRoot(id:string, input:{ paused?: boolean; syncMode?: 'local' | 'server'; exclusions?: string[] }):Promise<SullaFilesRootStatus> {
    const response = await this.rawLocalRequest(`/v1/local/roots/${ encodeURIComponent(id) }`, { method: 'PATCH', body: JSON.stringify(input) });
    if (!response.ok) throw new Error(`Files root update failed (${ response.status })`);
    return await response.json() as SullaFilesRootStatus;
  }

  async detachRoot(id:string):Promise<void> {
    const response = await this.rawLocalRequest(`/v1/local/roots/${ encodeURIComponent(id) }`, { method: 'DELETE' });
    if (!response.ok && response.status !== 404) throw new Error(`Files root removal failed (${ response.status })`);
  }

  async pauseFor(ms:number):Promise<SullaFilesStatus> {
    await SullaSettingsModel.set('sullaFilesPauseUntil', Date.now() + ms, 'number');
    if (this.resumeTimer) clearTimeout(this.resumeTimer);
    this.resumeTimer = setTimeout(() => {
      this.setPaused(false).catch(error => console.warn('[SullaFiles] automatic resume failed:', error));
      SullaSettingsModel.set('sullaFilesPauseUntil', 0, 'number').catch(() => undefined);
    }, ms); this.resumeTimer.unref();
    return this.setPaused(true);
  }

  async recentFiles(limit = 4):Promise<RecentSullaFile[]> {
    const response = await this.request(`/v1/local/recent?limit=${ Math.max(1, Math.min(limit, 20)) }`);
    if (!response.ok) throw new Error(`Recent Files request failed (${ response.status })`);
    return await response.json() as RecentSullaFile[];
  }

  async findFile(relativePath:string):Promise<RecentSullaFile | undefined> {
    const response = await this.request(`/v1/local/recent?limit=100&path=${ encodeURIComponent(relativePath) }`);
    if (!response.ok) return undefined;
    return (await response.json() as RecentSullaFile[])[0];
  }

  /** User-picked native sources count as P0 customer work; internal system-area ingest does not. */
  async ingestNativeSource(input:NativeSourceIngestInput):Promise<NativeSourceFileResult> {
    return input.internal ? this.ingestNativeSourceNow(input) : this.trackCustomerWork(this.ingestNativeSourceNow(input));
  }

  private async ingestNativeSourceNow(input:NativeSourceIngestInput):Promise<NativeSourceFileResult> {
    const collectionResponse = input.collectionId ? undefined : await this.request('/v1/local/native-sources/collection');
    if (collectionResponse && !collectionResponse.ok) throw new Error(`Files collection request failed (${ collectionResponse.status })`);
    const collection = input.collectionId ? {collectionId:input.collectionId} : await collectionResponse!.json() as {collectionId?:unknown};
    if (typeof collection.collectionId !== 'string' || !collection.collectionId) throw new Error('Files returned an invalid native source collection');
    const name = path.basename(input.name).replaceAll('/', '_');
    if (!name || name === '.' || name === '..') throw new Error('Native source name is invalid');
    const query = new URLSearchParams({ collectionId: collection.collectionId, path: input.filesPath ?? `Native Sources/${ name }` });
    if (input.fileId) query.set('fileId', input.fileId);
    const headers:Record<string, string> = {
      'content-type':                    input.mime ?? 'application/octet-stream',
      'x-sulla-operation-id':            input.operationId,
      'x-sulla-source-handle':           input.handle,
      'x-sulla-source-revision':         input.sourceRevision,
      'x-sulla-source-hash':             input.contentHash,
    };
    if (input.baseVersionId) headers['x-sulla-files-base-version'] = input.baseVersionId;
    const body = new ArrayBuffer(input.bytes.byteLength);
    new Uint8Array(body).set(input.bytes);
    const response = input.internal
      ? await this.rawLocalRequest(`/v1/local/native-sources/ingest?${ query }`, {method:'PUT',headers,body})
      : await this.request(`/v1/local/native-sources/ingest?${ query }`, {method:'PUT',headers,body});
    if (!response.ok) throw new Error(`Native source ingestion failed (${ response.status }): ${ await response.text() }`);
    return await response.json() as NativeSourceFileResult;
  }

  /**
   * Plain read-only mirror of one system-area file. Creates no native-source
   * rows, handles, publication or recovery state in Files, and is a no-op when
   * Files already holds these bytes.
   */
  private async ingestSystemAreaFile(request:SystemIngestRequest):Promise<{ unchanged: boolean }> {
    const query = new URLSearchParams({ collectionId: request.collectionId, path: request.filesPath });
    const headers:Record<string, string> = { 'content-type': request.mime, 'x-sulla-source-hash': request.snapshot.contentHash };
    if (request.skipSearchIndex) headers['x-sulla-files-skip-search-index'] = '1';
    const body = new ArrayBuffer(request.snapshot.bytes.byteLength);
    new Uint8Array(body).set(request.snapshot.bytes);
    const response = await this.rawLocalRequest(`/v1/local/system-areas/ingest?${ query }`, { method: 'PUT', headers, body }, 60_000);
    // Never fall back to native-source ingest: that is what created ~19k native rows for system files.
    if (response.status === 404) throw new Error('Files service update required for system-area ingest');
    if (!response.ok) throw new Error(`System-area ingest failed (${ response.status }): ${ await response.text() }`);
    const result = await response.json() as { unchanged?: unknown };
    return { unchanged: result.unchanged === true };
  }

  async planNativePublication(input:{ operationId: string; handle: string; sourceRevision: string; contentHash: string; fileId: string; baseVersionId: string }):Promise<void> {
    const response = await this.request('/v1/local/native-sources/publications', {
      method:  'POST',
      headers: {
        'x-sulla-operation-id':    input.operationId,
        'x-sulla-source-handle':   input.handle,
        'x-sulla-source-revision': input.sourceRevision,
        'x-sulla-source-hash':     input.contentHash,
      },
      body: JSON.stringify({ fileId: input.fileId, baseVersionId: input.baseVersionId }),
    });
    if (!response.ok) throw new Error(`Native source publication planning failed (${ response.status }): ${ await response.text() }`);
  }

  async finishNativePublication(operationId:string, result:{ nextSourceRevision?: string; originalSourceRevision?: string; originalSourceHash?: string; currentSourceHash?: string; filesBaseVersionId?: string; currentFilesVersionId?: string; error?: string; conflictFileId?: string; currentSourceRevision?: string }):Promise<void> {
    const response = await this.request(`/v1/local/native-sources/publications/${ encodeURIComponent(operationId) }/finish`, {
      method: 'POST', body: JSON.stringify(result),
    });
    if (!response.ok) throw new Error(`Native source publication finalization failed (${ response.status }): ${ await response.text() }`);
  }

  async reselectInterruptedNativePublication(input:{ fileId:string; previousHandle:string; handle:string; sourceRevision:string; sourceHash:string }):Promise<boolean> {
    const response = await this.request('/v1/local/native-sources/reselect-interrupted-publication', {
      method: 'POST', body: JSON.stringify(input),
    });
    if (!response.ok) throw new Error(`Interrupted native publication reselection failed (${ response.status }): ${ await response.text() }`);
    return Boolean((await response.json() as { recovered?:boolean }).recovered);
  }

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

  async folderForCollection(collectionId?:string):Promise<string> {
    if (!collectionId) return this.folder;
    const { getSullaFilesRootRegistry } = await import('./sullaFilesRootRegistry');
    const root = await getSullaFilesRootRegistry().rootForCollection(collectionId);
    if (!root) throw new Error('That Files collection has no active local folder.');
    return root.path;
  }

  async openFolder(collectionId?:string):Promise<void> { const error = await shell.openPath(await this.folderForCollection(collectionId)); if (error) throw new Error(error); }
}

let instance:SullaFilesWatcher | undefined;
export function getSullaFilesWatcher():SullaFilesWatcher { instance ??= new SullaFilesWatcher(); return instance }
