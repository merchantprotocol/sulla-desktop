// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import path from 'node:path';
import { shell } from 'electron';
import { FilesListingPager } from '../agent/files/FilesListingPager';
import { FINDER_BADGE_ATTRIBUTE, FinderBadgeSync } from './sullaFinderBadges';
import { SullaSettingsModel } from '@pkg/agent/database/models/SullaSettingsModel';
import Logging from '@pkg/utils/logging';
import type { NativeSourceIngestInput, NativeSourceFileResult, RecentSullaFile, SullaFilesRootStatus, SullaFilesStatus } from './SullaFilesWatcherSupport';
import type { SullaFilesWatcherRequestService } from './SullaFilesWatcherRequestService';

const console = Logging.background;

export class SullaFilesWatcherOperations {
  private readonly finderBadges = new Map<string, FinderBadgeSync>();
  private resumeTimer?:NodeJS.Timeout;

  constructor(private readonly requests:SullaFilesWatcherRequestService, private readonly folder:string) {}

  private request(endpoint:string, init:RequestInit = {}):Promise<Response> { return this.requests.localRequest(endpoint, init) }

  async refreshFinderBadges():Promise<void> {
    if (process.platform !== 'darwin') return;
    const { getSullaFilesRootRegistry } = await import('./sullaFilesRootRegistry');
    for (const root of await getSullaFilesRootRegistry().list()) {
      if (root.activation !== 'active' || !root.collectionId) continue;
      let badges = this.finderBadges.get(root.id);
      if (!badges) {
        badges = new FinderBadgeSync(root.path, async(target, state) => {
          const { setAttribute } = await import('@napi-rs/xattr');
          await setAttribute(target, FINDER_BADGE_ATTRIBUTE, state);
        });
        this.finderBadges.set(root.id, badges);
      }
      if (!badges.begin()) continue;
      try {
        const badgeResponse = await this.requests.requestFiles(`/v1/desktop/cloud-sync/finder-badges?collectionId=${ encodeURIComponent(root.collectionId) }`).catch(() => null);
        const processed = new Map((badgeResponse?.ok ? await badgeResponse.json() as {path:string;state:string}[] : []).map(item => [item.path, item.state]));
        const query = new URLSearchParams({ collectionId:root.collectionId, path:'', trash:'false' });
        for await (const files of FilesListingPager.pages<{path:string;sync_state?:string}>(url => this.requests.requestFiles(url), '/v1/files', query)) {
          await badges.apply(files.map(file => ({
            path:file.path,
            sync_state:['conflict','syncing','online-only'].includes(file.sync_state ?? '') ? file.sync_state : processed.get(file.path) ?? file.sync_state,
          })));
        }
      } finally { badges.end() }
    }
  }

  async status():Promise<SullaFilesStatus> {
    try {
      const response = await this.request('/v1/local/status');
      if (!response.ok) throw new Error(`HTTP ${ response.status }`);
      const status = await response.json() as SullaFilesStatus;
      const serverUrl = process.env.SULLA_FILES_SERVER_URL;
      const serverLabel = serverUrl ? new URL(serverUrl).hostname : status.serverConfigured ? 'Sulla Server' : undefined;
      return { ...status, location: !status.serverConfigured ? 'local' : serverLabel?.endsWith('sulla.cloud') ? 'cloud' : 'server', serverLabel: serverLabel?.endsWith('sulla.cloud') ? 'Sulla Cloud' : serverLabel };
    } catch {
      return { state:'error', pendingFiles:0, lastError:'Files container is off; files remain safely in ~/sulla/files', serverConfigured:false, location:'local' };
    }
  }

  async setPaused(paused:boolean):Promise<SullaFilesStatus> {
    const response = await this.request('/v1/local/pause', { method:'POST', body:JSON.stringify({ paused }) });
    if (!response.ok) throw new Error(`Files pause failed (${ response.status })`);
    return response.json() as Promise<SullaFilesStatus>;
  }

  async rootStatuses():Promise<SullaFilesRootStatus[]> {
    const response = await this.requests.rawLocalRequest('/v1/local/roots');
    if (!response.ok) throw new Error(`Files roots are unavailable (${ response.status })`);
    const roots = await response.json() as SullaFilesRootStatus[];
    if (!roots.length) throw new Error('Files roots are locked or have not initialized');
    return roots;
  }

  async configureRoot(id:string, input:{ paused?:boolean; syncMode?:'local' | 'server'; exclusions?:string[] }):Promise<SullaFilesRootStatus> {
    const response = await this.requests.rawLocalRequest(`/v1/local/roots/${ encodeURIComponent(id) }`, { method:'PATCH', body:JSON.stringify(input) });
    if (!response.ok) throw new Error(`Files root update failed (${ response.status })`);
    return response.json() as Promise<SullaFilesRootStatus>;
  }

  async detachRoot(id:string):Promise<void> {
    const response = await this.requests.rawLocalRequest(`/v1/local/roots/${ encodeURIComponent(id) }`, { method:'DELETE' });
    if (!response.ok && response.status !== 404) throw new Error(`Files root removal failed (${ response.status })`);
  }

