// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';

import type { FilesIdentity } from '../auth.js';
import type { Config } from '../config.js';
import { chunkId } from '../crypto.js';
import type { FilesAccessGate } from '../Http/FilesAccessGate.js';
import { HttpError } from '../Http/HttpError.js';
import type { ManifestChunkRegistry } from '../ManifestChunkRegistry.js';
import { resolveMime } from '../mimeTypes.js';
import { PublicationLifecyclePolicy } from '../publicationLifecyclePolicy.js';
import type { VersionWriteRepository } from '../Repositories/VersionWriteRepository.js';
import type { Store } from '../store.js';
import { assertStoredFilePath, ensureStoredFileParents } from '../storedNamespace.js';
import { VERSION_CHUNK_BYTES, type StagedVersionContent, type VersionContentStager } from '../VersionContentStager.js';

/** One version write: the bytes were staged (encrypted, durable) before the caller's transaction opened. */
export interface VersionWriteInput {
  collectionId:string;
  fileId?:string;
  createFileId?:boolean;
  versionId?:string;
  path:string;
  mime:string;
  bytes:Buffer;
  actor:FilesIdentity;
  createdByType?:string;
  createdById?:string;
  message:string;
  baseVersionId?:string | null;
  staged:StagedVersionContent;
}

/**
 * Writes a file version (moved from app.ts insertVersion/stageVersionContent/manifestHashFor).
 * Stage the content with stage() BEFORE opening the transaction, then insert() inside it. The
 * chunk-integrity guards (ManifestChunkRegistry, the post-insert blob check) run in the same order.
 */
export class VersionWriter {
  constructor(
    private readonly config:Config,
    private readonly access:FilesAccessGate,
    private readonly store:Store,
    private readonly stager:VersionContentStager,
    private readonly chunkRegistry:ManifestChunkRegistry,
    private readonly versions:VersionWriteRepository,
  ) {}

  /** Encrypts and durably writes a version's chunks. Call this before opening the transaction that commits it. */
  readonly stage = (collectionId:string, bytes:Buffer):Promise<StagedVersionContent> => this.stager.stage(collectionId, bytes);

  /** The manifest hash insert() would store for these bytes (keyed chunk ids; nothing is written). */
  readonly manifestHashFor = async(collectionId:string, bytes:Buffer):Promise<string> => {
    const { dedup: dedupKey } = await this.config.keyring!.keys(collectionId); const chunkIds:string[] = [];
    for (let offset = 0; offset < Math.max(1, bytes.length); offset += VERSION_CHUNK_BYTES) chunkIds.push(chunkId(bytes.subarray(offset, Math.min(bytes.length, offset + VERSION_CHUNK_BYTES)), dedupKey));
    return createHash('sha256').update(JSON.stringify({ ids: chunkIds, size: bytes.length })).digest('hex');
  };

  readonly insert = async(client:pg.PoolClient, input:VersionWriteInput):Promise<any> => {
    input = { ...input, mime: resolveMime(input.path, input.mime) };
    const agentWrite = input.createdByType === 'agent-run' || input.createdByType === 'agent' || Boolean(input.actor.agentId || input.actor.jobId || input.actor.threadId);
    const collection = await this.access.collectionRow(input.collectionId, client);
    const createdByType = input.actor.agentId ? 'agent' : agentWrite ? 'agent-run' : (input.createdByType ?? 'user');
    const createdById = input.createdById ?? input.actor.jobId ?? input.actor.agentId ?? input.actor.userId;
    const publicationStatus = new PublicationLifecyclePolicy().statusForWrite({ collection, path: input.path, createdByType });
    await assertStoredFilePath(client, input.collectionId, input.path, input.fileId);
    await ensureStoredFileParents(client, input.collectionId, input.path, input.actor);
    // Every writer must stage before entering its metadata transaction. Never add a fallback here.
    const staged = input.staged;
    if (staged.collectionId !== input.collectionId || staged.size !== input.bytes.length) throw new Error('staged content does not match the version being written');
    const chunkIds = [...staged.chunkIds]; const chunks = staged.chunks; const manifestHash = staged.manifestHash;
    await this.versions.recordManifest(client, manifestHash, chunkIds, input.bytes.length);
    for (const chunk of chunks) await this.versions.recordChunk(client, input.collectionId, chunk);
    // Residency is derived from the durable chunk/version record and staged blob; couple its
    // bookkeeping to this version commit instead of issuing one autocommit per chunk.
    for (const chunk of chunks) await this.store.recordResident(client, input.collectionId, chunk.id, chunk.storedSize);
    await this.chunkRegistry.assertRegistered(client, input.collectionId, chunkIds);
    let file:any;
    if (input.fileId) {
      file = await this.versions.lockFile(client, input.fileId);
      if (!file && input.createFileId) {
        file = await this.versions.createFileWithId(client, input.fileId, input.collectionId, input.path, createdByType, createdById, input.mime, input.bytes.length);
      } else {
        if (file?.collection_id !== input.collectionId) throw new HttpError(404, 'file not found');
        await this.versions.reviveFile(client, file.id, input.path, input.mime, input.bytes.length);
      }
    } else file = await this.versions.createFile(client, input.collectionId, input.path, createdByType, createdById, input.mime, input.bytes.length);
    const parent = input.baseVersionId === undefined ? file.current_version_id : input.baseVersionId;
    const version = await this.versions.insertVersion(client, { id: input.versionId ?? randomUUID(), fileId: file.id, collectionId: input.collectionId, parentVersionId: parent, manifestHash,
      size: input.bytes.length, createdByType, createdById, message: input.message, deviceId: input.actor.jobId || input.actor.deviceId || this.config.deviceId, publicationStatus });
    await this.versions.setCurrentVersion(client, file.id, version.id);
    if (version.publication_status === 'draft') await this.versions.auditDraftWrite(client, agentWrite ? 'agent-or-device' : 'user', createdById, input.actor.deviceId || null, file.id, version.id, { path: input.path, message: input.message });
    await this.versions.referenceChunks(client, input.collectionId, chunkIds);
    // Chunk GC takes a table lock on file_versions, so once the version row above is in, no GC that
    // could still delete these chunks is running. One that finished between staging and now could
    // have reclaimed a deduplicated chunk: check the blobs (one synchronous local lstat each, so
    // the open transaction never queues behind other writers' fsyncs) before committing.
    for (const chunk of chunks) if (!this.store.presentNow(input.collectionId, chunk.id)) throw Object.assign(new HttpError(503, 'Files storage changed while saving; retry the request'), { code: 'FILES_DB_RETRYABLE' });
    await this.versions.journalPut(client, input.collectionId, file.id, version.id);
    return { ...file, current_version_id: version.id, size: input.bytes.length, path: input.path, mime: input.mime, publication_status: version.publication_status };
  };
}
