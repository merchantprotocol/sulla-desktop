// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

import { TransactionRunner } from './FilesTransaction.js';
import { ManifestChunkRegistry } from './ManifestChunkRegistry.js';
import { WatchedFolderRepository, type WatchedRow } from './Repositories/WatchedFolderRepository.js';
import { TrackedPathFilter } from './TrackedPathFilter.js';
import { chunkId, encryptChunk } from './crypto.js';
import { mimeForPath as mime } from './mimeTypes.js';
import { assertStoredFilePath, ensureStoredFileParents, lockStoredNamespace } from './storedNamespace.js';

import type { Config, FileRootConfig } from './config.js';
import type { IndexingQueue } from './indexing.js';
import type { Store } from './store.js';
import type pg from 'pg';

const CHUNK_BYTES = 4 * 1024 * 1024;

/**
 * Turns one changed file in a native tracked root into a Files version (or a rename / no-op), and
 * a vanished one into a Trash version. Chunks are encrypted and stored before the short metadata
 * transaction; every manifest chunk is registered inside it (#2356 integrity guard).
 */
export class WatchedFileIngestor {
  constructor(
    private readonly db:pg.Pool,
    private readonly config:Config,
    private readonly store:Store,
    private readonly indexer?:IndexingQueue,
    private readonly repository = new WatchedFolderRepository(db),
    private readonly chunkRegistry = new ManifestChunkRegistry(),
    private readonly transactions = new TransactionRunner(db),
    private readonly onVersionCommitted?:(collectionId:string)=>void,
  ) {}

  /**
   * Every chunk of an ingested version is recorded for the commit, including one whose blob is
   * already on disk: a blob left by an earlier attempt that rolled back has no `chunks` row, and
   * skipping it here would commit a version that can never be read.
   */
  async stageChunk(collectionId:string, id:string, plain:Buffer, dataKey:Uint8Array):Promise<{ id:string; size:number; storedSize:number }> {
    const existing = await this.store.storedSize(collectionId, id);
    if (existing !== undefined) return { id, size: plain.length, storedSize: existing };
    const encrypted = await encryptChunk(plain, dataKey, id);
    await this.store.put(collectionId, id, encrypted);
    return { id, size: plain.length, storedSize: encrypted.length };
  }

  /** Returns true when a new version was committed. */
  async ingest(root:FileRootConfig, collectionId:string, filePath:string, mtimeMs:number, old:WatchedRow | undefined, missing:Map<string, WatchedRow>):Promise<boolean> {
    const keys = await this.config.keyring!.keys(collectionId); const whole = createHash('sha256'); const ids:string[] = []; const chunks:{ id:string; size:number; storedSize:number }[] = []; let total = 0;
    for await (const part of createReadStream(TrackedPathFilter.inside(root, filePath), { highWaterMark: CHUNK_BYTES })) { const plain = Buffer.from(part); total += plain.length; whole.update(plain); const id = chunkId(plain, keys.dedup); ids.push(id); chunks.push(await this.stageChunk(collectionId, id, plain, keys.data)) }
    if (total === 0) { const empty = Buffer.alloc(0); const id = chunkId(empty, keys.dedup); ids.push(id); chunks.push(await this.stageChunk(collectionId, id, empty, keys.data)) }
    const contentHash = whole.digest('hex'); if (old?.content_hash === contentHash) { await this.repository.refreshStat(collectionId, filePath, total, mtimeMs); return false }
    const renameFrom = !old ? missing.get(contentHash) : undefined; const manifestHash = createHash('sha256').update(JSON.stringify({ ids, size: total })).digest('hex');
    const existing = !old && !renameFrom ? await this.repository.fileAtPath(collectionId, filePath) : undefined;
    if (existing && !existing.deleted_at && existing.manifest_hash === manifestHash) {
      await this.repository.upsertState(this.db, { collectionId, path: filePath, fileId: existing.id, contentHash, size: total, mtimeMs, rootId: root.id });
      return false;
    }
    const { fileId, versionId } = await this.transactions.run('watched-file-ingest', async client => {
      await lockStoredNamespace(client, collectionId);
      await this.repository.insertManifest(client, manifestHash, ids, total);
      for (const chunk of chunks) await this.repository.registerChunk(client, collectionId, chunk);
      await this.chunkRegistry.assertRegistered(client, collectionId, ids);
      let fileId = old?.file_id ?? renameFrom?.file_id ?? existing?.id; let parent:string | null = null;
      await assertStoredFilePath(client, collectionId, filePath, fileId);
      if (fileId) { const file = await this.repository.lockCurrentVersion(client, fileId); parent = file!.current_version_id; await this.repository.reopenForNewContent(client, fileId, filePath, mime(filePath), total) } else fileId = await this.repository.createFile(client, collectionId, filePath, this.config.userId, mime(filePath), total);
      await ensureStoredFileParents(client, collectionId, filePath, { userId: this.config.userId, deviceId: this.config.deviceId, kind: 'capability' });
      const versionId = await this.repository.createVersion(client, { fileId, collectionId, parent, manifestHash, size: total, userId: this.config.userId,
        message: renameFrom ? `Renamed ${ renameFrom.path } to ${ filePath }` : 'Watched folder change', deviceId: this.config.deviceId });
      await this.repository.activateVersion(client, fileId, versionId, collectionId, ids);
      await this.repository.appendJournal(client, collectionId, fileId, versionId, renameFrom ? 'rename' : 'put');
      if (renameFrom) await this.repository.deleteState(client, collectionId, renameFrom.path);
      await this.repository.upsertState(client, { collectionId, path: filePath, fileId, contentHash, size: total, mtimeMs, rootId: root.id });
      return { fileId, versionId };
    });
    this.indexer?.wake(); this.onVersionCommitted?.(collectionId); if (renameFrom) missing.delete(contentHash);
    if (root.primary && filePath.startsWith('Recordings/') && mime(filePath).startsWith('video/') && !/-(?:camera|mic|system-audio)\.[^/]+$/i.test(filePath)) {
      await this.repository.queueRecordingEnrichment(fileId, versionId).catch(error => console.warn('[SullaFiles] recording enrichment hook unavailable:', error));
    }
    return true;
  }

  /** The file left the tracked root: record a Trash version and forget its watched custody. */
  async softDelete(row:WatchedRow):Promise<void> {
    await this.transactions.run('watched-file-trash', async client => {
      const file = await this.repository.lockCurrentVersion(client, row.file_id); if (!file) return;
      const versionId = await this.repository.createDeleteVersion(client, row, file.current_version_id, this.config.userId, this.config.deviceId);
      await this.repository.trashFile(client, row, versionId);
    });
  }
}
