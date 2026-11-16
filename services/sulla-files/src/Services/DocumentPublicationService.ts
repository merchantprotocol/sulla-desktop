// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { LifecycleHttpError } from './LifecycleHttpError.js';

import type { FilesIdentity } from '../auth.js';
import type { TransactionRunner } from '../FilesTransaction.js';
import type { DocumentLifecycleRepository } from '../Repositories/DocumentLifecycleRepository.js';
import type pg from 'pg';

export interface PublishOptions {
  /** A version chosen by the route path; otherwise `bodyVersionId`, then the file's draft. */
  explicitVersionId?:string;
  bodyVersionId?:unknown;
  /** Compatibility publish: the caller's view of the draft must still be current. */
  requireExpectedDraft?:boolean;
  expectedDraftVersionId?:unknown;
  comment?:string | null;
  releaseCheckout?:boolean;
}

export interface CheckinInput { versionId?:unknown; kind?:unknown; comment?:string | null }

/**
 * Draft → published transitions: publishing a version (superseding the prior published one,
 * numbering it as the next major), agent publish requests and their human approval, and check-in.
 */
export class DocumentPublicationService {
  constructor(
    private readonly lifecycle:DocumentLifecycleRepository,
    private readonly transactions:TransactionRunner,
  ) {}

  private async lockedFile(client:pg.PoolClient, id:string):Promise<any> {
    const row = await this.lifecycle.lockFile(client, id);
    if (!row) throw LifecycleHttpError.of(404, 'file not found');
    return row;
  }

  /** Publishes `versionId` of the locked file. Caller holds the transaction. */
  async publishLocked(client:pg.PoolClient, fileId:string, actor:FilesIdentity, versionId:string, comment:string | null, releaseCheckout = false):Promise<any> {
    LifecycleHttpError.requireHuman(actor);
    const file = await this.lockedFile(client, fileId);
    const active = await this.lifecycle.retentionActive(client, file.id);
    if (active) throw LifecycleHttpError.of(423, 'file is locked by record retention');
    if (!versionId) throw LifecycleHttpError.of(409, 'file has no draft to publish');
    const version = await this.lifecycle.lockVersion(client, versionId, file.id);
    if (!version) throw LifecycleHttpError.of(404, 'version not found');
    if (version.publication_status === 'published') return file;
    const major = await this.lifecycle.maxMajor(client, file.id) + 1;
    await this.lifecycle.supersedePublished(client, file.id);
    await this.lifecycle.markVersionPublished(client, version.id, major, actor.userId, comment);
    const result = await this.lifecycle.markFilePublished(client, file.id, version.id, releaseCheckout);
    await this.lifecycle.journalFile(client, result, 'put', version.id);
    return result;
  }

  /** Publishes in its own transaction (the caller already checked `manage` on the file). */
  publish(fileId:string, actor:FilesIdentity, options:PublishOptions):Promise<any> {
    return this.transactions.run('document-publish', async client => {
      const file = await this.lockedFile(client, fileId);
      const versionId = options.explicitVersionId ?? String(options.bodyVersionId ?? file.draft_version_id ?? '');
      if (options.requireExpectedDraft && options.expectedDraftVersionId !== file.draft_version_id) throw LifecycleHttpError.of(409, 'draft changed while publication was starting');
      return this.publishLocked(client, fileId, actor, versionId, options.comment ?? null, options.releaseCheckout ?? false);
    });
  }

  /** An agent asks a human to publish one of its draft versions (idempotent while pending). */
  async requestPublication(fileId:string, versionId:string, actor:FilesIdentity, reason:string | null):Promise<any> {
    if (!LifecycleHttpError.isAgent(actor)) throw LifecycleHttpError.of(403, 'agent identity required');
    return this.transactions.run('document-publish-request', async client => {
      const file = await this.lockedFile(client, fileId);
      const version = await this.lifecycle.findDraftVersion(client, versionId, file.id);
      if (!version) throw LifecycleHttpError.of(404, 'version not found');
      return this.lifecycle.upsertPublishRequest(client, file.id, version.id, actor.jobId ?? actor.agentId ?? actor.userId, reason);
    });
  }

  async listRequests(status:string, fileId:string | null):Promise<any[]> {
    if (!['pending','approved','rejected','expired'].includes(status)) throw LifecycleHttpError.of(400, 'invalid publish request status');
    return this.lifecycle.listPublishRequests(status, fileId);
  }

  /** Approves (publishes) or rejects a pending request. `onResolved` receives the request's file id. */
  decide(requestId:string, decision:'approve' | 'reject', actor:FilesIdentity, comment:string | null, onResolved:(fileId:string)=>void = () => {}):Promise<{ file:any; request:any }> {
    return this.transactions.run('document-publish-decision', async client => {
      const publication = await this.lifecycle.lockPublishRequest(client, requestId);
      if (!publication) throw LifecycleHttpError.of(404, 'publish request not found');
      if (publication.status !== 'pending') throw LifecycleHttpError.of(409, `publish request is ${publication.status}`);
      onResolved(publication.file_id);
      let file:any = await this.lockedFile(client, publication.file_id);
      if (decision === 'approve') file = await this.publishLocked(client, publication.file_id, actor, publication.version_id, comment);
      const decided = await this.lifecycle.decidePublishRequest(client, publication.id, decision === 'approve' ? 'approved' : 'rejected', actor.userId);
      return { file, request: decided };
    });
  }

  /** Checks a draft in (numbers it major or minor) and releases the editor's checkout. */
  checkin(fileId:string, actor:FilesIdentity, input:CheckinInput):Promise<any> {
    return this.transactions.run('document-checkin', async client => {
      const file = await this.lockedFile(client, fileId); if (file.record_lock_type !== 'none') throw LifecycleHttpError.of(423, 'record is locked');
      const actorDevice = actor.deviceId || 'server-web';
      if (file.require_checkout && (file.checked_out_by_user_id !== actor.userId || file.checked_out_by_device_id !== actorDevice)) throw LifecycleHttpError.of(409, 'file must be checked out by this editor');
      if (file.checked_out_by_user_id && file.checked_out_by_user_id !== actor.userId) throw LifecycleHttpError.of(409, 'file is checked out by another editor');
      const versionId = String(input.versionId ?? file.draft_version_id ?? ''); const kind = input.kind === 'major' ? 'major' : 'minor';
      const major = kind === 'major' ? await this.lifecycle.maxMajor(client, file.id) + 1 : await this.lifecycle.maxMajor(client, file.id);
      const minor = kind === 'major' ? 0 : await this.lifecycle.maxMinor(client, file.id, major) + 1;
      if (!await this.lifecycle.checkinVersion(client, versionId, file.id, input.comment ?? null, kind, major, minor)) throw LifecycleHttpError.of(404, 'version not found');
      const updated = await this.lifecycle.releaseCheckout(client, file.id);
      await this.lifecycle.journalFile(client, updated); return updated;
    });
  }
}
