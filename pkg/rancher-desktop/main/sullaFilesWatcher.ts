import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { app, shell } from 'electron';

import { SullaFilesBootstrapFacade } from './sullaFilesBootstrapFacade';
import { readBoundedResponse } from './sullaFilesBoundedResponse';
import { SullaFilesNativeBroker } from './sullaFilesNativeBroker';
import { getSullaFilesSourceGateway, lockSullaFilesSourceGateway, unlockSullaFilesSourceGateway } from './sullaFilesSourceGateway';
import { desktopFilesFetch, FILES_HTTPS_ORIGIN } from './sullaFilesTls';

import { SullaSettingsModel } from '@pkg/agent/database/models/SullaSettingsModel';
import { getDesktopDeviceId } from '@pkg/main/deviceIdentity';
import { spawnFile } from '@pkg/utils/childProcess';
import Logging from '@pkg/utils/logging';
import { sullaFilesCapabilityKey } from '@pkg/utils/sullaFilesKey';
import { resolveSullaFilesUserRoot } from '@pkg/utils/sullaFilesPaths';

const console = Logging.background;
const DEFAULT_IGNORES = ['.DS_Store', '._*', '*.tmp', '~$*', '.git/', 'node_modules/', '*.sulla-conflict-*', '.sulla-trash/'];
const API = FILES_HTTPS_ORIGIN;

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

