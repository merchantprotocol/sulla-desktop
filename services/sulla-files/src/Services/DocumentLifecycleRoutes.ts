// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { TransactionRunner } from '../FilesTransaction.js';
import { ChunkGcRepository } from '../Repositories/ChunkGcRepository.js';
import { DocumentLifecycleRepository } from '../Repositories/DocumentLifecycleRepository.js';
import { FilePurgeRepository } from '../Repositories/FilePurgeRepository.js';
import { ChunkGcDrainer, type DeleteChunk } from './ChunkGcDrainer.js';
import { DocumentLifecycleView } from './DocumentLifecycleView.js';
import { DocumentPublicationService } from './DocumentPublicationService.js';
import { FilePurgeService, type DisposeTrashReceipt } from './FilePurgeService.js';
import { LifecycleHttpError } from './LifecycleHttpError.js';
import { LifecycleRecordsService } from './LifecycleRecordsService.js';

import type { FilesIdentity } from '../auth.js';
import type express from 'express';
import type pg from 'pg';

type Right = 'view' | 'edit' | 'manage';
export type RequestWithIdentity = express.Request<Record<string, string>> & { filesIdentity?:FilesIdentity };

export interface DocumentLifecycleDeps {
  identity(request:RequestWithIdentity):FilesIdentity;
  requireFile(request:RequestWithIdentity, fileId:string, right:Right):Promise<any>;
  audit(request:RequestWithIdentity, action:string, file?:any, details?:Record<string, unknown>):Promise<void>;
  deleteChunk:DeleteChunk;
  disposeTrashReceipt?:DisposeTrashReceipt;
}

type Handler = (request:RequestWithIdentity, response:express.Response)=>Promise<unknown>;

/** HTTP surface of the document lifecycle: authorisation, then a service call, then audit + JSON. */
export class DocumentLifecycleRoutes {
  private readonly lifecycle:DocumentLifecycleRepository;
  private readonly drainer:ChunkGcDrainer;
  private readonly publication:DocumentPublicationService;
  private readonly records:LifecycleRecordsService;
  private readonly purges:FilePurgeService;
  private readonly view = new DocumentLifecycleView();

  constructor(private readonly db:pg.Pool, private readonly deps:DocumentLifecycleDeps) {
    const transactions = new TransactionRunner(db); const gc = new ChunkGcRepository(db);
    this.lifecycle = new DocumentLifecycleRepository(db);
    this.drainer = new ChunkGcDrainer(db, gc, transactions);
    this.publication = new DocumentPublicationService(this.lifecycle, transactions);
    this.records = new LifecycleRecordsService(this.lifecycle, transactions);
    this.purges = new FilePurgeService(db, this.lifecycle, new FilePurgeRepository(), gc, this.drainer, transactions);
  }

  /** Wraps a handler so a thrown error reaches Express's error middleware. */
  private route(handler:Handler) {
    return async(request:RequestWithIdentity, response:express.Response, next:express.NextFunction):Promise<void> => { try { await handler(request, response) } catch (error) { next(error) } };
  }

  private human(request:RequestWithIdentity):FilesIdentity { return LifecycleHttpError.requireHuman(this.deps.identity(request)) }

  /** Publish after a `manage` check; the human check runs inside the transaction, as before. */
  private async publish(request:RequestWithIdentity, requireExpected:boolean, releaseCheckout = false, explicitVersionId?:string):Promise<any> {
    await this.deps.requireFile(request, request.params.id, 'manage');
    return this.publication.publish(request.params.id, this.deps.identity(request), {
      explicitVersionId, bodyVersionId: request.body?.versionId, requireExpectedDraft: requireExpected,
      expectedDraftVersionId: request.body?.expectedDraftVersionId, comment: request.body?.comment ?? null, releaseCheckout,
    });
  }