  async pauseFor(ms:number):Promise<SullaFilesStatus> {
    await SullaSettingsModel.set('sullaFilesPauseUntil', Date.now() + ms, 'number');
    if (this.resumeTimer) clearTimeout(this.resumeTimer);
    this.resumeTimer = setTimeout(() => {
      this.setPaused(false).catch(error => console.warn('[SullaFiles] automatic resume failed:', error));
      SullaSettingsModel.set('sullaFilesPauseUntil', 0, 'number').catch(() => undefined);
    }, ms);
    this.resumeTimer.unref();
    return this.setPaused(true);
  }

  async recentFiles(limit = 4):Promise<RecentSullaFile[]> {
    const response = await this.request(`/v1/local/recent?limit=${ Math.max(1, Math.min(limit, 20)) }`);
    if (!response.ok) throw new Error(`Recent Files request failed (${ response.status })`);
    return response.json() as Promise<RecentSullaFile[]>;
  }

  async findFile(relativePath:string):Promise<RecentSullaFile | undefined> {
    const response = await this.request(`/v1/local/recent?limit=100&path=${ encodeURIComponent(relativePath) }`);
    if (!response.ok) return undefined;
    return (await response.json() as RecentSullaFile[])[0];
  }

  async ingestNativeSource(input:NativeSourceIngestInput):Promise<NativeSourceFileResult> {
    const collectionResponse = input.collectionId ? undefined : await this.request('/v1/local/native-sources/collection');
    if (collectionResponse && !collectionResponse.ok) throw new Error(`Files collection request failed (${ collectionResponse.status })`);
    const collection = input.collectionId ? { collectionId:input.collectionId } : await collectionResponse!.json() as { collectionId?:unknown };
    if (typeof collection.collectionId !== 'string' || !collection.collectionId) throw new Error('Files returned an invalid native source collection');
    const name = path.basename(input.name).replaceAll('/', '_');
    if (!name || name === '.' || name === '..') throw new Error('Native source name is invalid');
    const query = new URLSearchParams({ collectionId:collection.collectionId, path:input.filesPath ?? `Native Sources/${ name }` });
    if (input.fileId) query.set('fileId', input.fileId);
    const headers:Record<string, string> = {
      'content-type':input.mime ?? 'application/octet-stream', 'x-sulla-operation-id':input.operationId,
      'x-sulla-source-handle':input.handle, 'x-sulla-source-revision':input.sourceRevision, 'x-sulla-source-hash':input.contentHash,
    };
    if (input.baseVersionId) headers['x-sulla-files-base-version'] = input.baseVersionId;
    const body = new ArrayBuffer(input.bytes.byteLength);
    new Uint8Array(body).set(input.bytes);
    const response = input.internal
      ? await this.requests.rawLocalRequest(`/v1/local/native-sources/ingest?${ query }`, { method:'PUT', headers, body })
      : await this.request(`/v1/local/native-sources/ingest?${ query }`, { method:'PUT', headers, body });
    if (!response.ok) throw new Error(`Native source ingestion failed (${ response.status }): ${ await response.text() }`);
    return response.json() as Promise<NativeSourceFileResult>;
  }

  async planNativePublication(input:{operationId:string;handle:string;sourceRevision:string;contentHash:string;fileId:string;baseVersionId:string}):Promise<void> {
    const response = await this.request('/v1/local/native-sources/publications', {
      method:'POST', headers:{ 'x-sulla-operation-id':input.operationId, 'x-sulla-source-handle':input.handle,
        'x-sulla-source-revision':input.sourceRevision, 'x-sulla-source-hash':input.contentHash },
      body:JSON.stringify({ fileId:input.fileId, baseVersionId:input.baseVersionId }),
    });
    if (!response.ok) throw new Error(`Native source publication planning failed (${ response.status }): ${ await response.text() }`);
  }

  async finishNativePublication(operationId:string, result:Record<string, unknown>):Promise<void> {
    const response = await this.request(`/v1/local/native-sources/publications/${ encodeURIComponent(operationId) }/finish`, { method:'POST', body:JSON.stringify(result) });
    if (!response.ok) throw new Error(`Native source publication finalization failed (${ response.status }): ${ await response.text() }`);
  }

  async reselectInterruptedNativePublication(input:{fileId:string;previousHandle:string;handle:string;sourceRevision:string;sourceHash:string}):Promise<boolean> {
    const response = await this.request('/v1/local/native-sources/reselect-interrupted-publication', { method:'POST', body:JSON.stringify(input) });
    if (!response.ok) throw new Error(`Interrupted native publication reselection failed (${ response.status }): ${ await response.text() }`);
    return Boolean((await response.json() as { recovered?:boolean }).recovered);
  }

  async folderForCollection(collectionId?:string):Promise<string> {
    if (!collectionId) return this.folder;
    const { getSullaFilesRootRegistry } = await import('./sullaFilesRootRegistry');
    const root = await getSullaFilesRootRegistry().rootForCollection(collectionId);
    if (!root) throw new Error('That Files collection has no active local folder.');
    return root.path;
  }

  async openFolder(collectionId?:string):Promise<void> {
    const error = await shell.openPath(await this.folderForCollection(collectionId));
    if (error) throw new Error(error);
  }

  stop():void { if (this.resumeTimer) clearTimeout(this.resumeTimer); this.resumeTimer = undefined }
  clearBadge(id:string):void { this.finderBadges.delete(id) }
}
