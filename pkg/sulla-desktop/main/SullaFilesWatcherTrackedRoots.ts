// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { FilesListingPager } from '../agent/files/FilesListingPager';
import { sullaAppGroupDefaultsDomain } from './sullaAppGroup';
import { SullaSettingsModel } from '@pkg/agent/database/models/SullaSettingsModel';
import { spawnFile } from '@pkg/utils/childProcess';
import Logging from '@pkg/utils/logging';
import { DEFAULT_IGNORES, ignored, isSensitiveTrackedPath, trackedMime, type SullaFilesRootStatus } from './SullaFilesWatcherSupport';
import type { SullaFilesWatcherRequestService } from './SullaFilesWatcherRequestService';

const console = Logging.background;

export interface SullaFilesTrackedRoot {
  id:string; name:string; path:string; syncMode:'local' | 'server'; paused:boolean; exclusions:string[];
}

export class SullaFilesWatcherTrackedRoots {
  private readonly watchers = new Map<string, fs.FSWatcher>();
  private readonly fingerprints = new Map<string, string>();
  private readonly scans = new Map<string, Promise<void>>();
  private readonly queuedRescans = new Set<string>();
  private fingerprintsLoaded = false;

  constructor(private readonly context:{
    filesRequests:SullaFilesWatcherRequestService;
    rootStatuses:() => Promise<SullaFilesRootStatus[]>;
    requestFiles:(endpoint:string, init?:RequestInit) => Promise<Response>;
    refreshFinderBadges:() => Promise<void>;
    clearBadge:(rootId:string) => void;
  }) {}

  async configureFinderRoots(paths:string[]):Promise<void> {
    if (process.platform !== 'darwin') return;
    try {
      const domain = sullaAppGroupDefaultsDomain();
      await spawnFile('/usr/bin/defaults', ['write', domain, 'FilesRoots', '-array', ...paths]);
      if (paths[0]) await spawnFile('/usr/bin/defaults', ['write', domain, 'FilesRoot', paths[0]]);
    } catch (error) { console.warn('[SullaFiles] Finder extension roots configuration failed:', error) }
  }

  watchRoot(id:string, rootPath:string):void {
    this.watchers.get(id)?.close();
    try {
      this.watchers.set(id, fs.watch(rootPath, { recursive: process.platform !== 'linux', persistent: false }, () => {
        this.scanBrokeredRoot(id, rootPath).catch(error => console.warn(`[SullaFiles] tracked root ${ id } scan failed:`, error));
      }));
    } catch (error) { console.warn(`[SullaFiles] watcher unavailable for root ${ id }:`, error) }
  }

  async enrollRoot(root:SullaFilesTrackedRoot):Promise<SullaFilesRootStatus> {
    const attached = await this.context.filesRequests.rawLocalRequest('/v1/local/roots', {
      method: 'POST', body: JSON.stringify({ id:root.id, name:root.name, syncMode:root.syncMode, paused:root.paused, exclusions:root.exclusions }),
    });
    if (!attached.ok) throw new Error(`Files rejected the tracked folder (${ attached.status }): ${ await attached.text() }`);
    this.watchRoot(root.id, root.path);
    const { getSullaFilesRootRegistry } = await import('./sullaFilesRootRegistry');
    await this.configureFinderRoots((await getSullaFilesRootRegistry().stored()).map(item => item.path));
    if (!root.paused) this.scanBrokeredRoot(root.id, root.path).catch(error => console.warn(`[SullaFiles] tracked root ${ root.id } scan failed:`, error));
    return (await this.context.rootStatuses()).find(item => item.id === root.id)!;
  }

  async forgetRoot(id:string):Promise<void> {
    this.watchers.get(id)?.close();
    this.watchers.delete(id);
    this.context.clearBadge(id);
    const { getSullaFilesRootRegistry } = await import('./sullaFilesRootRegistry');
    await this.configureFinderRoots((await getSullaFilesRootRegistry().stored()).filter(root => root.id !== id).map(root => root.path));
  }

  shutdown():void {
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
  }

