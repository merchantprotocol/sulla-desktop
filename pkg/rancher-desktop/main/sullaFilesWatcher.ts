import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { shell } from 'electron';

import { SullaSettingsModel } from '@pkg/agent/database/models/SullaSettingsModel';
import Logging from '@pkg/utils/logging';

const console = Logging.background;
const DEFAULT_IGNORES = ['.DS_Store', '._*', '*.tmp', '~$*', '.git/', 'node_modules/', '*.sulla-conflict-*', '.sulla-trash/'];
const API = 'http://127.0.0.1:30124';

export interface SullaFilesStatus { state: 'synced' | 'syncing' | 'paused' | 'error'; pendingFiles: number; lastError?: string; serverConfigured: boolean }

function ignored(relativePath:string, patterns:string[]):boolean {
  const normalized = relativePath.split(path.sep).join('/'); const parts = normalized.split('/');
  return patterns.some(raw => { const pattern = raw.trim().replace(/^\//, ''); if (!pattern || pattern.startsWith('#')) return false; if (pattern.endsWith('/')) return parts.slice(0, -1).includes(pattern.slice(0, -1)); const expression = new RegExp(`^${ pattern.split('*').map(value => value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&')).join('.*') }$`); return expression.test(normalized) || parts.some(part => expression.test(part)) });
}

class SullaFilesWatcher {
  readonly folder = path.join(os.homedir(), 'sulla', 'Files');
  private watcher?:     fs.FSWatcher;
  private rescanTimer?: NodeJS.Timeout;
  private safetyTimer?: NodeJS.Timeout;
  private started = false;
  async initialize():Promise<void> {
    if (this.started) return; this.started = true; await fs.promises.mkdir(this.folder, { recursive: true, mode: 0o700 });
    try { this.watcher = fs.watch(this.folder, { recursive: process.platform !== 'linux', persistent: false }, (_event, filename) => { if (filename) this.changed(filename.toString()).catch(error => console.warn('[SullaFiles] watch event failed:', error)); }) } catch (error) { console.warn('[SullaFiles] host folder watcher unavailable; periodic rescans remain active:', error) }
    this.safetyTimer = setInterval(() => this.notifyRescan().catch(error => console.debug('[SullaFiles] periodic rescan failed:', error)), 5 * 60_000); this.safetyTimer.unref();
    setTimeout(() => this.notifyRescan().catch(error => console.debug('[SullaFiles] startup rescan failed:', error)), 2_000).unref();
  }

  shutdown():void { this.watcher?.close(); if (this.rescanTimer) clearTimeout(this.rescanTimer); if (this.safetyTimer) clearInterval(this.safetyTimer); this.started = false }
  private async patterns():Promise<string[]> { try { return [...DEFAULT_IGNORES, ...(await fs.promises.readFile(path.join(this.folder, '.sullaignore'), 'utf8')).split(/\r?\n/)] } catch { return DEFAULT_IGNORES } }
  private async changed(relativePath:string):Promise<void> {
    if (ignored(relativePath, await this.patterns())) return; const absolute = path.resolve(this.folder, relativePath); if (!absolute.startsWith(`${ this.folder }${ path.sep }`)) return;
    try { const first = await fs.promises.stat(absolute); if (!first.isFile()) return; await new Promise(resolve => setTimeout(resolve, 600)); const second = await fs.promises.stat(absolute); if (first.size !== second.size || first.mtimeMs !== second.mtimeMs) return this.changed(relativePath); } catch { /* rename/delete: rescan now */ }
    if (this.rescanTimer) clearTimeout(this.rescanTimer); this.rescanTimer = setTimeout(() => this.notifyRescan().catch(error => console.debug('[SullaFiles] debounced rescan failed:', error)), 350);
  }

  private async request(endpoint:string, init:RequestInit = {}):Promise<Response> { const token = await SullaSettingsModel.getServicePassword(); return fetch(`${ API }${ endpoint }`, { ...init, headers: { 'x-sulla-files-token': token, 'content-type': 'application/json', ...(init.headers as any) }, signal: AbortSignal.timeout(3_000) }) }
  async notifyRescan():Promise<void> { try { const response = await this.request('/v1/local/rescan', { method: 'POST' }); if (!response.ok) throw new Error(`HTTP ${ response.status }`); } catch (error) { console.debug('[SullaFiles] optional container is offline; folder remains local-only:', error) } }
  async status():Promise<SullaFilesStatus> { try { const response = await this.request('/v1/local/status'); if (!response.ok) throw new Error(`HTTP ${ response.status }`); return await response.json() as SullaFilesStatus } catch { return { state: 'error', pendingFiles: 0, lastError: 'Files container is off; files remain local', serverConfigured: false } } }
  async setPaused(paused:boolean):Promise<SullaFilesStatus> { const response = await this.request('/v1/local/pause', { method: 'POST', body: JSON.stringify({ paused }) }); if (!response.ok) throw new Error(`Files pause failed (${ response.status })`); return await response.json() as SullaFilesStatus }
  async openFolder():Promise<void> { const error = await shell.openPath(this.folder); if (error) throw new Error(error); }
}

let instance:SullaFilesWatcher | undefined;
export function getSullaFilesWatcher():SullaFilesWatcher { instance ??= new SullaFilesWatcher(); return instance }
