// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';

import type { FilesIdentity } from '../auth.js';
import type { TransactionRunner } from '../FilesTransaction.js';
import type { FilesAccessGate, RequestWithIdentity } from '../Http/FilesAccessGate.js';
import { FilesRequestInput } from '../Http/FilesRequestInput.js';
import { HttpError } from '../Http/HttpError.js';
import { assertUnprotectedFile } from '../protectedFiles.js';
import type { RemoteVersionRepository } from '../Repositories/RemoteVersionRepository.js';
import type { Store } from '../store.js';
import { assertStoredFilePath, ensureStoredFileParents, lockStoredNamespace } from '../storedNamespace.js';
import type { RemoteVersionBundleValidator } from './RemoteVersionBundleValidator.js';

export interface RemoteVersionPreparation { existing:any; path:string; missing:string[]; conflict:boolean; currentVersionId:string | null; canonicalFileId:string }
export interface RemoteVersionOutcome { status:number; body:Record<string, unknown> }

/** Prepares and commits a version that a remote device already encrypted and chunked. */
export class RemoteVersionSync {
  constructor(
    private readonly db:pg.Pool,
    private readonly store:Store,
    private readonly access:FilesAccessGate,
    private readonly transactions:TransactionRunner,
    private readonly versions:RemoteVersionRepository,
    private readonly validator:RemoteVersionBundleValidator,
    private readonly actorScope:(actor:FilesIdentity) => string,
  ) {}

  /** Authorizes the bundle's destination and reports which chunks the store still lacks and whether the base is stale. */
  async prepare(request:RequestWithIdentity, bundle:any, queryable:pg.Pool | pg.PoolClient = this.db, lock = false, authorizeChunks = false):Promise<RemoteVersionPreparation> {
    const { identity, requireCollection, requireFile, requirePath } = this.access;
    const chunkMetadata = this.validator.chunkMetadata(bundle);
    const path = FilesRequestInput.cleanPath(bundle.file.path, false);
    if (await this.versions.isPurged(queryable, bundle.file.id)) throw new HttpError(410, 'file was permanently purged; create a new file identity to restore content');
    const candidates = await this.versions.candidates(queryable, bundle.file.id, bundle.collectionId, path, lock);
    const requested = candidates.find(file => file.id === bundle.file.id);
    const destination = candidates.find(file => file.collection_id === bundle.collectionId && file.path === path);

    if (requested && requested.collection_id !== bundle.collectionId) throw new HttpError(403, 'file belongs to another collection');
    if (requested && destination && requested.id !== destination.id) throw new HttpError(409, 'another file already exists at the requested path');
    for (const file of candidates) await assertUnprotectedFile(queryable, file);
    let exactFileEdit = false;
    try { await requirePath(request, bundle.collectionId, path, 'edit',queryable) } catch (error:any) {
      if (error.status !== 403 || requested?.path !== path) throw error;
      await requireFile(request, requested.id, 'edit',queryable); exactFileEdit = true;
    }
    for (const file of candidates) {
      if (exactFileEdit && file.id === requested.id) continue;
      await requirePath(request, file.collection_id, file.path, 'edit',queryable);
    }
    if (bundle.version.chunk_collection_id !== bundle.collectionId) await requireCollection(request, bundle.version.chunk_collection_id, 'edit',false,false,queryable);
    if (bundle.keyContext) FilesRequestInput.validateKeyContext(bundle.keyContext, bundle.version.chunk_collection_id, identity(request).userId);
    const existing = requested ?? destination;
    const scopedEdit = false;
    const manifestChunkIds = [...new Set<string>(bundle.manifest?.chunk_ids ?? [])];
    const missing:string[] = [];
    for (const id of manifestChunkIds) if ((scopedEdit && authorizeChunks) || !await this.store.has(bundle.version.chunk_collection_id, id)) missing.push(id);
    if (scopedEdit && manifestChunkIds.length) {
      const actor = identity(request); const scope = this.actorScope(actor);
      if (authorizeChunks) {
        await this.versions.clearChunkUploadIntents(queryable, bundle.version.id, actor.userId, scope);
        for (const chunkId of manifestChunkIds) {
          const chunk = chunkMetadata.get(chunkId)!;
          await this.versions.upsertChunkUploadIntent(queryable, { fileId: bundle.file.id, targetCollectionId: bundle.collectionId, filePath: path, versionId: bundle.version.id, chunkCollectionId: bundle.version.chunk_collection_id, chunkId, principalId: actor.userId, actorScope: scope, plainSize: chunk.size });
        }
      } else if (!await this.versions.versionExists(queryable, bundle.version.id)) {
        const uploadedIds = await this.versions.uploadedChunkIds(queryable, bundle.version.id, actor.userId, scope);
        if (manifestChunkIds.some(id => !uploadedIds.has(id))) throw new HttpError(403, 'scoped upload intent is missing or incomplete');
      }
    }
    const base = bundle.baseServerVersionId ?? null;
    const conflict = Boolean(existing?.current_version_id && existing.current_version_id !== base);

    return { existing, path, missing, conflict, currentVersionId: existing?.current_version_id ?? null, canonicalFileId: existing?.id ?? bundle.file.id };
  }

