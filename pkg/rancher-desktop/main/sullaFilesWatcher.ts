import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { shell } from 'electron';

import { SullaSettingsModel } from '@pkg/agent/database/models/SullaSettingsModel';
import { getDesktopDeviceId } from '@pkg/main/deviceIdentity';
import Logging from '@pkg/utils/logging';
import { sullaFilesCapabilityKey } from '@pkg/utils/sullaFilesKey';

const console = Logging.background;
const DEFAULT_IGNORES = ['.DS_Store', '._*', '*.tmp', '~$*', '.git/', 'node_modules/', '*.sulla-conflict-*', '.sulla-trash/'];
const API = 'http://127.0.0.1:30124';

export interface SullaFilesStatus {
  state:            'synced' | 'syncing' | 'paused' | 'error' | 'conflict';
  pendingFiles:     number;
  pendingBytes?:    number;
  processedBytes?:  number;
  totalBytes?:      number;
  estimatedSeconds?: number;
  lastError?:       string;
  lastScanAt?:      string;
  lastSyncAt?:      string;
  serverConfigured: boolean;
  location?:        'local' | 'server' | 'cloud';
  serverLabel?:     string;
}

export interface RecentSullaFile {
  id: string; path: string; mime: string; size: number; updatedAt: string; conflict: boolean;
  durationSeconds?: number;
  syncState: 'synced' | 'syncing' | 'error';
}

function ignored(relativePath:string, patterns:string[]):boolean {
  const normalized = relativePath.split(path.sep).join('/'); const parts = normalized.split('/');
  return patterns.some(raw => { const pattern = raw.trim().replace(/^\//, ''); if (!pattern || pattern.startsWith('#')) return false; if (pattern.endsWith('/')) return parts.slice(0, -1).includes(pattern.slice(0, -1)); const expression = new RegExp(`^${ pattern.split('*').map(value => value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&')).join('.*') }$`); return expression.test(normalized) || parts.some(part => expression.test(part)) });
}

class SullaFilesWatcher {
  readonly folder = path.join(os.homedir(), 'sulla', 'Files');
  private watcher?:     fs.FSWatcher;
  private rescanTimer?: NodeJS.Timeout;
  private safetyTimer?: NodeJS.Timeout;
  private resumeTimer?: NodeJS.Timeout;
  private started = false;
  async initialize():Promise<void> {
    if (this.started) return; this.started = true; await fs.promises.mkdir(this.folder, { recursive: true, mode: 0o700 });
    try { this.watcher = fs.watch(this.folder, { recursive: process.platform !== 'linux', persistent: false }, (_event, filename) => { if (filename) this.changed(filename.toString()).catch(error => console.warn('[SullaFiles] watch event failed:', error)); }) } catch (error) { console.warn('[SullaFiles] host folder watcher unavailable; periodic rescans remain active:', error) }
    this.safetyTimer = setInterval(() => this.notifyRescan().catch(error => console.debug('[SullaFiles] periodic rescan failed:', error)), 5 * 60_000); this.safetyTimer.unref();
    setTimeout(() => this.notifyRescan().catch(error => console.debug('[SullaFiles] startup rescan failed:', error)), 2_000).unref();
    const pauseUntil = Number(await SullaSettingsModel.get('sullaFilesPauseUntil', 0));
    if (pauseUntil > Date.now()) await this.pauseFor(pauseUntil - Date.now());
    else if (pauseUntil) await SullaSettingsModel.set('sullaFilesPauseUntil', 0, 'number');
  }

  shutdown():void { this.watcher?.close(); if (this.rescanTimer) clearTimeout(this.rescanTimer); if (this.safetyTimer) clearInterval(this.safetyTimer); if (this.resumeTimer) clearTimeout(this.resumeTimer); this.started = false }
  private async patterns():Promise<string[]> { try { return [...DEFAULT_IGNORES, ...(await fs.promises.readFile(path.join(this.folder, '.sullaignore'), 'utf8')).split(/\r?\n/)] } catch { return DEFAULT_IGNORES } }
  private async changed(relativePath:string):Promise<void> {
    if (ignored(relativePath, await this.patterns())) return; const absolute = path.resolve(this.folder, relativePath); if (!absolute.startsWith(`${ this.folder }${ path.sep }`)) return;
    try { const first = await fs.promises.stat(absolute); if (!first.isFile()) return; await new Promise(resolve => setTimeout(resolve, 600)); const second = await fs.promises.stat(absolute); if (first.size !== second.size || first.mtimeMs !== second.mtimeMs) return this.changed(relativePath); } catch { /* rename/delete: rescan now */ }
    if (this.rescanTimer) clearTimeout(this.rescanTimer); this.rescanTimer = setTimeout(() => this.notifyRescan().catch(error => console.debug('[SullaFiles] debounced rescan failed:', error)), 350);
  }

  private async request(endpoint:string, init:RequestInit = {}):Promise<Response> { const token = await SullaSettingsModel.getServicePassword(); return fetch(`${ API }${ endpoint }`, { ...init, headers: { 'x-sulla-files-token': token, 'content-type': 'application/json', ...(init.headers as any) }, signal: AbortSignal.timeout(3_000) }) }
  private async capabilityToken():Promise<string> {
    const key = sullaFilesCapabilityKey(await SullaSettingsModel.getServicePassword()); const now = Math.floor(Date.now() / 1_000); const encode = (value:string) => Buffer.from(value).toString('base64url'); const header = encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const deviceId = await getDesktopDeviceId().catch(() => os.hostname());
    const payload = encode(JSON.stringify({ sub: process.env.SULLA_FILES_USER_ID ?? 'desktop-user', device_id: deviceId, scopes: ['files/*'], v: 1, iss: 'sulla-files', aud: 'sulla-tools', iat: now, exp: now + 300, jti: crypto.randomUUID() }));

    return `${ header }.${ payload }.${ crypto.createHmac('sha256', key).update(`${ header }.${ payload }`).digest('base64url') }`;
  }

  async requestFiles(endpoint:string, init:RequestInit = {}, server = false):Promise<Response> {
    const base = server && process.env.SULLA_FILES_SERVER_URL ? process.env.SULLA_FILES_SERVER_URL : API; const token = await this.capabilityToken();

    return fetch(new URL(endpoint, base), { ...init, headers: { authorization: `Bearer ${ token }`, ...(init.headers as any) }, signal: AbortSignal.timeout(30_000) });
  }

  async notifyRescan():Promise<void> { try { const response = await this.request('/v1/local/rescan', { method: 'POST' }); if (!response.ok) throw new Error(`HTTP ${ response.status }`); } catch (error) { console.debug('[SullaFiles] optional container is offline; folder remains local-only:', error) } }
  async status():Promise<SullaFilesStatus> {
    try {
      const response = await this.request('/v1/local/status'); if (!response.ok) throw new Error(`HTTP ${ response.status }`);
      const status = await response.json() as SullaFilesStatus;
      const serverUrl = process.env.SULLA_FILES_SERVER_URL;
      const serverLabel = serverUrl ? new URL(serverUrl).hostname : status.serverConfigured ? 'Sulla Server' : undefined;

      return { ...status, location: !status.serverConfigured ? 'local' : serverLabel?.endsWith('sulla.cloud') ? 'cloud' : 'server', serverLabel: serverLabel?.endsWith('sulla.cloud') ? 'Sulla Cloud' : serverLabel };
    } catch {
      return { state: 'error', pendingFiles: 0, lastError: 'Files container is off; files remain safely in ~/sulla/Files', serverConfigured: false, location: 'local' };
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
