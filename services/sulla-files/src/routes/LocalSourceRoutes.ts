// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { createHash } from 'node:crypto';
import express from 'express';
import type pg from 'pg';

import type { FilesIdentity } from '../auth.js';
import type { Config } from '../config.js';
import type { TransactionRunner } from '../FilesTransaction.js';
import type { FilesAccessGate } from '../Http/FilesAccessGate.js';
import { FilesRequestInput } from '../Http/FilesRequestInput.js';
import { HttpError } from '../Http/HttpError.js';
import type { LocalManagerGate } from '../Http/LocalManagerGate.js';
import type { LocalFilesManager } from '../localManager.js';
import type { HomeSystemFileRepository } from '../Repositories/HomeSystemFileRepository.js';
import type { VersionWriter } from '../Services/VersionWriter.js';
import { assertStoredFilePath, ensureStoredFileParents, lockStoredNamespace } from '../storedNamespace.js';
import { isSystemArea, mirrorSystemAreaFile, shouldSkipSearchIndex, SKIP_SEARCH_INDEX_HEADER } from '../systemAreaIngest.js';

const { cleanPath, UUID } = FilesRequestInput;

/**
 * Desktop-local routes (moved from app.ts, same order): the local identity and status, the home
 * collection's system-area helpers and ingest, and explicitly selected native sources (ingest,
 * publications, actions, revalidation). Ingest stages content before its short transaction.
 */
export class LocalSourceRoutes {
  constructor(
    private readonly db:pg.Pool,
    private readonly config:Config,
    private readonly access:FilesAccessGate,
    private readonly managers:LocalManagerGate,
    private readonly versions:VersionWriter,
    private readonly transactions:TransactionRunner,
    private readonly homeFiles:HomeSystemFileRepository,
    private readonly manager?:LocalFilesManager,
  ) {}

