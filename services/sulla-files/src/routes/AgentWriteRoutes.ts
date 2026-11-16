// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { randomUUID } from 'node:crypto';
import type express from 'express';
import type pg from 'pg';

import type { Config } from '../config.js';
import type { TransactionRunner } from '../FilesTransaction.js';
import type { FilesAccessGate, RequestWithIdentity } from '../Http/FilesAccessGate.js';
import { FilesRequestInput } from '../Http/FilesRequestInput.js';
import { HttpError } from '../Http/HttpError.js';
import type { RequestAuditLog } from '../Http/RequestAuditLog.js';
import { loadFileContent } from '../preview.js';
import type { AgentWriteRepository } from '../Repositories/AgentWriteRepository.js';
import type { VersionWriter } from '../Services/VersionWriter.js';
import type { Store } from '../store.js';
import { lockStoredNamespace } from '../storedNamespace.js';
import { isSullaWritablePath } from '../systemPaths.js';

const { cleanPath, idempotencyUuid } = FilesRequestInput;

/**
 * Agent artifact writes (moved from app.ts): POST /v1/agent-files (idempotent, creator-checked,
 * derived-from edges) and /v1/agent-files/ensure. Sources are authorized and the content staged
 * before the short metadata transaction; an idempotent replay compares content after it.
 */
export class AgentWriteRoutes {
  constructor(
    private readonly db:pg.Pool,
    private readonly config:Config,
    private readonly store:Store,
    private readonly access:FilesAccessGate,
    private readonly versions:VersionWriter,
    private readonly transactions:TransactionRunner,
    private readonly writes:AgentWriteRepository,
    private readonly audit:RequestAuditLog,
  ) {}

