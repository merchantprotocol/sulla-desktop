// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { createHash, randomUUID } from 'node:crypto';

import type pg from 'pg';

import type { FilesCloudBroker } from '../cloudBroker.js';
import type { Config } from '../config.js';
import type { FilesKeyring } from '../keyring.js';
import type { Store } from '../store.js';
import { FilesSyncCloudApi } from './cloudApi.js';
import { CloudSignedResponseHandler, type SendStatus } from './CloudSignedResponseHandler.js';
import { CloudSyncActor } from './CloudSyncActor.js';
import { CloudSyncErrorText, HttpStatusError } from './CloudSyncErrors.js';
import { CloudSyncRepositories } from './CloudSyncRepositories.js';
import { CloudSyncScheduler, CollectionLocks } from './CloudSyncScheduler.js';
import { CloudUploadSessions } from './CloudUploadSessions.js';
import { configureCryptoModule, type CryptoModuleStatus } from './cryptoModule.js';
import { sealCollectionInfo, sealEscrowWithKey, signHead, stateHash, type TransportEnvelope } from './envelope.js';
import { EscrowTransportRequests } from './escrowTransport.js';
import { PgCloudFolderCoverageStore } from '../Repositories/CloudFolderCoverageRepository.js';
import { PgCloudPushCandidateRepository } from '../Repositories/CloudPushCandidateRepository.js';
import { PgCloudRestoreTargetRepository } from '../Repositories/CloudRestoreTargetRepository.js';
import { CloudFolderCoverage } from './folderCoverage.js';
import { CollectionRootKeyProviderSelector, LocalEscrowRootKeyProvider, OrgRootKeyProvider, type CollectionRootKeyProvider, type OrgCollectionKeySource } from './keyStore.js';
import { CloudPuller } from './pull.js';
import { CloudPushOrdering } from './pushOrdering.js';
import { CloudPusher, sha256Text } from './push.js';
import { CloudRemoteContent } from './remoteContent.js';
import { CloudRestore, RestoreError, type RestoreInput } from './restore.js';
import { CloudStagingStore } from './staging.js';
import { isUuid } from './validation.js';

export type { SendStatus } from './CloudSignedResponseHandler.js';

const BASE = '/files-sync/v1';
const LOOP_MS = 10_000;
const PULL_INTERVAL_MS = 60_000;
const PREPARE_WAIT_MS = 5_000;
const EMPTY_SHA256 = createHash('sha256').update('').digest('hex');

/**
 * Files-service half of Sulla Files cloud sync v1 (FILES-SYNC-DESIGN.md §5, §5.1, §6.1).
 *
 * Bearer work (pull, staging, chunk PUT/GET) runs in a background loop through
 * the vault broker. Device-signed mutations are queued as exact JSON text and
 * handed to main via prepare/send; Files never holds the device key.
 */
export class CloudSyncService {
  readonly cryptoModule:CryptoModuleStatus;
  readonly api:FilesSyncCloudApi;
  readonly roots:CollectionRootKeyProvider;
  private readonly repositories:CloudSyncRepositories;
  private readonly staging:CloudStagingStore;
  private readonly transport = new EscrowTransportRequests();
  private readonly puller:CloudPuller;
  private readonly pusher:CloudPusher;
  private readonly restorer:CloudRestore;
  private readonly coverage:CloudFolderCoverage;
  private readonly sessions:CloudUploadSessions;
  private readonly responses:CloudSignedResponseHandler;
  private readonly locks = new CollectionLocks();
  private readonly scheduler = new CloudSyncScheduler(() => this.runLoop(), LOOP_MS);
  private readonly lastPullAt = new Map<string, number>();