  register(app:express.Express):void {
    app.get('/v1/local/identity', (_request, response) => response.json({ principalId: this.config.userId }));
    app.get('/v1/local/system-areas',async(_request,response,next)=>{try {
      // The 'sulla' system area writes owned content such as published Use Cases into the owner's home collection.
      response.json(await this.homeFiles.systemAreas(this.config.userId));
    } catch(error) {next(error)} });
    app.get('/v1/local/status', (_request, response) => response.json(this.manager ? this.manager.status() : { state: 'error', pendingFiles: 0, lastError: 'watched folder disabled', serverConfigured: false }));
    app.get('/v1/local/native-sources/collection', async(_request, response, next) => { try {
      response.json({ collectionId: await this.managers.nativeSources().nativeCollectionId() });
    } catch (error) { next(error) } });
    app.put('/v1/local/native-sources/ingest', express.raw({ type: '*/*', limit: '64mb' }), async(request, response, next) => { try {
      const metadata = this.nativeMetadata(request);
      const bytes = this.rawBody(request);
      if (createHash('sha256').update(bytes).digest('hex') !== metadata.desiredHash) throw new HttpError(409, 'native source bytes do not match their declared hash');
      const collectionId = String(request.query.collectionId ?? '');
      const fileId = typeof request.query.fileId === 'string' && request.query.fileId ? request.query.fileId : undefined;
      const baseVersionId = request.header('x-sulla-files-base-version') || undefined;
      const path = cleanPath(String(request.query.path ?? ''), false);
      const collection = await this.access.collectionRow(collectionId);
      if (collection.compatibility_state !== 'native') throw new HttpError(409, 'native source ingestion requires a native Files collection');
      const actor = this.localActor();
      const staged=await this.versions.stage(collectionId,bytes);
      const result = await this.managers.nativeSources().ingestNativeSource({ ...metadata, fileId, baseVersionId, collectionId, path },
        (client, versionId) => this.versions.insert(client, {
          collectionId, fileId, versionId, path,
          mime: request.header('content-type') ?? 'application/octet-stream', bytes, staged, actor,
          createdByType: 'user', createdById: this.config.userId, message: 'Imported from an explicitly selected native source', baseVersionId: baseVersionId ?? null,
        }));
      response.status(201).json(result);
    } catch (error) { next(error) } });
    // Read-only system areas: plain internal ingest, no native-source rows, handles, or publication state.
    app.put('/v1/local/system-areas/ingest', express.raw({ type: '*/*', limit: '64mb' }), async(request, response, next) => { try {
      const bytes = this.rawBody(request);
      const desiredHash = String(request.header('x-sulla-source-hash') ?? '').toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(desiredHash) || createHash('sha256').update(bytes).digest('hex') !== desiredHash) throw new HttpError(409, 'system-area bytes do not match their declared hash');
      const collectionId = String(request.query.collectionId ?? '');
      const path = cleanPath(String(request.query.path ?? ''), false);
      const collection = await this.access.collectionRow(collectionId);
      if (!isSystemArea(collection.system_area) && collection.system_area !== null) throw new HttpError(409, 'system-area ingestion requires the home or a system collection');
      const mime = request.header('content-type') ?? 'application/octet-stream';
      const actor = this.localActor();
      const staged=await this.versions.stage(collectionId,bytes);
      const result = await mirrorSystemAreaFile(this.db, {
        collectionId, path, manifestHash: await this.versions.manifestHashFor(collectionId, bytes),
        skipSearchIndex: shouldSkipSearchIndex(request.header(SKIP_SEARCH_INDEX_HEADER), collection.system_area),
      }, {
        lockNamespace: (client, id) => lockStoredNamespace(client as pg.PoolClient, id),
        insertVersion: (client, existing) => this.versions.insert(client as pg.PoolClient, {
          collectionId, fileId: existing?.id, path, mime, bytes, staged, actor, createdByType: 'user', createdById: this.config.userId,
          message: 'Mirrored from a Sulla system area', baseVersionId: existing?.current_version_id ?? null,
        }),
      });
      response.status(result.unchanged ? 200 : 201).json(result);
    } catch (error) { next(error) } });
    /** Desktop-only helpers for system-authored files in the home collection. */
    app.post('/v1/local/system-areas/move', async(request, response, next) => { try {
      const fileId = String(request.body.fileId ?? ''); const targetPath = cleanPath(String(request.body.targetPath ?? ''), false);
      const moved = await this.transactions.run('system-area-move', async client => {
      const file = await this.homeFiles.lockHomeFile(client, fileId);
      if (!file) throw new HttpError(404, 'Home collection file not found');
      await lockStoredNamespace(client, file.collection_id); await ensureStoredFileParents(client, file.collection_id, targetPath, this.localActor());
      await assertStoredFilePath(client, file.collection_id, targetPath, file.id);
      const moved = await this.homeFiles.move(client, file.id, targetPath);
      await this.homeFiles.auditMove(client, this.config.userId, this.config.deviceId, file.id, file.current_version_id, {from:file.path,to:targetPath});
      return moved; });
      response.json(moved);
    } catch(error) { next(error) } });
    app.post('/v1/local/system-areas/audit', async(request, response, next) => { try {
      const fileId = request.body.fileId || null; const versionId = request.body.versionId || null;
      if (fileId) {
        const row = await this.homeFiles.homeFile(fileId);
        if (!row) throw new HttpError(404,'Home collection file not found');
      }
      await this.homeFiles.audit(this.config.userId,this.config.deviceId,fileId,versionId,String(request.body.action??'system-area-event'),request.body.details??{});
      response.status(204).end();
    } catch(error) { next(error) } });
    app.post('/v1/local/native-sources/publications', async(request, response, next) => { try {
      const metadata = this.nativeMetadata(request);
      const fileId = String(request.body.fileId ?? '');
      const baseVersionId = String(request.body.baseVersionId ?? '');
      if (!UUID.test(fileId) || !UUID.test(baseVersionId)) throw new HttpError(400, 'valid Files publication identity is required');
      const file = await this.access.fileRow(fileId);
      if (file.current_version_id !== baseVersionId) throw new HttpError(409, 'Files base version changed before native publication');
      await this.managers.nativeSources().planNativePublication({ ...metadata, fileId, baseVersionId });
      response.status(201).json({ operationId: metadata.operationId });
    } catch (error) { next(error) } });
    app.post('/v1/local/native-sources/publications/:id/finish', async(request, response, next) => { try {
      if (typeof request.body.conflictFileId === 'string') {
        const conflict = request.body;
        if (![conflict.conflictFileId, conflict.currentFilesVersionId].every((value:unknown) => typeof value === 'string' && UUID.test(value)) ||
            ![conflict.currentSourceRevision, conflict.currentSourceHash].every((value:unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value))) throw new HttpError(400, 'native conflict recovery proof is invalid');
        await this.managers.nativeSources().finishNativePublicationConflict(request.params.id, conflict);
        return response.status(204).end();
      }
      const nextRevision = typeof request.body.nextSourceRevision === 'string' ? request.body.nextSourceRevision.toLowerCase() : undefined;
      if (nextRevision !== undefined && !/^[a-f0-9]{64}$/.test(nextRevision)) throw new HttpError(400, 'next source revision is invalid');
      const proof = nextRevision === undefined
        ? undefined
        : {
            nextSourceRevision:      nextRevision,
            originalSourceRevision: String(request.body.originalSourceRevision ?? '').toLowerCase(),
            originalSourceHash:     String(request.body.originalSourceHash ?? '').toLowerCase(),
            currentSourceHash:      String(request.body.currentSourceHash ?? '').toLowerCase(),
            filesBaseVersionId:     String(request.body.filesBaseVersionId ?? ''),
            currentFilesVersionId:  String(request.body.currentFilesVersionId ?? ''),
          };
      if (proof && (![proof.originalSourceRevision, proof.originalSourceHash, proof.currentSourceHash].every(value => /^[a-f0-9]{64}$/.test(value)) ||
          ![proof.filesBaseVersionId, proof.currentFilesVersionId].every(value => UUID.test(value)))) throw new HttpError(400, 'native publication completion proof is invalid');
      await this.managers.nativeSources().finishNativePublication(request.params.id, proof, typeof request.body.error === 'string' ? request.body.error : undefined);
      response.status(204).end();
    } catch (error) { next(error) } });
    app.get('/v1/local/native-sources/actions', async(_request, response, next) => { try {
      response.setHeader('Cache-Control', 'private, no-store');
      response.json(await this.managers.nativeSources().nativePublicationActions());
    } catch (error) { next(error) } });
    app.get('/v1/local/native-sources', async(request, response, next) => { try {
      response.setHeader('Cache-Control', 'private, no-store');
      const page = await this.managers.nativeSources().listNativeSources({
        limit: request.query.limit === undefined ? undefined : Number(request.query.limit),
        after: typeof request.query.after === 'string' ? request.query.after : undefined,
        state: typeof request.query.state === 'string' ? request.query.state : undefined,
      });
      if (page.length) response.setHeader('x-sulla-next-cursor', page[page.length - 1].cursor);
      response.json(page);
    } catch (error) { next(error) } });
    app.post('/v1/local/native-sources/revalidate', async(request, response, next) => { try {
      const handles = request.body.handles;
      const replaceExisting = request.body.replaceExisting === undefined ? true : request.body.replaceExisting;
      if (typeof replaceExisting !== 'boolean') throw new HttpError(400, 'native source revalidation mode is invalid');
      if (!Array.isArray(handles) || handles.length > 256 || handles.some((handle:unknown) => typeof handle !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(handle))) throw new HttpError(400, 'native source handles are invalid');
      await this.managers.nativeSources().revalidateNativeSessions(handles, replaceExisting);
      response.status(204).end();
    } catch (error) { next(error) } });
    app.post('/v1/local/native-sources/reselect-interrupted-publication', async(request, response, next) => { try {
      const input = request.body as Record<string, unknown>;
      if (!UUID.test(String(input.fileId ?? '')) ||
          ![input.previousHandle, input.handle].every(value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)) ||
          ![input.sourceRevision, input.sourceHash].every(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value))) {
        throw new HttpError(400, 'interrupted native publication reselection proof is invalid');
      }
      const recovered = await this.managers.nativeSources().reselectInterruptedNativePublication(input as {
        fileId:string;
        previousHandle:string;
        handle:string;
        sourceRevision:string;
        sourceHash:string;
      });
      response.json({ recovered });
    } catch (error) { next(error) } });
    app.get('/v1/local/native-sources/actions/:id/content', async(request, response, next) => { try {
      const action = (await this.managers.nativeSources().nativePublicationActions()).find(item => item.operationId === request.params.id);
      if (!action) throw new HttpError(404, 'native publication action is unavailable');
      const bytes = await this.managers.nativeSources().readStoredVersion(action.fileId, action.versionId);
      if (createHash('sha256').update(bytes).digest('hex') !== action.desiredHash) throw new HttpError(409, 'native publication Files version does not match its durable action');
      response.setHeader('Cache-Control', 'private, no-store');
      response.setHeader('Content-Length', String(bytes.byteLength));
      response.setHeader('X-Sulla-Source-Handle', action.handle);
      response.setHeader('X-Sulla-Source-Revision', action.sourceRevision);
      response.setHeader('X-Sulla-Source-Hash', action.desiredHash);
      response.type('application/octet-stream').send(bytes);
    } catch (error) { next(error) } });
  }

  /** /v1/local/* is gated by the local service token and carries no bearer identity; it acts as the device owner. */
  private localActor():FilesIdentity {
    return { userId: this.config.userId, deviceId: this.config.deviceId, kind: 'capability', orgId: this.config.orgId };
  }

  /** express.raw only parses a body that has a content-type; anything else is refused before hashing. */
  private rawBody(request:express.Request):Buffer {
    if (!Buffer.isBuffer(request.body)) throw new HttpError(400, 'request body must be raw bytes with a content-type');
    return request.body;
  }

  private nativeMetadata(request:express.Request) {
    const operationId = request.header('x-sulla-operation-id') ?? '';
    const handle = request.header('x-sulla-source-handle') ?? '';
    const sourceRevision = request.header('x-sulla-source-revision')?.toLowerCase() ?? '';
    const desiredHash = request.header('x-sulla-source-hash')?.toLowerCase() ?? '';
    if (!UUID.test(operationId) || !/^[A-Za-z0-9_-]{43}$/.test(handle) ||
        !/^[a-f0-9]{64}$/.test(sourceRevision) || !/^[a-f0-9]{64}$/.test(desiredHash)) {
      throw new HttpError(400, 'valid native source operation metadata is required');
    }
    return { operationId, handle, sourceRevision, desiredHash };
  }
}
