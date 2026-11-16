// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import express from 'express';

import type { FilesIdentity } from '../auth.js';
import type { Config } from '../config.js';
import { decryptAndVerifyChunk } from '../crypto.js';
import type { FilesAccessGate, RequestWithIdentity } from '../Http/FilesAccessGate.js';
import { HttpError } from '../Http/HttpError.js';
import { protectedPathError } from '../protectedFiles.js';
import type { ChunkAccessRepository } from '../Repositories/ChunkAccessRepository.js';
import type { Store } from '../store.js';

/** What a chunk write was authorized by: collection edit rights, or scoped upload intents from version prepare. */
interface ChunkWriteAuthorization { scoped:boolean; plainSize?:number; versionIds?:string[] }

/** /v1/chunks/:collection/:id: encrypted chunk reads and writes behind file/collection authorization. */
export class ChunkRoutes {
  constructor(
    private readonly config:Config,
    private readonly store:Store,
    private readonly access:FilesAccessGate,
    private readonly chunks:ChunkAccessRepository,
    private readonly actorScope:(actor:FilesIdentity) => string,
  ) {}

  register(app:express.Express):void {
    app.use('/v1/chunks/:collection/:id', async(request, _response, next) => {
      try {
        if (await this.chunks.isProtected(request.params.collection, request.params.id)) throw protectedPathError();
        next();
      } catch (error) { next(error) }
    });
    app.get('/v1/chunks/:collection/:id', async(request:RequestWithIdentity, response, next) => { try { await this.requireRead(request, request.params.collection, request.params.id); response.type('application/octet-stream').send(await this.store.get(request.params.collection, request.params.id)) } catch (error) { next(error) } });
    app.put('/v1/chunks/:collection/:id', express.raw({ type: 'application/octet-stream', limit: '8mb' }), async(request:RequestWithIdentity, response, next) => { try { const authorization = await this.requireWrite(request, request.params.collection, request.params.id); if (authorization.scoped) { const keys = await this.config.keyring!.keys(request.params.collection); await decryptAndVerifyChunk(request.body as Buffer, keys.data, keys.dedup, request.params.id, authorization.plainSize!); } await this.store.put(request.params.collection, request.params.id, request.body as Buffer); if (authorization.scoped) { const actor = this.access.identity(request); await this.chunks.markUploaded(authorization.versionIds, request.params.id, actor.userId, this.actorScope(actor)); } response.sendStatus(204) } catch (error) { next(error) } });
  }

  private async requireRead(request:RequestWithIdentity, collectionId:string, chunkId:string):Promise<void> {
    const files = await this.chunks.referencingFiles(collectionId, chunkId);
    for (const file of files) {
      try { const authorized = await this.access.requireFile(request, file.id, 'view'); await this.access.visibleVersion(request, authorized, file.version_id); return } catch { /* Check every file/version that references this deduplicated chunk. */ }
    }
    throw new HttpError(403, 'access denied');
  }

  private async requireWrite(request:RequestWithIdentity, collectionId:string, chunkId:string):Promise<ChunkWriteAuthorization> {
    try { await this.access.requireCollection(request, collectionId, 'edit'); return { scoped: false } } catch (error:any) { if (error.status !== 403) throw error }
    const actor = this.access.identity(request);
    const scope = this.actorScope(actor);
    const upload = await this.chunks.uploadIntents(collectionId, chunkId, actor.userId, scope);
    const authorized:{ plainSize: number; versionId: string }[] = [];
    for (const intent of upload) {
      try {
        const file = await this.access.requireFile(request, intent.file_id, 'edit');
        if (file.collection_id !== intent.target_collection_id || file.path !== intent.file_path) throw new HttpError(409, 'upload intent no longer matches its file');
      } catch (error:any) {
        if (error.status !== 404) { if (error.status === 403) continue; throw error }
        try { await this.access.requirePath(request, intent.target_collection_id, intent.file_path, 'edit') } catch (pathError:any) { if (pathError.status === 403) continue; throw pathError }
      }
      authorized.push({ plainSize: Number(intent.plain_size), versionId: intent.version_id });
    }
    if (!authorized.length) throw new HttpError(403, 'access denied');
    if (authorized.some(intent => intent.plainSize !== authorized[0].plainSize)) throw new HttpError(409, 'concurrent upload intents disagree on chunk geometry');
    return { scoped: true, plainSize: authorized[0].plainSize, versionIds: authorized.map(intent => intent.versionId) };
  }
}
