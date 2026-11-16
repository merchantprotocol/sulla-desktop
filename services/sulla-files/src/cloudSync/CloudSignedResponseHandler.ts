// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { FilesSyncCloudApi } from './cloudApi.js';
import { CloudSyncErrorText } from './CloudSyncErrors.js';
import type { CloudSyncRepositories } from './CloudSyncRepositories.js';
import type { CloudUploadSessions } from './CloudUploadSessions.js';
import { verifyHead, type SyncHead } from './envelope.js';
import type { CloudRootKeyStore } from './keyStore.js';
import type { QueuedOperation } from './repository.js';
import type { CloudStagingStore } from './staging.js';
import { isUuid } from './validation.js';

const MAX_ATTEMPTS = 5;

export type SendStatus = 'sent' | 'conflict' | 'retry' | 'failed' | 'skipped';

/** What the response handler may ask of the sync loop. */
export interface CloudSyncLoopControl {
  /** Run the next background pass now. */
  nudge():void;
  /** Pull this collection on the next pass instead of waiting for the pull interval. */
  pullSoon(collectionId:string):void;
}

/** Applies Cloud's answer to one device-signed call: bookkeeping on success, retry/skip/fail otherwise. */
export class CloudSignedResponseHandler {
  constructor(
    private readonly repositories:CloudSyncRepositories,
    private readonly api:FilesSyncCloudApi,
    private readonly staging:CloudStagingStore,
    private readonly roots:CloudRootKeyStore,
    private readonly sessions:CloudUploadSessions,
    private readonly loop:CloudSyncLoopControl,
  ) {}

  async handleResponse(operation:QueuedOperation, status:number, body:any, headers:Record<string,string> = {}):Promise<{ status:SendStatus; detail:unknown }> {
    const collectionId = operation.collectionId;
    const ok = status >= 200 && status < 300;
    if (status === 401 || status === 403) {
      // Stale timestamp or signature problems are fixed by re-signing; main retries with backoff.
      return this.failed(operation, 'Sulla Cloud rejected the device signature', { status, error: body?.error });
    }
    if (status === 429) {
      const retryAfterMs = Math.min(5 * 60_000, Math.max(1_000, Number(headers['retry-after']) * 1_000 || 1_000));
      return this.failed(operation, 'Sulla Cloud is busy; retrying shortly', { status, retryAfterMs, error: body?.error });
    }
    switch (operation.op) {
      case 'create': {
        const meta = operation.meta as { head:SyncHead; vaultId:string; vaultEpoch:number };
        if (ok) {
          await this.repositories.state.markCreated(collectionId, meta.head, meta.vaultId, meta.vaultEpoch);
          await this.repositories.operations.completeOperation(operation.handle);
          this.loop.nudge();
          return { status: 'sent', detail: { collectionId } };
        }
        if (status === 409 && body?.error === 'collection_exists') return this.adoptExistingCollection(operation);
        break;
      }
      case 'escrow': {
        const meta = operation.meta as { vaultId:string; vaultEpoch:number };
        if (ok) {
          await this.repositories.state.markEscrowed(collectionId, meta.vaultId, meta.vaultEpoch);
          await this.repositories.operations.completeOperation(operation.handle);
          return { status: 'sent', detail: { collectionId } };
        }
        break;
      }
      case 'upload-open': {
        if (ok && typeof body?.uploadId === 'string' && isUuid(body.uploadId)) {
          const sync = await this.repositories.state.sync(collectionId);
          const session = sync?.uploadSession;
          if (session) {
            const missing = new Set(Array.isArray(body.missing) ? body.missing : []);
            session.uploadId = body.uploadId;
            session.present = session.declared.map(chunk => chunk.id).filter(id => !missing.has(id));
            await this.repositories.state.saveSession(collectionId, session, this.sessions.pendingBytes(session, missing), 'syncing');
          }
          await this.repositories.operations.completeOperation(operation.handle);
          this.loop.nudge();
          return { status: 'sent', detail: { collectionId } };
        }
        if (status === 507) {
          await this.sessions.dropSession(collectionId);
          await this.repositories.operations.completeOperation(operation.handle);
          await this.repositories.state.setStatus(collectionId, 'error', 'Sulla Cloud backup storage is full');
          return { status: 'failed', detail: { error: 'quota_exceeded' } };
        }
        break;
      }
      case 'commit':
        return this.handleCommitResponse(operation, status, body);
      case 'info': {
        // Best effort: a folder name Cloud refuses must never stall the backup itself.
        if (ok || (status >= 400 && status < 500)) {
          await this.repositories.state.markInfoSent(collectionId, String(operation.meta.nameSha ?? ''));
          await this.repositories.operations.completeOperation(operation.handle);
          return { status: ok ? 'sent' : 'skipped', detail: { collectionId } };
        }
        break;
      }
      case 'delete': {
        if (ok || status === 404) {
          await this.staging.clear(collectionId);
          await this.repositories.state.markCloudDeleted(collectionId);
          await this.repositories.operations.completeOperation(operation.handle);
          return { status: 'sent', detail: { collectionId } };
        }
        break;
      }
    }
    return this.failed(operation, `Sulla Cloud returned ${ status }`, { status, error: typeof body?.error === 'string' ? body.error : undefined });
  }