  constructor(
    private readonly db:pg.Pool,
    private readonly config:Config,
    private readonly keyring:FilesKeyring,
    private readonly store:Store,
    broker:Pick<FilesCloudBroker, 'execute'>,
    orgKeySource:OrgCollectionKeySource = { get:async() => { throw new Error('organization collection key source is not configured') } },
  ) {
    this.cryptoModule = configureCryptoModule();
    this.api = new FilesSyncCloudApi(broker);
    this.roots = new CollectionRootKeyProviderSelector(db, new LocalEscrowRootKeyProvider(keyring), new OrgRootKeyProvider(orgKeySource));
    // A live actor, never a copy of config.userId: Vault unlock re-owns Files after this is built.
    this.repositories = new CloudSyncRepositories(db, new CloudSyncActor(config));
    this.staging = new CloudStagingStore(config.dataRoot);
    this.puller = new CloudPuller(this.api, this.repositories.pull, new CloudRemoteContent(db, this.api, keyring, store), config.deviceId.slice(0, 12));
    const candidates = new PgCloudPushCandidateRepository(db);
    this.pusher = new CloudPusher(this.repositories.push, store, keyring, this.staging, new CloudPushOrdering(candidates));
    this.restorer = new CloudRestore(this.transport, this.api, new PgCloudRestoreTargetRepository(db, config, keyring, this.roots));
    this.coverage = new CloudFolderCoverage(new PgCloudFolderCoverageStore(db, candidates), line => console.log(line));
    this.sessions = new CloudUploadSessions(this.repositories, this.api, this.staging, this.roots, store);
    this.responses = new CloudSignedResponseHandler(this.repositories, this.api, this.staging, this.roots, this.sessions, {
      nudge: () => this.nudge(),
      pullSoon: collectionId => { this.lastPullAt.delete(collectionId) },
    });
  }

  start():void {
    this.scheduler.start();
    // Read-only counts first (owner-visible preview), then queue only folders Cloud never received.
    void this.coverage.previewAndBackfill()
      .then(() => this.nudge())
      .catch(error => console.warn(`[SullaFiles] cloud folder coverage check failed: ${ CloudSyncErrorText.safe(error) }`));
  }

  stop():void {
    this.scheduler.stop();
  }

  // ---- §5.1 desktop-control API ----

  finderBadges(collectionId:string) { return this.repositories.catalog.finderBadges(collectionId) }

  async status() {
    const rows = await this.repositories.catalog.statusRows();
    return {
      cryptoModule: this.cryptoModule,
      collections: rows.map(row => ({
        collectionId: row.collection_id,
        name: row.name,
        enabled: Boolean(row.enabled),
        status: row.status,
        lastSyncAt: row.last_sync_at ?? null,
        pendingBytes: Number(row.pending_bytes),
        conflicts: Number(row.conflicts),
        lastError: row.last_error ?? null,
      })),
    };
  }

  /** Human-only (main enforces the guard). On: queue `create` once the vault escrow key arrives. Off: pause, delete nothing. */
  async enable(collectionId:string, enabled:boolean):Promise<{ enabled:boolean }> {
    if (!await this.repositories.catalog.backupCandidate(collectionId)) throw new HttpStatusError(404, 'collection not found');
    return this.exclusive(collectionId, async() => {
      const existing = await this.repositories.state.sync(collectionId);
      let wrapped = existing?.wrappedRoot ?? null;
      if (enabled && !wrapped) {
        const created = await this.roots.create(collectionId, existing?.keyVersion ?? 1);
        created.root.fill(0);
        wrapped = created.wrapped;
      }
      await this.repositories.state.setEnabled(collectionId, enabled, wrapped);
      if (enabled) await this.coverage.previewAndBackfill([collectionId]);
      if (enabled) this.nudge();
      return { enabled };
    });
  }

