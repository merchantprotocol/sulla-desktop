// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rename, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

import { TrackedPathFilter } from './TrackedPathFilter.js';

import type { Config, FileRootConfig } from './config.js';
import type { TransactionRunner } from './FilesTransaction.js';
import type { RemoteFilesClient } from './RemoteFilesClient.js';
import type { ReplicationPuller } from './ReplicationPuller.js';
import type { CollectionPolicyRepository } from './Repositories/CollectionPolicyRepository.js';
import type { LegacySyncRepository } from './Repositories/LegacySyncRepository.js';
import type { ScanProgress } from './ScanProgress.js';
import type { Store } from './store.js';
import type pg from 'pg';

/** What the sync loop reads from the manager on every pass (both can change at runtime). */
export interface LegacySyncHost {
  homeCollectionId():string | undefined;
  rootFor(collectionId:string):FileRootConfig;
}

/**
 * The legacy server sync loop for `syncMode: 'server'` roots: publish local collections, pull the
 * server journal (quarantining entries for collections this device doesn't have), then push local
 * versions. A server-side conflict keeps the local bytes as a visible conflicted copy.
 */
export class LegacyFolderSync {
  constructor(
    private readonly db:pg.Pool,
    private readonly config:Config,
    private readonly store:Store,
    private readonly roots:FileRootConfig[],
    private readonly rootCollections:Map<string, string>,
    private readonly progress:ScanProgress,
    private readonly remote:RemoteFilesClient,
    private readonly repository:LegacySyncRepository,
    private readonly puller:ReplicationPuller,
    private readonly transactions:TransactionRunner,
    private readonly collectionPolicyRepository:CollectionPolicyRepository,
    private readonly host:LegacySyncHost,
  ) {}

  async syncNow():Promise<void> {
    if (!this.config.serverUrl) return;
    const syncRoots = this.roots.filter(root => !root.paused && root.syncMode === 'server');
    if (!syncRoots.length) return;
    await this.repository.markRuntimeSyncing();
    for (const root of syncRoots) {
      const collectionId = this.rootCollections.get(root.id)!;
      await this.config.keyring!.requireLegacySync(collectionId);
      await this.repository.markRootSyncing(root.id);
      const collection = await this.repository.collection(collectionId);
      await this.remote.json('/v1/collections', { method: 'POST', body: JSON.stringify({ collection }) });
    }
    const remoteCollections:any[] = await this.remote.json('/v1/collections');
    for (const remote of remoteCollections.filter(remote=>!remote.systemArea)) await this.config.keyring!.requireLegacySync(remote.id);
    for (const remote of remoteCollections.filter(remote=>!remote.systemArea)) {
      if (remote.id !== this.host.homeCollectionId()) await this.repository.upsertRemoteCollection(remote);
      await this.syncCollection(remote.id, true);
    }
    this.progress.pendingFiles = 0; this.progress.lastSyncAt = new Date().toISOString();
    await this.repository.markSynced(syncRoots.map(root => root.id));
  }

  private async syncCollection(collectionId:string, canPush:boolean):Promise<void> {
    let cursor = await this.repository.cursor(collectionId, this.config.deviceId);
    const entries = await this.remote.json(`/v1/collections/${ collectionId }/journal?after=${ cursor.last_seq }`);
    for (const entry of entries) {
      const entryCollectionId=String(entry?.file?.collection_id??'');
      const localCollection=await this.collectionPolicyRepository.findPublicationPolicy(this.db,entryCollectionId);
      if (!localCollection) {
        console.warn(`[SullaFiles] quarantined sync journal entry ${ String(entry?.seq??'unknown') } (file ${ String(entry?.file?.id??'unknown') }) for missing local collection ${ entryCollectionId||'unknown' }`);
      } else await this.puller.pull(entry);
      await this.repository.advancePull(collectionId, this.config.deviceId, entry.seq);
    }
    cursor = await this.repository.readCursor(collectionId, this.config.deviceId);
    if (canPush) {
      const pending = await this.repository.unpushed(collectionId, cursor.last_push_seq, this.config.deviceId);
      this.progress.pendingFiles += pending.length;
      for (const item of pending) { await this.push(item, collectionId); await this.repository.advancePush(collectionId, this.config.deviceId, item.seq) }
    }
  }

  private async push(item:any, collectionId = item.file.collection_id):Promise<void> {
    if (item.op === 'lifecycle') {
      await this.remote.json(`/v1/files/${ item.file.id }/lifecycle-state`, { method: 'PATCH', body: JSON.stringify({ file: item.file }) });
      return;
    }
    const chunks = item.manifest ? await this.repository.chunks(item.version.chunk_collection_id, item.manifest.chunk_ids) : [];
    const payload = { collectionId, file: item.file, version: item.version, manifest: item.manifest, chunks, baseServerVersionId: item.version.base_server_version_id ?? item.version.parent_version_id };
    const prep = await this.remote.json('/v1/versions/prepare', { method: 'POST', body: JSON.stringify(payload) });
    if (prep.conflict) { await this.keepConflict(item, prep.currentVersionId); return }
    for (const id of prep.missing ?? []) await this.remote.putChunk(item.version.chunk_collection_id, id, await this.store.get(item.version.chunk_collection_id, id));
    await this.remote.json('/v1/versions/commit', { method: 'POST', body: JSON.stringify(payload) }); await this.repository.markServerBase(item.version.id);
  }

  /** The server moved on: rename the local file to a conflicted copy, push it, then pull the server's version. */
  private async keepConflict(item:any, remoteVersionId:string):Promise<void> {
    const collectionId = item.file.collection_id;
    const root = this.host.rootFor(collectionId);
    const nextPath = TrackedPathFilter.conflictPath(item.file.path, this.config.deviceId); const source = TrackedPathFilter.inside(root, item.file.path); const target = TrackedPathFilter.inside(root, nextPath); await mkdir(dirname(target), { recursive: true }); await rename(source, target);
    const fileId = randomUUID(); const versionId = randomUUID(); const info = await stat(target); const hash = createHash('sha256'); for await (const part of createReadStream(target)) hash.update(part);
    await this.transactions.run('legacy-sync-conflict', client => this.repository.recordConflictCopy(client, item, {
      fileId, versionId, collectionId, path: nextPath, deviceId: this.config.deviceId, contentHash: hash.digest('hex'), size: info.size, mtimeMs: info.mtimeMs, rootId: root.id }));
    const conflict = { ...item, file: { ...item.file, id: fileId, path: nextPath }, version: { ...item.version, id: versionId, file_id: fileId, parent_version_id: null, base_server_version_id: null, message: `Conflict copy of ${ item.file.path }` } };
    await this.push(conflict); const bundle = await this.remote.json(`/v1/versions/${ remoteVersionId }`); await this.puller.pull({ ...bundle, seq: 0 });
  }
}
