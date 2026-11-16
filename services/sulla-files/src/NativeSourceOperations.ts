// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { createHash, randomUUID } from 'node:crypto';

import { TransactionRunner } from './FilesTransaction.js';
import { NativeSourceOperationRepository } from './Repositories/NativeSourceOperationRepository.js';
import { lockStoredNamespace } from './storedNamespace.js';

import type { FilesIdentity } from './auth.js';
import type pg from 'pg';

export interface NativeSourceOperationInput {
  operationId: string;
  handle: string;
  sourceRevision: string;
  fileId?: string;
  baseVersionId?: string;
  desiredHash: string;
  collectionId?: string;
  path?: string;
}

export interface NativeSourceIngestResult {
  id: string;
  current_version_id: string;
  path: string;
  mime: string;
  size: number;
}

export interface NativePublicationAction {
  operationId: string;
  handle: string;
  sourceRevision: string;
  sourceHash: string;
  desiredHash: string;
  fileId: string;
  baseVersionId: string;
  versionId: string;
  state: 'publishing' | 'recovery-required';
}

export interface NativePublicationCompletionProof {
  nextSourceRevision: string;
  originalSourceRevision: string;
  originalSourceHash: string;
  currentSourceHash: string;
  filesBaseVersionId: string;
  currentFilesVersionId: string;
}

export interface FuseTrackedFile {
  id: string; collectionId: string; path: string; mime: string; size: number;
  versionId: string; sourceHash: string; mtimeMs: number;
}

export type NativeFuseRow = FuseTrackedFile & { native?:boolean; storedNativeConflict?:boolean; sourceRevision?:string; sourceHandle?:string };

/** What the manager lends this service: its single-flight serializer and the FUSE row lookup. */
export interface NativeSourceHost {
  serial<T>(operation:()=>Promise<T>):Promise<T>;
  fuseRow(fileId:string):Promise<NativeFuseRow>;
}

const status = (message:string, code:number, extra:Record<string, unknown> = {}) => Object.assign(new Error(message), { status: code, ...extra });

/**
 * Ingest and publication custody for Electron-brokered native sources. Files keeps only the opaque
 * handle and verification hashes; every transition is an idempotent durable operation row so a
 * restart can prove which side (source or Files) moved.
 */
export class NativeSourceOperations {
  constructor(
    private readonly db:pg.Pool,
    private readonly host:NativeSourceHost,
    private readonly repository = new NativeSourceOperationRepository(db),
    private readonly transactions = new TransactionRunner(db),
    private readonly publicationDeadlineMs = 30_000,
  ) {}

  async ingest(input:NativeSourceOperationInput, ingest:(client:pg.PoolClient, versionId:string)=>Promise<NativeSourceIngestResult>):Promise<NativeSourceIngestResult> {
    const versionId = randomUUID();
    return this.host.serial(async() => {
      const existing = await this.repository.find(input.operationId);
      if (existing) {
        if (existing.direction !== 'ingest' || existing.source_handle !== input.handle || existing.source_revision !== input.sourceRevision ||
            existing.files_base_version_id !== (input.baseVersionId ?? null) || existing.desired_hash !== input.desiredHash) {
          throw status('Native source operation id was reused with different immutable inputs', 409);
        }
        if (existing.state === 'completed' && existing.file_id && existing.files_version_id) {
          const file = await this.repository.findFileAtVersion(existing.file_id, existing.files_version_id);
          if (file) return file;
        }
      } else await this.repository.planIngest(input, versionId);
      const operation = await this.repository.find(input.operationId);
      if (operation.state !== 'planned') throw status('Native source ingestion requires reconciliation before it can be retried', 409);
      try {
        return await this.transactions.run('native-source-ingest', async client => {
          if (!input.collectionId) throw status('Native source collection is required', 400);
          await lockStoredNamespace(client, input.collectionId);
          await this.repository.lockSourceHandle(client, input.handle);
          if (input.fileId) {
            const file = await this.repository.lockFileVersion(client, input.fileId);
            if (file?.current_version_id !== (input.baseVersionId ?? null)) throw status('Files base version changed before native source ingestion', 409);
          }
          const result = await ingest(client, operation.files_version_id);
          if (!input.collectionId || !input.path) throw status('Native source collection and display path are required', 400);
          await this.repository.activateSource(client, { handle: input.handle, collectionId: input.collectionId, fileId: result.id, path: input.path, sourceRevision: input.sourceRevision, desiredHash: input.desiredHash });
          if (await this.repository.completeIngest(client, input.operationId, result.id, result.current_version_id) !== 1) {
            throw status('Native source ingestion operation changed while it was committing', 409);
          }
          return result;
        });
      } catch (error) {
        await this.repository.recordError(input.operationId, error instanceof Error ? error.message : String(error)).catch(() => undefined);
        throw error;
      }
    });
  }