  private scanBrokeredRoot(id:string, rootPath:string):Promise<void> {
    const running = this.scans.get(id);
    if (running) { this.queuedRescans.add(id); return running }
    const scan = this.scanBrokeredRootNow(id, rootPath).finally(() => {
      if (this.scans.get(id) === scan) this.scans.delete(id);
      if (this.queuedRescans.delete(id)) this.scanBrokeredRoot(id, rootPath).catch(error => console.warn(`[SullaFiles] tracked root ${ id } scan failed:`, error));
    });
    this.scans.set(id, scan);
    return scan;
  }

  private async scanBrokeredRootNow(id:string, rootPath:string):Promise<void> {
    const roots = await this.context.rootStatuses();
    const root = roots.find(item => item.id === id);
    if (!root || root.paused) return;
    const state = async(state:'scanning' | 'idle' | 'error', pendingFiles = 0, lastError?:string) => {
      const response = await this.context.filesRequests.rawLocalRequest(`/v1/local/roots/${ encodeURIComponent(id) }/scan-state`, {
        method:'POST', body:JSON.stringify({ state, pendingFiles, lastError }),
      });
      if (!response.ok) throw new Error(`Files scan state failed (${ response.status })`);
    };
    try {
      await state('scanning');
      let count = 0;
      if (!this.fingerprintsLoaded) {
        const saved = await SullaSettingsModel.get('sullaFilesRootFingerprints', {});
        if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
          for (const [key, value] of Object.entries(saved)) if (typeof value === 'string') this.fingerprints.set(key, value);
        }
        this.fingerprintsLoaded = true;
      }
      const current = new Map<string, number>();
      const query = new URLSearchParams({ collectionId: root.collectionId, path: '', trash: 'false' });
      for await (const rows of FilesListingPager.pages<{path:string;size:number}>(url => this.context.requestFiles(url), '/v1/files', query)) {
        if (current.size + rows.length > 100_000) throw new Error('Tracked collection exceeds the 100,000-file reconciliation safety limit');
        for (const file of rows) current.set(file.path, Number(file.size));
      }
      const walk = async(directory:string):Promise<void> => {
        for (const entry of await fs.promises.readdir(directory, { withFileTypes:true })) {
          const absolute = path.join(directory, entry.name);
          const relative = path.relative(rootPath, absolute).split(path.sep).join('/');
          if (ignored(relative, DEFAULT_IGNORES) || ignored(relative, root.exclusions) || isSensitiveTrackedPath(relative)) continue;
          if (entry.isSymbolicLink()) continue;
          if (entry.isDirectory()) { await walk(absolute); continue }
          if (!entry.isFile()) continue;
          if (++count > 100_000) throw new Error('Tracked folder exceeds the 100,000-file safety limit');
          if (count % 25 === 0) await state('scanning', count);
          const stat = await fs.promises.stat(absolute);
          if (stat.size > 2 * 1024 * 1024 * 1024) throw new Error(`${ relative } exceeds the 2 GB tracked-file limit`);
          const key = `${ id }:${ relative }`;
          const stamp = `${ stat.size }:${ stat.mtimeMs }`;
          if (this.fingerprints.get(key)?.startsWith(`${ stamp }:`) && current.get(relative) === stat.size) continue;
          const bytes = await fs.promises.readFile(absolute);
          const fingerprint = `${ stamp }:${ crypto.createHash('sha256').update(bytes).digest('hex') }`;
          if (this.fingerprints.get(key)?.split(':').pop() === fingerprint.split(':').pop() && current.get(relative) === stat.size) {
            this.fingerprints.set(key, fingerprint);
            continue;
          }
          const response = await this.context.requestFiles(`/v1/files/upload?collectionId=${ encodeURIComponent(root.collectionId) }&path=${ encodeURIComponent(relative) }`, {
            method:'PUT', headers:{ 'content-type': trackedMime(relative) }, body:bytes,
          });
          if (!response.ok) throw new Error(`Could not index ${ relative } (${ response.status })`);
          this.fingerprints.set(key, fingerprint);
          current.set(relative, stat.size);
        }
      };
      await walk(rootPath);
      await SullaSettingsModel.set('sullaFilesRootFingerprints', Object.fromEntries(this.fingerprints), 'json');
      await state('idle', 0);
      await this.context.refreshFinderBadges();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await state('error', 0, message).catch(() => undefined);
      throw error;
    }
  }
}