  /** Human-only. Queues the device-signed crypto-shred of the cloud copy. Local files are untouched. */
  async deleteCloudCopy(collectionId:string):Promise<{ queued:boolean }> {
    if (!isUuid(collectionId)) throw new HttpStatusError(404, 'collection not found');
    return this.exclusive(collectionId, async() => {
      const sync = await this.repositories.state.sync(collectionId);
      if (!sync) throw new HttpStatusError(409, 'cloud backup is not set up for this collection');
      await this.sessions.dropSession(collectionId);
      await this.repositories.operations.dropCollectionOperations(collectionId, ['create', 'escrow', 'upload-open', 'commit', 'delete', 'info']);
      if (!sync.cloudCreated) {
        await this.repositories.state.markCloudDeleted(collectionId);
        return { queued: false };
      }
      // Crypto-shredding the cloud copy must never strand a chunk that only lives in Cloud.
      await this.repositories.chunks.stopEviction(collectionId);
      await this.sessions.rehydrateEvicted(collectionId);
      await this.repositories.operations.queue(collectionId, 'delete', `${ BASE }/collections/${ collectionId }`, 'DELETE', null, EMPTY_SHA256, randomUUID());
      return { queued: true };
    });
  }

  requestEscrowKey():Promise<{ requestId:string; recipientPublicKey:string }> {
    return this.transport.issue();
  }

  /**
   * Unwraps EK with the single-use pair it issued, seals each pending collection's
   * escrow, queues `create` for collections new to Cloud and `escrow` for ones
   * already there, then zeroes EK.
   */
  async acceptEscrowKey(input:{ requestId:string; transport:TransportEnvelope; vaultId:string; vaultEpoch:number }):Promise<{ queued:number }> {
    if (!isUuid(input?.vaultId) || !Number.isSafeInteger(input.vaultEpoch) || input.vaultEpoch < 1) throw new HttpStatusError(400, 'escrow key request is invalid');
    const ek = await this.transport.unwrap(input.requestId, input.transport, input.vaultId, input.vaultEpoch);
    try {
      let queued = 0;
      for (const sync of await this.repositories.state.needsEscrow(input.vaultId, input.vaultEpoch)) {
        await this.exclusive(sync.collectionId, async() => {
          const root = await this.roots.unwrap(sync.collectionId, sync.keyVersion, sync.wrappedRoot!);
          try {
            const escrow = await sealEscrowWithKey(ek, input.vaultId, input.vaultEpoch, sync.collectionId, sync.keyVersion, root);
            await this.repositories.operations.dropCollectionOperations(sync.collectionId, ['create', 'escrow']);
            const meta = { vaultId: input.vaultId, vaultEpoch: input.vaultEpoch };
            if (sync.cloudCreated) {
              const body = JSON.stringify(escrow);
              await this.repositories.operations.queue(sync.collectionId, 'escrow', `${ BASE }/collections/${ sync.collectionId }/keys/${ sync.keyVersion }`, 'PUT', body, sha256Text(body), randomUUID(), meta);
            } else {
              const head = await signHead(root, { collectionId: sync.collectionId, keyVersion: sync.keyVersion, seq: 0, stateHash: await stateHash([]), prevMac: '' });
              const body = JSON.stringify({ keyVersion: sync.keyVersion, escrow, head });
              await this.repositories.operations.queue(sync.collectionId, 'create', `${ BASE }/collections/${ sync.collectionId }?op=create`, 'PUT', body, sha256Text(body), randomUUID(), { ...meta, head });
            }
            await this.repositories.state.setStatus(sync.collectionId, 'syncing');
            queued += 1;
          } finally {
            root.fill(0);
          }
        });
      }
      return { queued };
    } finally {
      ek.fill(0);
    }
  }

  /** The oldest queued device-signed call, or null (204) when there is nothing to sign. */
  async prepare():Promise<{ handle:string; op:string; collectionId:string; sha256:string } | null> {
    let operation = await this.repositories.operations.nextOperation();
    if (!operation) {
      await Promise.race([this.kick(), this.scheduler.delay(PREPARE_WAIT_MS)]);
      operation = await this.repositories.operations.nextOperation();
    }
    if(operation && !await this.repositories.state.canWriteCollection(operation.collectionId)) {
      await this.repositories.state.setStatus(operation.collectionId, 'idle');
      return null;
    }
    return operation ? { handle: operation.handle, op: operation.op, collectionId: operation.collectionId, sha256: operation.sha256 } : null;
  }

