// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { TransactionRunner } from './FilesTransaction.js';
import { FileRootRepository } from './Repositories/FileRootRepository.js';
import { collectionIdFor } from './systemAreas.js';

import type { Config, FileRootConfig } from './config.js';
import type pg from 'pg';

export interface FileRootStatus {
  id: string; name: string; collectionId: string; syncMode: 'local' | 'server'; paused: boolean;
  exclusions: string[]; state: 'idle' | 'scanning' | 'syncing' | 'paused' | 'offline' | 'error' | 'detached';
  pendingFiles: number; serverConfigured: boolean; lastError?: string; lastScanAt?: string; lastSyncAt?: string;
}

export interface BrokeredRootInput { id:string; name:string; syncMode:'local'|'server'; paused:boolean; exclusions:string[] }

const status = (message:string, code:number) => Object.assign(new Error(message), { status: code });

/**
 * The registry of tracked roots: which roots exist, which collection each one fills, and their
 * user-facing settings. `roots` and `rootCollections` are the manager's live instances; this class
 * mutates them in place so every collaborator sees the same view.
 */
export class TrackedRootCatalog {
  constructor(
    db:pg.Pool,
    private readonly config:Config,
    private readonly roots:FileRootConfig[],
    private readonly rootCollections:Map<string, string>,
    private readonly repository = new FileRootRepository(db),
    private readonly transactions = new TransactionRunner(db),
  ) {}

  /** The root's home collection, created (with its keys) on first use. */
  async ensureCollection(root:FileRootConfig):Promise<string> {
    const id = collectionIdFor(this.config.userId, root.id);
    return this.transactions.run('tracked-root-collection', async client => {
      const existing = await this.repository.findHomeCollection(client, id, this.config.userId, Boolean(root.primary));
      if (!existing) {
        await this.repository.createHomeCollection(client, { id, orgId: this.config.orgId ?? null, userId: this.config.userId, name: root.primary ? 'Files' : root.name,
          home: root.syncMode === 'server' && this.config.serverUrl ? 'synced' : 'desktop-only' });
        const wrapped = await this.config.keyring!.create(id, client);
        await this.repository.setCollectionKeys(client, id, wrapped.data, wrapped.dedup);
      } else if (this.config.orgId) await this.repository.setCollectionOrg(client, id, this.config.orgId);
      return existing ?? id;
    });
  }

  /** Register every configured root and detach the ones no longer configured. Returns the primary collection. */
  async registerConfigured():Promise<string | undefined> {
    let primary:string | undefined;
    for (const root of this.roots) {
      const collectionId = await this.ensureCollection(root);
      this.rootCollections.set(root.id, collectionId);
      if (root.primary) primary = collectionId;
      await this.repository.upsertConfigured(root, collectionId);
    }
    await this.repository.detachAllExcept(this.roots.map(root => root.id));
    return primary;
  }

  detachAll():Promise<void> { return this.repository.detachAll() }

  async list():Promise<FileRootStatus[]> {
    return (await this.repository.listEnabled()).map(row => ({
      id: row.id, name: row.display_name, collectionId: row.collection_id, syncMode: row.sync_mode, paused: row.paused,
      exclusions: row.exclusions ?? [], state: (row.paused ? 'paused' : row.state) as FileRootStatus['state'], pendingFiles: row.pending_files,
      serverConfigured: Boolean(this.config.serverUrl),
      lastError: row.last_error ?? undefined, lastScanAt: (row.last_scan_at as any)?.toISOString?.(), lastSyncAt: (row.last_sync_at as any)?.toISOString?.(),
    }));
  }

  /** Register a Desktop-brokered host root without exposing its host path to the container. */
  async attachBrokered(input:BrokeredRootInput):Promise<{ root:FileRootStatus; collectionId:string }> {
    if (!input || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(input.id) || typeof input.name!=='string' || !input.name || !['local','server'].includes(input.syncMode) || typeof input.paused!=='boolean' || !Array.isArray(input.exclusions) || input.exclusions.length>200 || input.exclusions.some(value=>typeof value!=='string'||value.length>500||value.includes('\0'))) throw status('Invalid Files root', 400);
    const collectionId = await this.ensureCollection({ ...input, path:`/brokered/${input.id}`, primary:input.id === 'default' });
    await this.repository.upsertBrokered(input, collectionId);
    this.rootCollections.set(input.id, collectionId);
    return { root: (await this.list()).find(root=>root.id===input.id)!, collectionId };
  }

  async brokeredScanState(id:string, input:{ state:'scanning'|'idle'|'error'; pendingFiles?:number; lastError?:string }):Promise<FileRootStatus> {
    if(!input||!['scanning','idle','error'].includes(input.state)||!Number.isSafeInteger(input.pendingFiles??0)||(input.pendingFiles??0)<0||typeof (input.lastError??'')!=='string'||(input.lastError??'').length>2000)throw status('Invalid scan state', 400);
    if(!await this.repository.setScanState(id, input.state, input.pendingFiles??0, input.lastError??null)) throw status('File root was not found', 404);
    return (await this.list()).find(root=>root.id===id)!;
  }

  async configure(id:string, input:{ paused?:boolean; syncMode?:'local' | 'server'; exclusions?:string[] }, rescan:()=>Promise<void>):Promise<FileRootStatus> {
    const configured = this.roots.find(root => root.id === id);
    const existing = await this.repository.findEnabledSettings(id);
    if (!existing) throw status('File root is not registered', 409);
    if (input.syncMode === 'server' && !this.config.serverUrl) throw status('No Files server is configured', 409);
    const paused=input.paused ?? configured?.paused ?? existing.paused;
    const syncMode=input.syncMode ?? configured?.syncMode ?? existing.sync_mode;
    const exclusions=input.exclusions ?? configured?.exclusions ?? existing.exclusions ?? [];
    if(configured){configured.paused=paused;configured.syncMode=syncMode;configured.exclusions=exclusions;}
    await this.repository.configure(id, paused, syncMode, exclusions);
    if (configured && !paused) await rescan();
    const root = (await this.list()).find(item => item.id === id);
    if (!root) throw status('File root is unavailable', 404);
    return root;
  }

  async detach(id:string):Promise<void> {
    if (id === 'default') throw status('The default Files root cannot be removed', 409);
    // Detaching forgets scan custody only. Source files, encrypted versions,
    // search records and journal history remain untouched and no delete versions
    // are emitted.
    await this.transactions.run('tracked-root-detach', async client => {
      if (!await this.repository.detach(client, id)) throw status('File root was not found', 404);
    });
    const configuredIndex = this.roots.findIndex(root => root.id === id);
    if (configuredIndex >= 0) this.roots.splice(configuredIndex, 1);
    this.rootCollections.delete(id);
  }
}