  /** Commits the bundle in one transaction: idempotent for an identical replay, 409 on changed geometry or a stale base. */
  async commit(request:RequestWithIdentity, bundle:any):Promise<RemoteVersionOutcome> {
    const actor = this.access.identity(request);
    return this.transactions.run('remote-version-commit', async client => {
      const bundlePath = FilesRequestInput.cleanPath(bundle.file.path, false);
      await lockStoredNamespace(client, bundle.collectionId);
      await this.versions.lockCommitPath(client, bundle.collectionId, bundlePath);
      const checked = await this.prepare(request, bundle, client, true);
      if (checked.missing.length) return { status: 400, body: { error: 'manifest chunks missing', missing: checked.missing } };
      const fileId = checked.canonicalFileId;
      const prior = await this.versions.priorVersion(client, bundle.version.id);
      if (prior) {
        const sameGeometry = prior.file_id === fileId && prior.chunk_collection_id === bundle.version.chunk_collection_id &&
          prior.manifest_hash === (bundle.manifest?.hash ?? null) && Number(prior.size) === Number(bundle.version.size) &&
          Boolean(prior.deleted) === Boolean(bundle.version.deleted);
        if (!sameGeometry || checked.currentVersionId !== bundle.version.id) throw new HttpError(409, 'immutable remote version geometry does not match the requested version');
        const storedContext = await this.versions.keyContext(client, bundle.version.id);
        if (Boolean(storedContext) !== Boolean(bundle.keyContext)) throw new HttpError(409, 'immutable version key context does not match the committed version');
        if (bundle.keyContext) {
          const context = FilesRequestInput.validateKeyContext(bundle.keyContext, bundle.version.chunk_collection_id, actor.userId);
          if (storedContext?.collection_id !== context.collectionId || storedContext.principal_id !== context.principalId ||
              Number(storedContext.key_version) !== context.keyVersion || Number(storedContext.key_epoch) !== context.epoch) {
            throw new HttpError(409, 'immutable version key context does not match the committed version');
          }
        }
        return { status: 200, body: { ok: true, versionId: bundle.version.id, fileId } };
      }
      if (checked.conflict) return { status: 409, body: { conflict: true, currentVersionId: checked.currentVersionId } };
      await assertStoredFilePath(client, bundle.collectionId, checked.path, fileId);
      await ensureStoredFileParents(client, bundle.collectionId, checked.path, actor);
      if (bundle.manifest) {
        const storedManifest = await this.versions.storeManifest(client, bundle.manifest);
        if (!storedManifest || JSON.stringify(storedManifest.chunk_ids) !== JSON.stringify(bundle.manifest.chunk_ids) || Number(storedManifest.total_size) !== Number(bundle.manifest.total_size)) throw new HttpError(409, 'immutable manifest metadata does not match the requested version');
      }
      for (const chunk of bundle.chunks ?? []) await this.versions.referenceChunk(client, bundle.version.chunk_collection_id, chunk);
      const authenticatedCreatorType = actor.agentId || actor.jobId ? 'agent-run' : 'user'; const authenticatedCreatorId = actor.jobId ?? actor.agentId ?? actor.userId;
      await this.versions.upsertFile(client, { id: fileId, collectionId: bundle.collectionId, path: checked.path, createdByType: authenticatedCreatorType, createdById: authenticatedCreatorId, mime: bundle.file.mime, size: bundle.file.size, deletedAt: bundle.version.deleted ? new Date() : null });
      await this.versions.upsertSearchText(client, fileId, checked.path, bundle.file.search_text);
      await this.versions.insertVersion(client, [bundle.version.id, fileId, bundle.version.chunk_collection_id, checked.currentVersionId, bundle.manifest?.hash ?? null, bundle.version.size, bundle.version.deleted, actor.agentId || actor.jobId ? 'agent-run' : 'user', actor.jobId ?? actor.agentId ?? actor.userId, bundle.version.message, actor.deviceId, checked.currentVersionId]);
      if (bundle.keyContext) {
        const context = FilesRequestInput.validateKeyContext(bundle.keyContext, bundle.version.chunk_collection_id, actor.userId);
        await this.versions.insertKeyContext(client, bundle.version.id, context);
      }
      if (!await this.versions.advanceHead(client, fileId, bundle.version.id, bundle.version.deleted ? new Date() : null, checked.currentVersionId)) throw new HttpError(409, 'file changed while committing the remote version');
      await this.versions.journal(client, bundle.collectionId, fileId, bundle.version.id, bundle.version.deleted ? 'delete' : 'put');
      await this.versions.deleteChunkUploadIntents(client, bundle.version.id, actor.userId, this.actorScope(actor));
      return { status: 200, body: { ok: true, versionId: bundle.version.id, fileId } };
    });
  }
}