class SullaFilesWatcher {
  readonly folder = resolveSullaFilesUserRoot().activePath;
  private watchers = new Map<string, fs.FSWatcher>();
  private rescanTimer?: NodeJS.Timeout;
  private safetyTimer?: NodeJS.Timeout;
  private resumeTimer?: NodeJS.Timeout;
  private nativeTimer?: NodeJS.Timeout;
  private nativePolling = false;
  private nativeEnabled = false;
  private started = false;
  private stopped = false;
  private lockGeneration = 0;
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
    read:     handle => getSullaFilesSourceGateway().read(handle),
    write:    (handle, expectedRevision, bytes) => getSullaFilesSourceGateway().write(handle, expectedRevision, bytes),
    ingest:   input => this.ingestNativeSource(input),
    finish:   (operationId, result) => this.finishNativePublication(operationId, result),
    logError: (message, error) => console.debug(`[SullaFiles] ${ message }:`, error),
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
    this.lockGeneration++;
    this.unlockPermitted = false;
    this.nativePolling = false;
    const lock = (async() => {
      // Stop enrollment before revoking source sessions. The broker drains a
      // stable set because stale polls reject their generation after awaits.
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
    await this.ensureUnlocked();
  }

  private async ensureUnlocked(): Promise<void> {
    const generation = this.lockGeneration;

    this.assertUnlockGeneration(generation);
    await this.requireAppUnlocked();
    this.assertUnlockGeneration(generation);
    const response = await this.rawLocalRequest('/healthz');

    this.assertUnlockGeneration(generation);
    if (!response.ok) throw new Error('Files service is unavailable');
    const health = await response.json();

    this.assertUnlockGeneration(generation);
    // Never send a master key to an older image with no memory-only protocol.
    if (typeof health.locked !== 'boolean') throw new Error('Files service requires a keychain-compatible update');
    if (!health.legacyImport || !['clear', 'secure-import-required'].includes(health.legacyImport.state)) throw new Error('Files service requires a legacy-preflight-compatible update');
    if (health.locked) {
      const result = await this.bootstrap.initialize();

      this.assertUnlockGeneration(generation);
      if (!result.ok || result.state !== 'unlocked') throw new Error(result.code ?? 'Files secure bootstrap failed');
    }
    await this.requireAppUnlocked();
    this.assertUnlockGeneration(generation);
    unlockSullaFilesSourceGateway();
    if (this.nativeEnabled) {
      const handles = getSullaFilesSourceGateway().activeHandles();
      const revalidated = await this.rawLocalRequest('/v1/local/native-sources/revalidate', { method: 'POST', body: JSON.stringify({ handles }) });

      this.assertUnlockGeneration(generation);
      if (!revalidated.ok) throw new Error('Native source sessions could not be revalidated');
      if (!this.nativePolling) {
        this.nativeBroker.resume();
        this.nativePolling = true;
      }
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
    const { SULLA_FILES_NATIVE_SOURCE_READY } = await import('@pkg/utils/sullaFilesNativeSource');
    this.nativeEnabled = SULLA_FILES_NATIVE_SOURCE_READY && process.env.SULLA_FILES_FUSE_EXPERIMENT === '1';
    const { getSullaFilesRootRegistry } = await import('./sullaFilesRootRegistry');
    const registry = getSullaFilesRootRegistry();
    await registry.startBookmarks();
    app.once('before-quit', () => { registry.stopBookmarks(); this.shutdown() }); await fs.promises.mkdir(this.folder, { recursive: true, mode: 0o700 });
    if (process.platform === 'darwin') {
      try { await spawnFile('/usr/bin/defaults', ['write', 'group.io.sulla.desktop', 'FilesRoot', this.folder]) } catch (error) { console.warn('[SullaFiles] Finder extension root configuration failed:', error) }
    }
    for (const root of await registry.stored()) {
      try {
        const watcher = fs.watch(root.path, { recursive: process.platform !== 'linux', persistent: false }, (_event, filename) => {
          if (!filename) return;
          if (root.id === 'default') this.changed(filename.toString()).catch(error => console.warn('[SullaFiles] watch event failed:', error));
          else this.scheduleRescan();
        });
        this.watchers.set(root.id, watcher);
      } catch (error) { console.warn(`[SullaFiles] watcher unavailable for root ${ root.id }; periodic rescans remain active:`, error) }
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

  shutdown():void { this.stopped = true; this.nativePolling = false; this.lockService().catch(() => undefined); for (const watcher of this.watchers.values()) watcher.close(); this.watchers.clear(); if (this.rescanTimer) clearTimeout(this.rescanTimer); if (this.safetyTimer) clearInterval(this.safetyTimer); if (this.nativeTimer) clearInterval(this.nativeTimer); if (this.resumeTimer) clearTimeout(this.resumeTimer); this.started = false }
  private scheduleRescan():void { if (this.rescanTimer) clearTimeout(this.rescanTimer); this.rescanTimer = setTimeout(() => this.notifyRescan().catch(error => console.debug('[SullaFiles] debounced rescan failed:', error)), 350) }
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

  private async listNativeSourcesRaw():Promise<{ fileId: string; versionId: string; path: string; handle: string; name: string; sourceRevision: string; sourceHash: string; state: string; lastError?: string; recovery: Record<string, unknown> }[]> {
    const response = await this.rawLocalRequest('/v1/local/native-sources');

    if (!response.ok) throw new Error(`Native source inventory failed (${ response.status })`);
    return response.json();
  }

  private async localPrincipalId():Promise<string> {
    const response = await this.rawLocalRequest('/v1/local/identity');
    if (!response.ok) throw new Error('Files service identity is unavailable');
    const body = await response.json() as { principalId?: unknown };
    if (typeof body.principalId !== 'string' || !body.principalId) throw new Error('Files service returned an invalid identity');

    return body.principalId;
  }

  private async capabilityToken(userId = process.env.SULLA_FILES_USER_ID ?? 'desktop-user', context: SullaFilesCapabilityContext = {}):Promise<string> {
    const key = sullaFilesCapabilityKey(await SullaSettingsModel.getServicePassword()); const now = Math.floor(Date.now() / 1_000); const encode = (value:string) => Buffer.from(value).toString('base64url'); const header = encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const deviceId = await getDesktopDeviceId().catch(() => os.hostname());
    const payload = encode(JSON.stringify({
      sub:       userId,
      device_id: deviceId,
      scopes:    ['files/*'],
      agent_id:  context.agentId,
      job_id:    context.jobId,
      thread_id: context.threadId,
      v:         1,
      iss:       'sulla-files',
      aud:       'sulla-tools',
      iat:       now,
      exp:       now + 300,
      jti:       crypto.randomUUID(),
    }));

    return `${ header }.${ payload }.${ crypto.createHmac('sha256', key).update(`${ header }.${ payload }`).digest('base64url') }`;
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
    try {
      const response = await this.request('/v1/local/rescan', { method: 'POST' }); if (!response.ok) throw new Error(`HTTP ${ response.status }`);
      await this.refreshFinderBadges();
    } catch (error) { console.debug('[SullaFiles] optional container is offline; folder remains local-only:', error) }
  }

  private async refreshFinderBadges():Promise<void> {
    if (process.platform !== 'darwin') return;
    const collectionsResponse = await this.requestFiles('/v1/collections');
    if (!collectionsResponse.ok) return;
    const collections = await collectionsResponse.json() as { id: string }[];
    for (const collection of collections) {
      const response = await this.requestFiles(`/v1/files?collectionId=${ encodeURIComponent(collection.id) }&path=&trash=false`);
      if (!response.ok) continue;
      const files = await response.json() as { path: string; sync_state?: string }[];
      for (const file of files) {
        const target = path.resolve(this.folder, file.path);
        if (!target.startsWith(`${ this.folder }${ path.sep }`)) continue;
        try { await spawnFile('/usr/bin/xattr', ['-w', 'io.sulla.files.sync-state', file.sync_state || 'unknown', target]) } catch { /* Finder metadata is best-effort. */ }
      }
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

  async ingestNativeSource(input:{
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
  }):Promise<NativeSourceFileResult> {
    const collectionResponse = await this.request('/v1/local/native-sources/collection');
    if (!collectionResponse.ok) throw new Error(`Files collection request failed (${ collectionResponse.status })`);
    const collection = await collectionResponse.json() as { collectionId?: unknown };
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
    const response = await this.request(`/v1/local/native-sources/ingest?${ query }`, { method: 'PUT', headers, body });
    if (!response.ok) throw new Error(`Native source ingestion failed (${ response.status }): ${ await response.text() }`);
    return await response.json() as NativeSourceFileResult;
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

  private async pollNativePublications():Promise<void> {
    if (!this.nativePolling || this.stopped) return;
    await this.nativeBroker.poll();
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