  register(app:express.Express):void {
    const { deps } = this; const fields = (row:any) => this.view.fields(row);
    void this.drainer.drain(deps.deleteChunk).catch(error => console.warn('[SullaFiles] pending physical chunk cleanup failed:', error));

    app.patch('/v1/files/:id/lifecycle', this.route(async(request, response) => {
      await deps.requireFile(request, request.params.id, 'manage');
      const row = await this.records.updateSettings(request.params.id, request.body);
      await deps.audit(request, 'lifecycle-settings', row); response.json(fields(row));
    }));
    app.post('/v1/files/:id/checkout', this.route(async(request, response) => {
      await deps.requireFile(request, request.params.id, 'edit'); const actor = deps.identity(request);
      const row = await this.records.checkout(request.params.id, actor);
      await deps.audit(request, 'checkout', row); response.json(fields(row));
    }));
    app.delete('/v1/files/:id/checkout', this.route(async(request, response) => {
      await deps.requireFile(request, request.params.id, 'edit'); const actor = deps.identity(request); const force = request.body?.force === true;
      if (force) await deps.requireFile(request, request.params.id, 'manage');
      const row = await this.records.releaseCheckout(request.params.id, actor, force);
      await deps.audit(request, force ? 'checkout-force-release' : 'checkout-release', row); response.json(fields(row));
    }));
    app.get('/v1/files/:id/versions', this.route(async(request, response) => {
      const file = await deps.requireFile(request, request.params.id, 'view');
      const page = this.view.parseVersionPage(request.query.limit, request.query.cursor);
      const rows = await this.lifecycle.listVersions(file.id, page.cursor, page.limit + 1);
      response.json(this.view.versionsPage(file, rows, page.limit));
    }));
    app.post('/v1/files/:id/versions/:versionId/publish', this.route(async(request, response) => {
      this.human(request);
      const row = await this.publish(request, false, false, request.params.versionId);
      await deps.audit(request, 'publish', {...row,current_version_id:request.params.versionId}, {versionId:request.params.versionId,requestId:request.body?.requestId ?? null});
      response.json(fields(row));
    }));
    app.post('/v1/files/:id/versions/:versionId/publish-request', this.route(async(request, response) => {
      await deps.requireFile(request, request.params.id, 'edit'); const actor = deps.identity(request);
      if (!LifecycleHttpError.isAgent(actor)) throw LifecycleHttpError.of(403, 'agent identity required');
      const reason = request.body?.reason == null ? null : String(request.body.reason).slice(0, 2000);
      const row = await this.publication.requestPublication(request.params.id, request.params.versionId, actor, reason);
      await deps.audit(request, 'publish-request', {id:request.params.id,current_version_id:request.params.versionId}, {requestId:row.id,reason});
      response.status(202).json(row);
    }));
    app.get('/v1/files/publish-requests', this.route(async(request, response) => {
      this.human(request); const status = typeof request.query.status === 'string' ? request.query.status : 'pending';
      const rows = await this.publication.listRequests(status, typeof request.query.fileId === 'string' ? request.query.fileId : null);
      response.json({requests:rows});
    }));
    for (const decision of ['approve','reject'] as const) app.post(`/v1/files/publish-requests/:requestId/${decision}`, this.route(async(request, response) => {
      const actor = this.human(request);
      const result = await this.publication.decide(request.params.requestId, decision, actor, request.body?.comment ?? null, fileId => { request.params.id = fileId });
      if (decision === 'approve') await deps.audit(request, 'publish', {...result.file,current_version_id:result.request.version_id}, {requestId:result.request.id,versionId:result.request.version_id});
      await deps.audit(request, decision === 'approve' ? 'publish-request-approve' : 'publish-request-reject',
        {...result.file,current_version_id:result.request.version_id}, {requestId:result.request.id,versionId:result.request.version_id});
      response.json(result);
    }));
    // Compatibility endpoint retained for existing File Manager callers.
    app.post('/v1/files/:id/publish', this.route(async(request, response) => { this.human(request); const row = await this.publish(request, true); await deps.audit(request, 'publish', row, { versionId: row.published_version_id }); response.json(fields(row)) }));
    app.post('/v1/files/:id/checkin', this.route(async(request, response) => {
      await deps.requireFile(request, request.params.id, 'edit'); const actor = deps.identity(request);
      if (request.body?.publish === true) { const row = await this.publish(request, false, true); await deps.audit(request, 'checkin-publish', row); return response.json(fields(row)) }
      const row = await this.publication.checkin(request.params.id, actor, { versionId: request.body?.versionId, kind: request.body?.kind, comment: request.body?.comment ?? null });
      const versionId = String(request.body?.versionId ?? row.draft_version_id ?? '');
      await deps.audit(request, 'checkin', row, { versionId }); response.json(fields(row));
    }));
    app.patch('/v1/files/:id/retention', this.route(async(request, response) => {
      await deps.requireFile(request, request.params.id, 'manage'); const actor = deps.identity(request);
      const input = this.records.parseRetention(request.body);
      const row = await this.records.updateRetention(request.params.id, input);
      await deps.audit(request, 'retention-update', row, { mode: input.mode, actor: actor.userId }); response.json(fields(row));
    }));
    app.post('/v1/files/:id/record-lock', this.route(async(request, response) => {
      await deps.requireFile(request, request.params.id, 'manage'); const actor = deps.identity(request); const kind = request.body?.kind;
      const row = await this.records.lockRecord(request.params.id, actor, kind);
      await deps.audit(request, 'record-lock', row, { kind }); response.json(fields(row));
    }));
    app.delete('/v1/files/:id/record-lock', this.route(async(request, response) => {
      await deps.requireFile(request, request.params.id, 'manage');
      const row = await this.records.unlockRecord(request.params.id);
      await deps.audit(request, 'record-unlock', row); response.json(fields(row));
    }));
    app.post('/v1/files/:id/disposal-review', this.route(async(request, response) => {
      await deps.requireFile(request, request.params.id, 'manage'); const decision = request.body?.decision;
      const row = await this.records.reviewDisposal(request.params.id, decision, request.body?.extendedUntil);
      await deps.audit(request, 'disposal-review', row, { decision }); response.json(fields(row));
    }));
    app.patch('/v1/files/:id/lifecycle-state', this.route(async(request, response) => {
      await deps.requireFile(request, request.params.id, 'manage');
      const result = await this.records.applyState(request.params.id, request.body?.file);
      if (result.applied) await deps.audit(request, 'lifecycle-sync', result.file); response.json({ applied: result.applied, generation: result.file.lifecycle_generation });
    }));
    app.delete('/v1/trash/:id/purge', this.route(async(request, response) => {
      await deps.requireFile(request, request.params.id, 'manage'); const actor = deps.identity(request);
      const outcome = await this.purges.purge(request.params.id, actor, request.body, deps.deleteChunk, deps.disposeTrashReceipt);
      if (outcome.status === 202) return response.status(202).json(outcome.body);
      response.json(outcome.body);
    }));
  }
}