  async planPublication(input:NativeSourceOperationInput & { fileId:string; baseVersionId:string }):Promise<void> {
    await this.repository.planPublication(input);
    const row = await this.repository.find(input.operationId);
    const matches = row?.direction === 'publish' && row.source_handle === input.handle && row.source_revision === input.sourceRevision &&
      row.file_id === input.fileId && row.files_base_version_id === input.baseVersionId && row.desired_hash === input.desiredHash;
    if (!matches) throw status('Native source publication id was reused with different immutable inputs', 409);
  }

  async finishPublication(operationId:string, proof?:NativePublicationCompletionProof, error?:string):Promise<void> {
    if (!proof) {
      if (await this.repository.markPublicationRecoveryRequired(operationId, error ?? 'Native publication outcome requires reconciliation') === 1) return;
      const operation = await this.repository.directionAndState(operationId);
      if (operation?.direction !== 'publish') throw status('Native source publication is unknown', 404);
      if (operation.state === 'recovery-required') return;
      throw status('Native source publication is not in a completable state', 409);
    }
    const outcome = await this.transactions.run('native-publication-finish', async client => {
      const identity = await this.repository.publicationIdentity(client, operationId);
      if (identity?.direction !== 'publish' || !identity.file_id) throw status('Native source publication is unknown', 404);
      // Match fuseWriteNative's file -> source lock order. The completion proof,
      // current Files version, and current source identity are then one atomic
      // decision; neither a new FUSE commit nor a reselection can slip between
      // validation and activation.
      const file = await this.repository.lockFileVersion(client, identity.file_id);
      const source = await this.repository.lockSource(client, identity.file_id);
      const operation = await this.repository.lockOperation(client, operationId);
      if (operation.state === 'completed' && proof.nextSourceRevision === operation.next_source_revision) return 'done';
      const exactProof = proof.originalSourceRevision === operation.source_revision && proof.originalSourceHash === operation.source_hash &&
        proof.currentSourceHash === operation.desired_hash && proof.filesBaseVersionId === operation.files_base_version_id &&
        proof.currentFilesVersionId === operation.files_version_id;
      if (!exactProof) throw status('Native publication acknowledgement does not match its durable source and Files identities', 409);
      if (file?.current_version_id !== operation.files_version_id) {
        // Committed before the error below: the recovery marker must survive the rejection.
        await this.repository.markFilesAdvanced(client, operationId, proof.nextSourceRevision);
        return 'files-advanced';
      }
      const directlyBound = source?.state === 'active' && source.source_handle === operation.source_handle &&
        source.source_revision === operation.source_revision && source.source_hash === operation.source_hash;
      const recoveryBound = ['active', 'reselect-required'].includes(source?.state) && source.source_hash === operation.source_hash &&
        source.source_revision === proof.nextSourceRevision && source.recovery?.publicationOperationId === operationId;
      if (!directlyBound && !recoveryBound) throw status('Native publication acknowledgement no longer matches the selected source identity', 409);
      const activated = await this.repository.advanceSource(client, { fileId: identity.file_id, nextSourceRevision: proof.nextSourceRevision, desiredHash: operation.desired_hash,
        handle: source.source_handle, sourceRevision: source.source_revision, sourceHash: source.source_hash });
      const completed = await this.repository.completePublication(client, operationId, proof.nextSourceRevision);
      if (activated !== 1 || completed !== 1) throw status('Native source publication changed while it was committing', 409);
      return 'done';
    });
    if (outcome === 'files-advanced') throw status('Files advanced during native publication; the source outcome requires reconciliation', 409);
  }

  async reselectInterruptedPublication(input:{ fileId:string; previousHandle:string; handle:string; sourceRevision:string; sourceHash:string }):Promise<boolean> {
    if (input.handle === input.previousHandle) throw status('Interrupted publication recovery requires a new source handle', 409);
    return this.transactions.run('native-publication-reselect', async client => {
      const file = await this.repository.lockFileVersion(client, input.fileId);
      const source = await this.repository.lockSource(client, input.fileId);
      if (source?.state !== 'reselect-required' || source.source_handle !== input.previousHandle) return false;
      const boundOperationId = typeof source.recovery?.publicationOperationId === 'string' ? source.recovery.publicationOperationId : null;
      const operations = await this.repository.lockRecoveryPublications(client, input.fileId, boundOperationId);
      const candidates = operations.filter(operation => operation.source_hash === source.source_hash && operation.desired_hash === input.sourceHash &&
        operation.files_version_id === file?.current_version_id && (boundOperationId
          ? source.source_revision === input.sourceRevision
          : operation.source_revision === source.source_revision));
      if (candidates.length !== 1) return false;
      const operation = candidates[0];
      await this.repository.rebindSource(client, { fileId: input.fileId, handle: input.handle, sourceRevision: input.sourceRevision,
        operationId: operation.operation_id, originalHandle: operation.source_handle, previousHandle: input.previousHandle });
      return true;
    });
  }

