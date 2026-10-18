import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { app, shell } from 'electron';

import { SullaFilesKeychain } from './sullaFilesKeychain';

import { SullaSettingsModel } from '@pkg/agent/database/models/SullaSettingsModel';
import { getDesktopDeviceId } from '@pkg/main/deviceIdentity';
import { spawnFile } from '@pkg/utils/childProcess';
import Logging from '@pkg/utils/logging';
import paths from '@pkg/utils/paths';
import { sullaFilesCapabilityKey } from '@pkg/utils/sullaFilesKey';
import { resolveSullaFilesUserRoot } from '@pkg/utils/sullaFilesPaths';

const console = Logging.background;
const DEFAULT_IGNORES = ['.DS_Store', '._*', '*.tmp', '~$*', '.git/', 'node_modules/', '*.sulla-conflict-*', '.sulla-trash/'];
const API = 'http://127.0.0.1:30124';

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

function ignored(relativePath:string, patterns:string[]):boolean {
  const normalized = relativePath.split(path.sep).join('/'); const parts = normalized.split('/');
  return patterns.some(raw => { const pattern = raw.trim().replace(/^\//, ''); if (!pattern || pattern.startsWith('#')) return false; if (pattern.endsWith('/')) return parts.slice(0, -1).includes(pattern.slice(0, -1)); const expression = new RegExp(`^${ pattern.split('*').map(value => value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&')).join('.*') }$`); return expression.test(normalized) || parts.some(part => expression.test(part)) });
}

class SullaFilesWatcher {
  readonly folder = resolveSullaFilesUserRoot().activePath;
  private watcher?:     fs.FSWatcher;
  private rescanTimer?: NodeJS.Timeout;
  private safetyTimer?: NodeJS.Timeout;
  private resumeTimer?: NodeJS.Timeout;
  private started = false;
  private stopped = false;
  private lockGeneration = 0;
  private readonly keychain = new SullaFilesKeychain(
    path.join(paths.appHome, 'files-master-key.enc'),
    async() => (await import('electron')).safeStorage,
    async(key) => {
      const generation = this.lockGeneration;
      const body = Buffer.from(JSON.stringify({ masterKey: key.toString('base64') }));
      try {
        await this.requireAppUnlocked();
        const unlock = await this.rawLocalRequest('/v1/local/unlock', { method: 'POST', body });
        if (!unlock.ok) {
          const recovery = await this.rawLocalRequest('/v1/local/recovery/device', { method: 'POST', body });
          if (!recovery.ok) throw new Error('Files keychain bootstrap and recovery failed');
        }
        if (generation !== this.lockGeneration || this.stopped || !await this.appUnlocked()) {
          await this.rawLocalRequest('/v1/local/lock', { method: 'POST' });
          throw new Error('Files is shutting down');
        }
      } finally {
        body.fill(0);
      }
    },
    [
      { sourcePath: path.join(this.folder, 'master.key'), archivePath: path.join(paths.appHome, 'files-legacy-shared-master-key.enc') },
      { sourcePath: path.join(paths.sullaHome, 'private-files-quarantine', 'master.key'), archivePath: path.join(paths.appHome, 'files-legacy-quarantined-master-key.enc') },
    ],
    async(master, legacyMasters) => {
      const body = Buffer.from(JSON.stringify({ masterKey: master.toString('base64'), legacyMasterKeys: legacyMasters.map(key => key.toString('base64')) }));
      try {
        const response = await this.rawLocalRequest('/v1/local/legacy-import', { method: 'POST', body }, 30 * 60_000);
        if (!response.ok) {
          const failure = await response.json().catch(() => ({})) as { code?:unknown; stage?:unknown; reason?:unknown };
          const stages = ['precheck', 'completion-check', 'staging', 'layout', 'key-authentication', 'conversion', 'publication'];
          const reasons = ['COLLECTION_KEY_AUTHENTICATION_FAILED', 'SOURCE_LAYOUT_INVALID', 'MANIFEST_VERIFICATION_FAILED', 'CHUNK_VERIFICATION_FAILED', 'VERSION_SIZE_VERIFICATION_FAILED', 'IDENTITY_MAPPING_INCOMPLETE', 'MASTER_KEY_AUTHENTICATION_FAILED', 'DATABASE_CONSTRAINT_FAILED', 'DATABASE_TRANSACTION_RETRY_REQUIRED', 'INTERNAL_ERROR'];
          const code = 'FILES_LEGACY_IMPORT_FAILED';
          const stage = typeof failure.stage === 'string' && stages.includes(failure.stage) ? failure.stage : 'unknown';
          const reason = typeof failure.reason === 'string' && reasons.includes(failure.reason) ? failure.reason : 'INTERNAL_ERROR';
          throw Object.assign(new Error(`Legacy Files import failed [${ code }:${ stage }:${ reason }]`), { code, stage, reason });
        }
      } finally { body.fill(0) }
    },
  );

  private async appUnlocked(): Promise<boolean> {
    const { getVaultKeyService } = await import('@pkg/agent/services/VaultKeyService');
    return getVaultKeyService().isUnlocked();
  }

  private async requireAppUnlocked(): Promise<void> {
    if (this.stopped || !await this.appUnlocked()) throw new Error('Files is locked with the application');
  }

  async lockService(): Promise<void> {
    this.lockGeneration++;
    // Let an in-flight unlock finish before locking, preventing a late response
    // from undoing an explicit user lock. New unlocks check the app vault state.
    await this.keychain.settled();
    const response = await this.rawLocalRequest('/v1/local/lock', { method: 'POST' });
    if (!response.ok) throw new Error('Files service could not be locked');
  }

  private async ensureUnlocked(): Promise<void> {
    await this.requireAppUnlocked();
    const response = await this.rawLocalRequest('/healthz');
    if (!response.ok) throw new Error('Files service is unavailable');
    const health = await response.json();
    // Never send a master key to an older image with no memory-only protocol.
    if (typeof health.locked !== 'boolean') throw new Error('Files service requires a keychain-compatible update');
    if (!health.legacyImport || !['clear', 'secure-import-required'].includes(health.legacyImport.state)) throw new Error('Files service requires a legacy-preflight-compatible update');
    if (health.locked) {
      // The service has migrated/classified metadata before this point. Secure
      // legacy plaintext custody separately, then refuse native unlock until
      // explicit recovery has installed the external collection keys.
      await this.keychain.archiveLegacyKeys();
      if (health.legacyImport.state === 'secure-import-required') await this.keychain.importLegacy();
      await this.keychain.unlock();
    }
    await this.requireAppUnlocked();
  }

  private async rawLocalRequest(endpoint:string, init:RequestInit = {}, timeoutMs = 30_000):Promise<Response> {
    const token = await SullaSettingsModel.getServicePassword();
    return fetch(`${ API }${ endpoint }`, { ...init, headers: { 'content-type': 'application/json', ...(init.headers as any), 'x-sulla-files-token': token }, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
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
    if (this.started) return; this.started = true; this.stopped = false; app.once('before-quit', () => this.shutdown()); await fs.promises.mkdir(this.folder, { recursive: true, mode: 0o700 });
    if (process.platform === 'darwin') {
      try { await spawnFile('/usr/bin/defaults', ['write', 'group.io.sulla.desktop', 'FilesRoot', this.folder]) } catch (error) { console.warn('[SullaFiles] Finder extension root configuration failed:', error) }
    }
    try { this.watcher = fs.watch(this.folder, { recursive: process.platform !== 'linux', persistent: false }, (_event, filename) => { if (filename) this.changed(filename.toString()).catch(error => console.warn('[SullaFiles] watch event failed:', error)); }) } catch (error) { console.warn('[SullaFiles] host folder watcher unavailable; periodic rescans remain active:', error) }
    this.safetyTimer = setInterval(() => this.notifyRescan().catch(error => console.debug('[SullaFiles] periodic rescan failed:', error)), 5 * 60_000); this.safetyTimer.unref();
    setTimeout(() => this.notifyRescan().catch(error => console.debug('[SullaFiles] startup rescan failed:', error)), 2_000).unref();
    const pauseUntil = Number(await SullaSettingsModel.get('sullaFilesPauseUntil', 0));
    if (pauseUntil > Date.now()) await this.pauseFor(pauseUntil - Date.now());
    else if (pauseUntil) await SullaSettingsModel.set('sullaFilesPauseUntil', 0, 'number');
  }

  shutdown():void { this.stopped = true; this.lockService().catch(() => undefined); this.watcher?.close(); if (this.rescanTimer) clearTimeout(this.rescanTimer); if (this.safetyTimer) clearInterval(this.safetyTimer); if (this.resumeTimer) clearTimeout(this.resumeTimer); this.started = false }
  private async patterns():Promise<string[]> { try { return [...DEFAULT_IGNORES, ...(await fs.promises.readFile(path.join(this.folder, '.sullaignore'), 'utf8')).split(/\r?\n/)] } catch { return DEFAULT_IGNORES } }
  private async changed(relativePath:string):Promise<void> {
    if (ignored(relativePath, await this.patterns())) return; const absolute = path.resolve(this.folder, relativePath); if (!absolute.startsWith(`${ this.folder }${ path.sep }`)) return;
    try { const first = await fs.promises.stat(absolute); if (!first.isFile()) return; await new Promise(resolve => setTimeout(resolve, 600)); const second = await fs.promises.stat(absolute); if (first.size !== second.size || first.mtimeMs !== second.mtimeMs) return this.changed(relativePath); } catch { /* rename/delete: rescan now */ }
    if (this.rescanTimer) clearTimeout(this.rescanTimer); this.rescanTimer = setTimeout(() => this.notifyRescan().catch(error => console.debug('[SullaFiles] debounced rescan failed:', error)), 350);
  }

  private async request(endpoint:string, init:RequestInit = {}):Promise<Response> {
    return this.localRequest(endpoint, init);
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
      sub: userId, device_id: deviceId, scopes: ['files/*'],
      agent_id: context.agentId, job_id: context.jobId, thread_id: context.threadId,
      v: 1, iss: 'sulla-files', aud: 'sulla-tools', iat: now, exp: now + 300, jti: crypto.randomUUID(),
    }));

    return `${ header }.${ payload }.${ crypto.createHmac('sha256', key).update(`${ header }.${ payload }`).digest('base64url') }`;
  }

  async requestFiles(endpoint:string, init:RequestInit = {}, server = false, capability: SullaFilesCapabilityContext = {}):Promise<Response> {
    const base = server && process.env.SULLA_FILES_SERVER_URL ? process.env.SULLA_FILES_SERVER_URL : API;
    const url = new URL(endpoint, base);
    if (url.origin !== new URL(base).origin) throw new Error('Files endpoint must use the configured service');
    if (base !== API) {
      const token = await this.capabilityToken(undefined, capability);

      return fetch(url, { ...init, headers: { authorization: `Bearer ${ token }`, ...(init.headers as any) }, redirect: 'error', signal: init.signal ?? AbortSignal.timeout(30_000) });
    }
    await this.ensureUnlocked();
    let principalId = await this.localPrincipalId();
    const send = async() => {
      const token = await this.capabilityToken(principalId, capability);

      return fetch(url, { ...init, headers: { authorization: `Bearer ${ token }`, ...(init.headers as any) }, redirect: 'error' as const, signal: init.signal ?? AbortSignal.timeout(30_000) });
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

      return fetch(url, { ...init, headers: { authorization: `Bearer ${ token }`, ...(init.headers as any) }, redirect: 'error' as const, signal });
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

  async openFolder():Promise<void> { const error = await shell.openPath(this.folder); if (error) throw new Error(error); }
}

let instance:SullaFilesWatcher | undefined;
export function getSullaFilesWatcher():SullaFilesWatcher { instance ??= new SullaFilesWatcher(); return instance }
