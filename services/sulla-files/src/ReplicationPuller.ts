// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, stat } from 'node:fs/promises';
import { basename, dirname } from 'node:path';

import { TransactionControlRepository } from './Repositories/TransactionControlRepository.js';
import { TrackedPathFilter } from './TrackedPathFilter.js';
import { decryptChunk } from './crypto.js';

import type { Config, FileRootConfig } from './config.js';
import type { TransactionRunner } from './FilesTransaction.js';
import type { IndexingQueue } from './indexing.js';
import type { PublicationLifecyclePolicy } from './publicationLifecyclePolicy.js';
import type { RemoteFilesClient } from './RemoteFilesClient.js';
import type { RemotePurgeApplier } from './RemotePurgeApplier.js';
import type { CollectionPolicyRepository } from './Repositories/CollectionPolicyRepository.js';
import type { ReplicationRepository } from './Repositories/ReplicationRepository.js';
import type { Store } from './store.js';
import type pg from 'pg';

/**
 * Applies one pulled journal entry to this device: purge (delegated), lifecycle state, remote
 * delete (bytes moved to .sulla-trash), or a new version materialized into the tracked root.
 */
export class ReplicationPuller {
  constructor(
    private readonly db:pg.Pool,
    private readonly config:Config,
    private readonly store:Store,
    private readonly remote:RemoteFilesClient,
    private readonly repository:ReplicationRepository,
    private readonly purges:RemotePurgeApplier,
    private readonly transactions:TransactionRunner,
    private readonly collectionPolicyRepository:CollectionPolicyRepository,
    private readonly publicationLifecyclePolicy:PublicationLifecyclePolicy,
    private readonly rootFor:(collectionId:string)=>FileRootConfig,
    private readonly indexer?:IndexingQueue,
    private readonly control = new TransactionControlRepository(),
  ) {}

  async pull(entry:any):Promise<void> {
    const collectionId = entry.file.collection_id;
    if (entry.op === 'purge') return this.purges.apply(entry);
    if (entry.op === 'lifecycle') {
      if (!entry.file.path) return;
      await this.transactions.run('replication-lifecycle', async client => {
        await this.repository.trustReplication(client);
        await this.repository.applyLifecycle(client, entry, collectionId);
      });
      return;
    }
    if (entry.version?.device_id === this.config.deviceId) return;
    if (entry.syncAuthority?.canMaterialize !== true) return;
    const root = this.rootFor(collectionId);
    if (entry.version.deleted) {
      const existing = await this.repository.filePath(entry.file.id);
      if (existing) {
        const source = TrackedPathFilter.inside(root, existing.path); const trash = TrackedPathFilter.inside(root, `.sulla-trash/${ entry.file.id }/${ Date.now() }-${ basename(existing.path) }`);
        try { await mkdir(dirname(trash), { recursive: true }); await rename(source, trash) } catch (error:any) { if (error?.code !== 'ENOENT') throw error; }
        await this.transactions.run('replication-delete', async client => {
          await this.repository.trustReplication(client);
          await this.repository.applyDelete(client, entry, collectionId);
        });
      }
      return;
    }
    await this.applyVersion(entry, collectionId, root);
  }

  /**
   * The bytes are materialized while the file row is locked, so this transaction deliberately
   * spans filesystem and chunk-download work (unchanged legacy behaviour); it is controlled by
   * hand rather than through TransactionRunner, whose scope guard forbids that.
   */
  private async applyVersion(entry:any, collectionId:string, root:FileRootConfig):Promise<void> {
    const client = await this.db.connect(); await this.control.begin(client);
    try {
      await this.repository.trustReplication(client);
      const prior = await this.repository.lockPrior(client, entry.file.id);
      if (prior?.current_version_id && prior.record_lock_type !== 'none' && Number(entry.file.lifecycle_generation ?? 0) <= Number(prior.lifecycle_generation)) { await this.control.rollback(client); return }
      if (prior?.path && prior.path !== entry.file.path) {
        try { await mkdir(dirname(TrackedPathFilter.inside(root, entry.file.path)), { recursive: true }); await rename(TrackedPathFilter.inside(root, prior.path), TrackedPathFilter.inside(root, entry.file.path)) } catch (error:any) { if (error?.code !== 'ENOENT') throw error; }
      }
      await this.materialize(entry);
      const info = await stat(TrackedPathFilter.inside(root, entry.file.path)); const hash = createHash('sha256');
      for await (const part of createReadStream(TrackedPathFilter.inside(root, entry.file.path))) hash.update(part);
      await this.repository.insertManifest(client, entry.manifest);
      await this.repository.upsertFile(client, entry, collectionId);
      const collection = entry.collection ?? await this.collectionPolicyRepository.findPublicationPolicy(client, collectionId);
      if (!collection) throw new Error(`Replication collection ${ collectionId } is unavailable`);
      const replicatedLifecycle = this.publicationLifecyclePolicy.sanitizeReplication({
        collection, path:entry.file.path, createdByType:entry.version.created_by_type,
        lifecycle:{ publication_status:entry.version.publication_status ?? 'draft', published_at:entry.version.published_at ?? null, published_by:entry.version.published_by ?? null },
      });
      await this.repository.upsertVersion(client, entry, replicatedLifecycle);
      await this.repository.activateVersion(client, entry.file.id, entry.version.id, replicatedLifecycle.publication_status ?? 'draft');
      await this.repository.upsertWatchedState(client, { collectionId, path: entry.file.path, fileId: entry.file.id, contentHash: hash.digest('hex'), size: info.size, mtimeMs: info.mtimeMs, rootId: root.id });
      await this.control.commit(client); this.indexer?.wake();
    } catch (error) { await this.control.rollback(client); throw error } finally { client.release() }
  }

  /** Decrypt the version's chunks (local store first, then the server) into a temp file and rename it into place. */
  async materialize(bundle:any):Promise<void> {
    const root = this.rootFor(bundle.file.collection_id);
    const keys = await this.config.keyring!.keys(bundle.version.chunk_collection_id); const target = TrackedPathFilter.inside(root, bundle.file.path); await mkdir(dirname(target), { recursive: true }); const temp = `${ target }.sulla-conflict-${ randomUUID() }`; const output = createWriteStream(temp, { mode: 0o600 });
    let lastId:string | undefined; let lastPlain:Buffer | undefined;
    try {
      for (const id of bundle.manifest.chunk_ids) {
        let plain:Buffer;
        if (id === lastId && lastPlain) plain = lastPlain;
        else {
          let encrypted:Uint8Array;
          if (await this.store.has(bundle.version.chunk_collection_id, id)) encrypted = await this.store.get(bundle.version.chunk_collection_id, id);
          else { encrypted = await this.remote.getChunk(bundle.version.chunk_collection_id, id); await this.store.put(bundle.version.chunk_collection_id, id, encrypted) }
          plain = await decryptChunk(encrypted, keys.data, id); lastId = id; lastPlain = plain;
        }
        if (!output.write(plain)) await new Promise<void>(resolve => output.once('drain', () => resolve()));
      }
      output.end(); await new Promise<void>((resolve, reject) => { output.once('finish', resolve); output.once('error', reject) }); await rename(temp, target);
    } catch (error) { output.destroy(); throw error }
  }
}