  private async handleCommitResponse(operation:QueuedOperation, status:number, body:any):Promise<{ status:SendStatus; detail:unknown }> {
    const collectionId = operation.collectionId;
    if (status >= 200 && status < 300 && body?.ok === true) {
      const sync = await this.repositories.state.sync(collectionId);
      const session = sync?.uploadSession;
      const head = operation.meta.head as SyncHead;
      if (!session || Number(body.seq) !== head.seq) {
        // The commit landed but local bookkeeping is gone; the next pull reconciles it.
        await this.repositories.operations.completeOperation(operation.handle);
        this.loop.pullSoon(collectionId);
        return { status: 'sent', detail: { collectionId } };
      }
      await this.repositories.progress.finishCommit(collectionId, session, head);
      await this.repositories.operations.completeOperation(operation.handle);
      await this.sessions.adoptPresentCopies(sync!, session);
      await this.staging.clear(collectionId);
      this.loop.nudge();
      return { status: 'sent', detail: { collectionId, seq: head.seq } };
    }
    if (status === 409 && (body?.error === 'head_moved' || body?.error === 'file_conflict')) {
      // Drop the stale commit and its upload; the next pass pulls (forking unpushed edits) and re-stages.
      await this.sessions.dropSession(collectionId);
      await this.repositories.operations.completeOperation(operation.handle);
      this.loop.pullSoon(collectionId);
      this.loop.nudge();
      return { status: 'conflict', detail: { error: body.error } };
    }
    if (status === 422 && body?.error === 'missing_chunks') {
      const missing = Array.isArray(body.missing) ? body.missing.filter((id:unknown):id is string => typeof id === 'string') : [];
      await this.repositories.chunks.forgetUpload(collectionId, missing);
      await this.sessions.dropSession(collectionId);
      await this.repositories.operations.completeOperation(operation.handle);
      this.loop.nudge();
      return { status: 'retry', detail: { error: 'missing_chunks' } };
    }
    return this.failed(operation, `Sulla Cloud returned ${ status }`, { status, error: typeof body?.error === 'string' ? body.error : undefined });
  }

  /** `create` hit an existing collection: adopt it only if its head was signed with our root. */
  private async adoptExistingCollection(operation:QueuedOperation):Promise<{ status:SendStatus; detail:unknown }> {
    const collectionId = operation.collectionId;
    const sync = await this.repositories.state.sync(collectionId);
    const meta = operation.meta as { vaultId:string; vaultEpoch:number };
    if (!sync?.wrappedRoot) return this.failed(operation, 'Cloud backup is not set up for this collection', undefined);
    const root = await this.roots.unwrap(collectionId, sync.keyVersion, sync.wrappedRoot);
    try {
      const page = await this.api.changes(collectionId, 0, 1);
      if (page.head.collectionId !== collectionId || page.head.keyVersion !== sync.keyVersion || !await verifyHead(root, page.head)) {
        await this.repositories.operations.completeOperation(operation.handle);
        await this.repositories.state.setStatus(collectionId, 'error', 'This collection already has a different cloud backup; restore it instead');
        return { status: 'failed', detail: { error: 'collection_exists' } };
      }
      await this.repositories.state.adoptExisting(collectionId, meta.vaultId, meta.vaultEpoch);
      await this.repositories.operations.completeOperation(operation.handle);
      this.loop.nudge();
      return { status: 'sent', detail: { collectionId, adopted: true } };
    } catch (error) {
      return this.failed(operation, CloudSyncErrorText.safe(error), undefined);
    } finally {
      root.fill(0);
    }
  }

  async failed(operation:QueuedOperation, message:string, detail:unknown):Promise<{ status:SendStatus; detail:unknown }> {
    const attempts = await this.repositories.operations.failOperation(operation.handle, message);
    const status = Number((detail as { status?:unknown } | null)?.status);
    // Cloud refusing this file's upload or commit (a 4xx it will repeat) parks that one file;
    // the rest of the collection keeps backing up instead of stalling behind it.
    const refused = status >= 400 && status < 500 && ![401, 403, 408, 429].includes(status);
    if ((operation.op === 'upload-open' || operation.op === 'commit') && (refused || attempts >= MAX_ATTEMPTS)) {
      const session = (await this.repositories.state.sync(operation.collectionId))?.uploadSession;
      if (session) {
        await this.repositories.progress.skipVersion(operation.collectionId, session.fileId, session.versionId, message);
        await this.sessions.dropSession(operation.collectionId);
        await this.repositories.operations.completeOperation(operation.handle);
        await this.repositories.state.setStatus(operation.collectionId, 'syncing', null);
        this.loop.nudge();
        return { status: 'skipped', detail: detail ?? { error: 'cloud_sync_skipped' } };
      }
    }
    if (attempts < MAX_ATTEMPTS) {
      await this.repositories.state.setStatus(operation.collectionId, 'syncing', message);
      return { status: 'retry', detail: detail ?? { error: 'cloud_sync_retry' } };
    }
    if (operation.op === 'upload-open' || operation.op === 'commit') await this.sessions.dropSession(operation.collectionId);
    await this.repositories.operations.completeOperation(operation.handle);
    // A failed create/escrow goes back to needs-vault so the next escrow relay queues it again.
    const next = operation.op === 'create' || operation.op === 'escrow' ? 'needs-vault' : operation.op === 'info' ? 'idle' : 'error';
    await this.repositories.state.setStatus(operation.collectionId, next, message);
    return { status: 'failed', detail: detail ?? { error: 'cloud_sync_failed' } };
  }
}