  async send(input:{ handle:string; deviceId:string; ts:number; signature:string }):Promise<{ status:SendStatus; detail:unknown }> {
    if (!isUuid(input?.handle) || typeof input.deviceId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(input.deviceId) ||
        !Number.isSafeInteger(input.ts) || typeof input.signature !== 'string' || !/^[A-Za-z0-9+/=_-]{16,256}$/.test(input.signature)) {
      throw new HttpStatusError(400, 'send request is invalid');
    }
    const operation = await this.repositories.operations.operationByHandle(input.handle);
    if (!operation) throw new HttpStatusError(404, 'prepared operation not found');
    return this.exclusive(operation.collectionId, async() => {
      if(!await this.repositories.state.canWriteCollection(operation.collectionId)) throw new HttpStatusError(403, 'organization collection is read-only');
      const current = await this.repositories.operations.operationByHandle(input.handle);
      if (!current) return { status: 'retry' as const, detail: { error: 'operation_superseded' } };
      let response;
      try {
        response = await this.api.sendSigned({ path: current.path, method: current.method, body: current.body }, input.deviceId, input.ts, input.signature);
      } catch (error) {
        return this.responses.failed(current, CloudSyncErrorText.safe(error), undefined);
      }
      return this.responses.handleResponse(current, response.status, response.body, response.headers);
    });
  }

  // ---- §6.1 restore ----

  async cloudCollections() {
    const remote = await this.api.listCollections();
    const local = await this.repositories.catalog.localCollectionIds(remote.map(entry => String(entry?.id ?? '')));
    return {
      collections: remote.filter(entry => isUuid(entry?.id)).map(entry => ({
        collectionId: entry.id,
        status: entry.status,
        keyVersion: entry.keyVersion,
        headSeq: entry.headSeq,
        bytes: entry.bytes,
        updatedAt: entry.updatedAt,
        sourceDeviceId: entry.sourceDeviceId,
        local: local.has(entry.id),
      })),
    };
  }

  async restore(input:RestoreInput):Promise<{ restored:true; collectionId:string }> {
    try {
      const result = await this.exclusive(input?.collectionId ?? '', () => this.restorer.restore(input));
      this.lastPullAt.delete(result.collectionId);
      this.nudge();
      return result;
    } catch (error) {
      if (error instanceof RestoreError) throw new HttpStatusError(error.status, error.code);
      throw error;
    }
  }

  /**
   * New-Desktop recovery: one vault escrow key restores every Cloud collection this
   * Desktop doesn't have, under its sealed folder name. Each collection is all-or-nothing;
   * one that fails verification is reported and the rest still restore. Files then
   * download through the normal pull.
   */
  async restoreAll(input:{ requestId:string; transport:TransportEnvelope; vaultId:string; vaultEpoch:number }):Promise<{ restored:string[]; failed:Array<{ collectionId:string; error:string }> }> {
    if (!isUuid(input?.vaultId) || !isUuid(input.requestId) || !Number.isSafeInteger(input.vaultEpoch) || input.vaultEpoch < 1) throw new HttpStatusError(400, 'restore request is invalid');
    const ek = await this.transport.unwrap(input.requestId, input.transport, input.vaultId, input.vaultEpoch);
    try {
      const remote = (await this.api.listCollections()).filter(entry => isUuid(entry?.id) && entry.status === 'active');
      const local = await this.repositories.catalog.localCollectionIds(remote.map(entry => String(entry.id)));
      const restored:string[] = [];
      const failed:Array<{ collectionId:string; error:string }> = [];
      for (const entry of remote) {
        if (local.has(entry.id)) continue;
        try {
          await this.exclusive(entry.id, () => this.restorer.restoreWithKey(ek, { collectionId: entry.id, name: 'Restored files', vaultId: input.vaultId, vaultEpoch: input.vaultEpoch, info: entry.info }));
          this.lastPullAt.delete(entry.id);
          restored.push(entry.id);
        } catch (error) {
          failed.push({ collectionId: entry.id, error: error instanceof RestoreError ? error.code : 'restore_failed' });
        }
      }
      if (restored.length) this.nudge();
      return { restored, failed };
    } finally {
      ek.fill(0);
    }
  }