  async finishPublicationConflict(operationId:string, input:{ conflictFileId:string; currentSourceRevision:string; currentSourceHash:string; currentFilesVersionId:string }):Promise<void> {
    if (await this.repository.completeAsConflict(operationId, input) !== 1) throw status('Native conflict recovery did not match both source and Files outcomes', 409);
  }

  async publicationActions():Promise<NativePublicationAction[]> {
    return (await this.repository.pendingPublications()).map(row => ({
      operationId:    row.operation_id,
      handle:         row.source_handle,
      sourceRevision: row.source_revision,
      sourceHash:     row.source_hash,
      desiredHash:    row.desired_hash,
      fileId:         row.file_id,
      baseVersionId:  row.files_base_version_id,
      versionId:      row.files_version_id,
      state:          row.state,
    }));
  }

  revalidateSessions(handles:string[], replaceExisting = true):Promise<void> { return this.repository.revalidateSessions(handles, replaceExisting) }

  reconcileAfterRestart():Promise<void> { return this.repository.reconcileAfterRestart() }

  async fuseWrite(
    fileId:string, expectedVersionId:string, expectedSourceHash:string, bytes:Buffer, actor:FilesIdentity,
    ingest:(client:pg.PoolClient, versionId:string, current:FuseTrackedFile)=>Promise<NativeSourceIngestResult>,
    preserveConflict:(client:pg.PoolClient, versionId:string, current:FuseTrackedFile)=>Promise<NativeSourceIngestResult>,
  ):Promise<FuseTrackedFile> {
    const desiredHash = createHash('sha256').update(bytes).digest('hex');
    const operationId = randomUUID();
    let staleConflict:NativeSourceIngestResult | undefined;
    await this.host.serial(async() => {
      const current = await this.host.fuseRow(fileId);
      if (!current.native || !current.sourceHandle || !current.sourceRevision) throw status('Native source is unavailable', 404);
      const versionId = randomUUID();
      await this.transactions.run('native-fuse-write', async client => {
        await lockStoredNamespace(client, current.collectionId);
        await this.repository.lockSourceHandle(client, current.sourceHandle!);
        const locked = await this.repository.lockFileVersion(client, fileId);
        const source = await this.repository.lockSourceState(client, fileId);
        if (current.versionId !== expectedVersionId || current.sourceHash !== expectedSourceHash ||
            locked?.current_version_id !== expectedVersionId || source?.source_hash !== expectedSourceHash || source?.state !== 'active') {
          staleConflict = await preserveConflict(client, versionId, current);
          await this.repository.recordStaleConflict(client, staleConflict.id, fileId, desiredHash);
          return;
        }
        const result = desiredHash === current.sourceHash ? { current_version_id: current.versionId } : await ingest(client, versionId, current);
        await this.repository.planFusePublication(client, { operationId, handle: current.sourceHandle!, sourceRevision: current.sourceRevision!, sourceHash: current.sourceHash,
          fileId, baseVersionId: expectedVersionId, versionId: result.current_version_id, desiredHash, actor: actor.deviceId || 'files' });
      });
    });
    if (staleConflict) {
      throw status('Native source or Files base version changed; the FUSE bytes were preserved as a visible conflict', 409, { recovery: { action: 'visible-conflict', conflictFileId: staleConflict.id } });
    }
    const deadline = Date.now() + this.publicationDeadlineMs;
    while (Date.now() < deadline) {
      const operation = await this.repository.publicationProgress(operationId);
      if (operation?.state === 'completed') {
        if (operation.recovery?.action === 'visible-conflict') throw status('Native source changed; both versions are visible in Files', 409, { recovery: operation.recovery });
        return this.host.fuseRow(fileId);
      }
      if (operation?.state === 'recovery-required') throw status(operation.last_error ?? 'Native publication requires recovery', 409, { recovery: operation.recovery });
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    await this.repository.expirePublication(operationId);
    throw status('Native publication did not complete before the durability deadline', 503);
  }
}