  register(app:express.Express):void {
    app.post('/v1/agent-files', async(request:RequestWithIdentity, response, next) => { try {
      const actor = this.access.identity(request);
      const path = cleanPath(request.body.path, false); const collection = await this.ensureCollection(request, request.body.collectionId);
      if (collection.system_area === 'sulla' && !isSullaWritablePath(path)) throw new HttpError(403, 'Agent writes to the Sulla system collection are limited to Use Cases drafts, durable Memory and Projects');
      await this.access.requirePath(request, collection.id, path, 'edit');
      const bytes = request.body.contentBase64 !== undefined
        ? Buffer.from(String(request.body.contentBase64), 'base64')
        : Buffer.from(String(request.body.content ?? ''), 'utf8');
      if (bytes.byteLength > 12 * 1024 * 1024) throw new HttpError(413, 'agent file exceeds the 12 MiB tool limit');
      const requestedFileId = request.body.fileId === undefined ? undefined : String(request.body.fileId);
      const expectedVersionId = request.body.expectedVersionId === undefined ? undefined : String(request.body.expectedVersionId);
      if (requestedFileId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestedFileId)) throw new HttpError(400, 'valid fileId required');
      if (expectedVersionId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(expectedVersionId)) throw new HttpError(400, 'valid expectedVersionId required');
      const idempotencyKey = request.body.idempotencyKey === undefined ? undefined : String(request.body.idempotencyKey);
      if (idempotencyKey !== undefined && (!idempotencyKey.trim() || idempotencyKey.length > 512)) throw new HttpError(400, 'idempotencyKey must be 1 to 512 characters');
      const creatorId = actor.jobId ?? actor.agentId!;
      const versionId = idempotencyKey ? idempotencyUuid(`${ actor.userId }\n${ creatorId }\n${ collection.id }\n${ idempotencyKey }`) : undefined;
      const mime = String(request.body.mime || 'application/octet-stream');
      const message = String(request.body.message ?? 'Agent write');
      const derived:string[] = Array.isArray(request.body.derivedFrom)
        ? [...new Set<string>(request.body.derivedFrom.filter((value:unknown):value is string => typeof value === 'string'))].sort()
        : [];

      // Authorize sources and encrypt the content before the transaction; it then holds only DB statements.
      for (const sourceId of derived) await this.access.requireFile(request, sourceId, 'view');
      const staged = await this.versions.stage(collection.id, bytes);
      const outcome = await this.transactions.run('agent-put', async client => {
      await lockStoredNamespace(client, collection.id);
      const pathFile = await this.writes.lockFileAtPath(client, collection.id, path);
      const requestedFile = requestedFileId ? await this.writes.lockFile(client, requestedFileId) : undefined;
      if (requestedFileId && !requestedFile && pathFile) throw new HttpError(409, 'fileId does not match the file at the requested path');
      if (requestedFile && (requestedFile.collection_id !== collection.id || requestedFile.path !== path)) throw new HttpError(409, 'fileId does not match the requested collection and path');
      if (requestedFile && pathFile && requestedFile.id !== pathFile.id) throw new HttpError(409, 'artifact path belongs to another file');
      const existing = requestedFile ?? pathFile;
      if (expectedVersionId !== undefined && (!existing || existing.current_version_id !== expectedVersionId)) {
        throw new HttpError(409, `file version conflict; current version is ${ existing?.current_version_id ?? 'missing' }`);
      }
      const sharedSullaPath = (collection.system_area === 'sulla' || collection.system_area === null) && isSullaWritablePath(path);
      if (existing && !sharedSullaPath && (existing.created_by_type !== 'agent-run' || existing.created_by_id !== creatorId)) {
        throw new HttpError(409, 'artifact path belongs to another creator');
      }
      if (versionId) {
        const prior = await this.writes.priorVersion(client, versionId);
        if (prior) {
          if (!existing || prior.file_id !== existing.id || prior.collection_id !== collection.id || prior.path !== path || prior.mime !== mime ||
              prior.created_by_type !== 'agent-run' || prior.created_by_id !== creatorId) {
            throw new HttpError(409, 'idempotencyKey was already used for a different artifact write');
          }
          if (prior.message !== message) throw new HttpError(409, 'idempotencyKey was already used with a different message');
          const priorEdges = await this.writes.derivedSources(client, prior.file_id);
          if (priorEdges.length !== derived.length || priorEdges.some((id, index) => id !== derived[index])) throw new HttpError(409, 'idempotencyKey was already used with different artifact sources');
          return { prior: { fileId: prior.file_id as string, versionId: prior.id as string } };
        }
      }
      const file = await this.versions.insert(client, { collectionId: collection.id, fileId: existing?.id ?? requestedFileId, createFileId: Boolean(requestedFileId && !existing), versionId, path, mime, bytes, staged, actor, createdByType: 'agent-run', createdById: creatorId, message });
      await this.writes.clearDerivedSources(client, file.id);
      for (const sourceId of derived) { const source = await this.access.fileRow(sourceId, client); await this.writes.addDerivedSource(client, file.id, source.id, actor.jobId ?? actor.agentId!) }
      return { file };
      });
      if ('prior' in outcome && outcome.prior) {
        // Idempotent replay: compare content outside the transaction (it reads chunks through the pool).
        const content = await loadFileContent(this.db, this.config, this.store, outcome.prior.fileId, outcome.prior.versionId);
        if (!content?.buffer.equals(bytes)) throw new HttpError(409, 'idempotencyKey was already used for different content');
        return response.status(200).json({ fileId: outcome.prior.fileId, versionId: outcome.prior.versionId, collectionId: collection.id, path });
      }
      const file = (outcome as { file:any }).file;
      await this.audit.record(request, 'put', file, { threadId: actor.threadId, agentRunId: actor.jobId });
      response.status(201).json({ fileId: file.id, versionId: file.current_version_id, collectionId: collection.id, path: file.path });
    } catch (error) { next(error) } });
    app.post('/v1/agent-files/ensure', async(request:RequestWithIdentity, response, next) => { try {
      const actor = this.access.identity(request); if (!actor.jobId) throw new HttpError(400, 'job identity is required');
      const collection = await this.ensureCollection(request); response.status(201).json({ collectionId: collection.id });
    } catch (error) { next(error) } });
  }

  /** The agent's target collection: the requested native one (edit right on the path) or its default knowledge collection, created once. */
  private async ensureCollection(request:RequestWithIdentity, requestedId?:unknown):Promise<any> {
    const actor = this.access.identity(request);
    if (requestedId) {
      const collection = await this.access.collectionRow(String(requestedId));
      if (collection.compatibility_state !== 'native') throw new HttpError(409, 'Legacy collection content requires explicit secure import before agent access');
      await this.access.requirePath(request, collection.id, cleanPath(request.body.path, false), 'edit');
      return collection;
    }
    const existing = await this.writes.defaultKnowledgeCollection(actor.userId, actor.orgId ?? null);
    if (existing) return existing;
    return this.transactions.run('agent-collection', async client => {
      const id = randomUUID(); const kind = 'knowledge';
      const row = await this.writes.insertKnowledgeCollection(client, id, actor.orgId ?? null, actor.userId, actor.threadId ?? null, kind);
      const wrapped = await this.config.keyring!.create(id, client);
      await this.writes.setCollectionKeys(client, id, wrapped.data, wrapped.dedup);
      return { ...row, encrypted_data_key: wrapped.data, dedup_key_ciphertext: wrapped.dedup };
    });
  }
}