  // ---- background bearer work ----

  private nudge():void {
    this.scheduler.nudge();
  }

  private kick():Promise<void> {
    return this.scheduler.kick();
  }

  private exclusive<T>(collectionId:string, work:() => Promise<T>):Promise<T> {
    return this.locks.exclusive(collectionId, work);
  }

  private async runLoop():Promise<void> {
    if (!this.config.keyring?.unlocked) return;
    for (const sync of await this.repositories.state.enabledCollections().catch(() => [])) {
      if (this.scheduler.isStopped) return;
      if (this.locks.held(sync.collectionId)) continue;
      await this.exclusive(sync.collectionId, () => this.advance(sync.collectionId)).catch(() => undefined);
    }
  }

  /** One step of bearer-authenticated work for a collection. */
  private async advance(collectionId:string):Promise<void> {
    const sync = await this.repositories.state.sync(collectionId);
    if (!sync?.enabled || !sync.wrappedRoot || !sync.cloudCreated) return;
    if (await this.repositories.operations.hasOperation(collectionId)) return;
    const root = await this.roots.unwrap(collectionId, sync.keyVersion, sync.wrappedRoot);
    try {
      const lastPull = this.lastPullAt.get(collectionId) ?? 0;
      let current = sync;
      if (Date.now() - lastPull >= PULL_INTERVAL_MS || !sync.head) {
        await this.puller.pull({ collectionId, keyVersion: sync.keyVersion, lastSeq: sync.lastSeq, head: sync.head }, root);
        this.lastPullAt.set(collectionId, Date.now());
        current = (await this.repositories.state.sync(collectionId)) ?? sync;
      }
      if(!await this.repositories.state.canWriteCollection(collectionId)) {
        await this.repositories.state.setStatus(collectionId, 'idle');
        return;
      }
      const info = await this.repositories.state.staleInfoName(collectionId);
      if (info) {
        const body = JSON.stringify(await sealCollectionInfo(root, collectionId, sync.keyVersion, { v: 1, name: info.name }));
        await this.repositories.operations.queue(collectionId, 'info', `${ BASE }/collections/${ collectionId }/info`, 'PUT', body, sha256Text(body), randomUUID(), { nameSha: info.sha });
        return;
      }
      if (sync.uploadSession) {
        await this.sessions.continueUpload(sync, sync.uploadSession, root);
        return;
      }
      let session;
      try {
        session = await this.pusher.stage(current, root);
      } catch (error) {
        // A file that can't be read or sealed locally is parked; the next pass moves on.
        const candidate = this.pusher.lastCandidate;
        if (!candidate) throw error;
        await this.staging.clear(collectionId);
        await this.repositories.progress.skipVersion(collectionId, candidate.fileId, candidate.versionId, CloudSyncErrorText.safe(error));
        await this.repositories.state.setStatus(collectionId, 'syncing', null);
        this.nudge();
        return;
      }
      if (!session) {
        await this.repositories.state.setStatus(collectionId, 'idle');
        return;
      }
      if (session.declared.length) {
        await this.repositories.state.saveSession(collectionId, session, this.sessions.pendingBytes(session), 'syncing');
        const body = JSON.stringify({ chunks: session.declared });
        await this.repositories.operations.queue(collectionId, 'upload-open', `${ BASE }/collections/${ collectionId }/uploads`, 'POST', body, sha256Text(body), randomUUID());
      } else {
        session.uploadId = null;
        await this.repositories.state.saveSession(collectionId, session, 0, 'syncing');
        await this.sessions.queueCommit(current, session, root);
      }
    } catch (error) {
      await this.repositories.state.setStatus(collectionId, 'error', CloudSyncErrorText.safe(error)).catch(() => undefined);
    } finally {
      root.fill(0);
    }
  }
}
