import { createHash, randomUUID } from 'node:crypto';

import type pg from 'pg';

import type { FilesIdentity } from '../auth.js';
import type { FilesCloudBroker } from '../cloudBroker.js';
import type { Config } from '../config.js';
import type { FilesKeyring } from '../keyring.js';
import type { Store } from '../store.js';
import { openCloudChunk } from './chunkSource.js';
import { FilesSyncCloudApi } from './cloudApi.js';
import { configureCryptoModule, type CryptoModuleStatus } from './cryptoModule.js';
import { sealEscrowWithKey, signHead, stateHash, verifyHead, type SyncHead, type TransportEnvelope } from './envelope.js';
import { EscrowTransportRequests } from './escrowTransport.js';
import { CloudRootKeyStore } from './keyStore.js';
import { CloudPuller } from './pull.js';
import { buildCommit, CloudPusher, sha256Text } from './push.js';
import { CloudRemoteContent } from './remoteContent.js';
import { PgCloudSyncRepository, type QueuedOperation, type SyncRow, type UploadSession } from './repository.js';
import { CloudRestore, RestoreError, type RestoreInput, type RestoreTarget } from './restore.js';
import { CloudStagingStore } from './staging.js';
import { isUuid } from './validation.js';

const BASE = '/files-sync/v1';
const LOOP_MS = 10_000;
const PULL_INTERVAL_MS = 60_000;
const PREPARE_WAIT_MS = 5_000;
const MAX_ATTEMPTS = 5;
const EMPTY_SHA256 = createHash('sha256').update('').digest('hex');

export type SendStatus = 'sent' | 'conflict' | 'retry' | 'failed';

class HttpStatusError extends Error {
  constructor(readonly status:number, message:string) { super(message) }
}

/** Error text kept in status/last_error. Never carries paths, names, keys or bodies. */
function safeError(error:unknown):string {
  const code = (error as { code?:unknown })?.code;
  if (code === 'FILE_OFFLINE') return 'Sulla Cloud is unreachable';
  if (code === 'FILES_SYNC_INTEGRITY' || code === 'FILE_INTEGRITY') return `Integrity check failed: ${ String((error as Error).message).slice(0, 200) }`;
  return 'Cloud backup step failed';
}

function delay(ms:number):Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms).unref());
}

/** Restore's local writes: a new Files collection with its own local keys, then the wrapped sync root. */
class PgRestoreTarget implements RestoreTarget {
  constructor(
    private readonly db:pg.Pool,
    private readonly config:Config,
    private readonly keyring:FilesKeyring,
    private readonly roots:CloudRootKeyStore,
  ) {}

  async localRoot(collectionId:string):Promise<{ keyVersion:number; root:Buffer | null } | null> {
    const row = (await this.db.query(`SELECT c.id,s.key_version,s.wrapped_root FROM collections c
      LEFT JOIN files_cloud_sync s ON s.collection_id=c.id WHERE c.id=$1`, [collectionId])).rows[0];
    if (!row) return null;
    if (!row.wrapped_root) return { keyVersion: Number(row.key_version ?? 1), root: null };
    return { keyVersion: Number(row.key_version), root: await this.roots.unwrap(collectionId, Number(row.key_version), row.wrapped_root) };
  }

  async createCollection(collectionId:string, name:string):Promise<void> {
    const explorerPath = `${ name.replace(/[\\/]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Restored files' }--${ collectionId.slice(0, 8) }`;
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO collections(id,org_id,owner_user_id,name,kind,home,encrypted_data_key,dedup_key_ciphertext,retention_policy,explorer_path)
        VALUES($1,$2,$3,$4,'knowledge','synced',$5,$6,'{}',$7)`, [collectionId, this.config.orgId ?? null, this.config.userId, name, {}, {}, explorerPath]);
      const wrapped = await this.keyring.create(collectionId, client);
      await client.query('UPDATE collections SET encrypted_data_key=$2,dedup_key_ciphertext=$3 WHERE id=$1', [collectionId, wrapped.data, wrapped.dedup]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async install(collectionId:string, keyVersion:number, root:Uint8Array, vaultId:string, vaultEpoch:number):Promise<void> {
    const wrapped = await this.roots.wrap(collectionId, keyVersion, root);
    await this.db.query(`INSERT INTO files_cloud_sync(collection_id,enabled,key_version,wrapped_root,status,cloud_created,escrow_vault_id,escrow_vault_epoch,last_seq,head)
      VALUES($1,TRUE,$2,$3,'idle',TRUE,$4,$5,0,NULL)
      ON CONFLICT(collection_id) DO UPDATE SET enabled=TRUE,key_version=EXCLUDED.key_version,wrapped_root=EXCLUDED.wrapped_root,status='idle',
        cloud_created=TRUE,escrow_vault_id=EXCLUDED.escrow_vault_id,escrow_vault_epoch=EXCLUDED.escrow_vault_epoch,last_error=NULL,updated_at=NOW()`,
    [collectionId, keyVersion, wrapped, vaultId, vaultEpoch]);
    await this.db.query("INSERT INTO file_sync_cursors(collection_id,device_id) VALUES($1,'cloud') ON CONFLICT DO NOTHING", [collectionId]);
  }
}

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
  readonly roots:CloudRootKeyStore;
  private readonly repository:PgCloudSyncRepository;
  private readonly staging:CloudStagingStore;
  private readonly transport = new EscrowTransportRequests();
  private readonly puller:CloudPuller;
  private readonly pusher:CloudPusher;
  private readonly restorer:CloudRestore;
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly lastPullAt = new Map<string, number>();
  private loop?:Promise<void>;
  private rerun = false;
  private timer?:NodeJS.Timeout;
  private stopped = true;

  constructor(
    private readonly db:pg.Pool,
    private readonly config:Config,
    private readonly keyring:FilesKeyring,
    private readonly store:Store,
    broker:Pick<FilesCloudBroker, 'execute'>,
  ) {
    this.cryptoModule = configureCryptoModule();
    this.api = new FilesSyncCloudApi(broker);
    this.roots = new CloudRootKeyStore(keyring);
    const actor:FilesIdentity = { userId: config.userId, deviceId: config.deviceId, kind: 'capability', orgId: config.orgId };
    this.repository = new PgCloudSyncRepository(db, actor);
    this.staging = new CloudStagingStore(config.dataRoot);
    this.puller = new CloudPuller(this.api, this.repository, new CloudRemoteContent(db, this.api, keyring, store), config.deviceId.slice(0, 12));
    this.pusher = new CloudPusher(this.repository, store, keyring, this.staging);
    this.restorer = new CloudRestore(this.transport, this.api, new PgRestoreTarget(db, config, keyring, this.roots));
  }

  start():void {
    this.stopped = false;
    this.schedule(LOOP_MS);
  }

  stop():void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  // ---- §5.1 desktop-control API ----

  async status() {
    const rows = await this.repository.statusRows();
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
    if (!await this.repository.backupCandidate(collectionId)) throw new HttpStatusError(404, 'collection not found');
    return this.exclusive(collectionId, async() => {
      const existing = await this.repository.sync(collectionId);
      let wrapped = existing?.wrappedRoot ?? null;
      if (enabled && !wrapped) {
        const created = await this.roots.create(collectionId, existing?.keyVersion ?? 1);
        created.root.fill(0);
        wrapped = created.wrapped;
      }
      await this.repository.setEnabled(collectionId, enabled, wrapped);
      if (enabled) this.nudge();
      return { enabled };
    });
  }

  /** Human-only. Queues the device-signed crypto-shred of the cloud copy. Local files are untouched. */
  async deleteCloudCopy(collectionId:string):Promise<{ queued:boolean }> {
    if (!isUuid(collectionId)) throw new HttpStatusError(404, 'collection not found');
    return this.exclusive(collectionId, async() => {
      const sync = await this.repository.sync(collectionId);
      if (!sync) throw new HttpStatusError(409, 'cloud backup is not set up for this collection');
      await this.dropSession(collectionId);
      await this.repository.dropCollectionOperations(collectionId, ['create', 'escrow', 'upload-open', 'commit', 'delete']);
      if (!sync.cloudCreated) {
        await this.repository.markCloudDeleted(collectionId);
        return { queued: false };
      }
      // Crypto-shredding the cloud copy must never strand a chunk that only lives in Cloud.
      await this.repository.stopEviction(collectionId);
      await this.rehydrateEvicted(collectionId);
      await this.repository.queue(collectionId, 'delete', `${ BASE }/collections/${ collectionId }`, 'DELETE', null, EMPTY_SHA256, randomUUID());
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
      for (const sync of await this.repository.needsEscrow(input.vaultId, input.vaultEpoch)) {
        await this.exclusive(sync.collectionId, async() => {
          const root = await this.roots.unwrap(sync.collectionId, sync.keyVersion, sync.wrappedRoot!);
          try {
            const escrow = await sealEscrowWithKey(ek, input.vaultId, input.vaultEpoch, sync.collectionId, sync.keyVersion, root);
            await this.repository.dropCollectionOperations(sync.collectionId, ['create', 'escrow']);
            const meta = { vaultId: input.vaultId, vaultEpoch: input.vaultEpoch };
            if (sync.cloudCreated) {
              const body = JSON.stringify(escrow);
              await this.repository.queue(sync.collectionId, 'escrow', `${ BASE }/collections/${ sync.collectionId }/keys/${ sync.keyVersion }`, 'PUT', body, sha256Text(body), randomUUID(), meta);
            } else {
              const head = await signHead(root, { collectionId: sync.collectionId, keyVersion: sync.keyVersion, seq: 0, stateHash: await stateHash([]), prevMac: '' });
              const body = JSON.stringify({ keyVersion: sync.keyVersion, escrow, head });
              await this.repository.queue(sync.collectionId, 'create', `${ BASE }/collections/${ sync.collectionId }?op=create`, 'PUT', body, sha256Text(body), randomUUID(), { ...meta, head });
            }
            await this.repository.setStatus(sync.collectionId, 'syncing');
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
    let operation = await this.repository.nextOperation();
    if (!operation) {
      await Promise.race([this.kick(), delay(PREPARE_WAIT_MS)]);
      operation = await this.repository.nextOperation();
    }
    return operation ? { handle: operation.handle, op: operation.op, collectionId: operation.collectionId, sha256: operation.sha256 } : null;
  }

  async send(input:{ handle:string; deviceId:string; ts:number; signature:string }):Promise<{ status:SendStatus; detail:unknown }> {
    if (!isUuid(input?.handle) || typeof input.deviceId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(input.deviceId) ||
        !Number.isSafeInteger(input.ts) || typeof input.signature !== 'string' || !/^[A-Za-z0-9+/=_-]{16,256}$/.test(input.signature)) {
      throw new HttpStatusError(400, 'send request is invalid');
    }
    const operation = await this.repository.operationByHandle(input.handle);
    if (!operation) throw new HttpStatusError(404, 'prepared operation not found');
    return this.exclusive(operation.collectionId, async() => {
      const current = await this.repository.operationByHandle(input.handle);
      if (!current) return { status: 'retry' as const, detail: { error: 'operation_superseded' } };
      let response;
      try {
        response = await this.api.sendSigned({ path: current.path, method: current.method, body: current.body }, input.deviceId, input.ts, input.signature);
      } catch (error) {
        return this.failed(current, safeError(error), undefined);
      }
      return this.handleResponse(current, response.status, response.body);
    });
  }

  // ---- §6.1 restore ----

  async cloudCollections() {
    const remote = await this.api.listCollections();
    const local = await this.repository.localCollectionIds(remote.map(entry => String(entry?.id ?? '')));
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

  // ---- signed responses ----

  private async handleResponse(operation:QueuedOperation, status:number, body:any):Promise<{ status:SendStatus; detail:unknown }> {
    const collectionId = operation.collectionId;
    const ok = status >= 200 && status < 300;
    if (status === 401 || status === 403) {
      // Stale timestamp or signature problems are fixed by re-signing; main retries with backoff.
      return this.failed(operation, 'Sulla Cloud rejected the device signature', { status, error: body?.error });
    }
    switch (operation.op) {
      case 'create': {
        const meta = operation.meta as { head:SyncHead; vaultId:string; vaultEpoch:number };
        if (ok) {
          await this.repository.markCreated(collectionId, meta.head, meta.vaultId, meta.vaultEpoch);
          await this.repository.completeOperation(operation.handle);
          this.nudge();
          return { status: 'sent', detail: { collectionId } };
        }
        if (status === 409 && body?.error === 'collection_exists') return this.adoptExistingCollection(operation);
        break;
      }
      case 'escrow': {
        const meta = operation.meta as { vaultId:string; vaultEpoch:number };
        if (ok) {
          await this.repository.markEscrowed(collectionId, meta.vaultId, meta.vaultEpoch);
          await this.repository.completeOperation(operation.handle);
          return { status: 'sent', detail: { collectionId } };
        }
        break;
      }
      case 'upload-open': {
        if (ok && typeof body?.uploadId === 'string' && isUuid(body.uploadId)) {
          const sync = await this.repository.sync(collectionId);
          const session = sync?.uploadSession;
          if (session) {
            const missing = new Set(Array.isArray(body.missing) ? body.missing : []);
            session.uploadId = body.uploadId;
            session.present = session.declared.map(chunk => chunk.id).filter(id => !missing.has(id));
            await this.repository.saveSession(collectionId, session, this.pendingBytes(session, missing), 'syncing');
          }
          await this.repository.completeOperation(operation.handle);
          this.nudge();
          return { status: 'sent', detail: { collectionId } };
        }
        if (status === 507) {
          await this.dropSession(collectionId);
          await this.repository.completeOperation(operation.handle);
          await this.repository.setStatus(collectionId, 'error', 'Sulla Cloud backup storage is full');
          return { status: 'failed', detail: { error: 'quota_exceeded' } };
        }
        break;
      }
      case 'commit':
        return this.handleCommitResponse(operation, status, body);
      case 'delete': {
        if (ok || status === 404) {
          await this.staging.clear(collectionId);
          await this.repository.markCloudDeleted(collectionId);
          await this.repository.completeOperation(operation.handle);
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
      const sync = await this.repository.sync(collectionId);
      const session = sync?.uploadSession;
      const head = operation.meta.head as SyncHead;
      if (!session || Number(body.seq) !== head.seq) {
        // The commit landed but local bookkeeping is gone; the next pull reconciles it.
        await this.repository.completeOperation(operation.handle);
        this.lastPullAt.delete(collectionId);
        return { status: 'sent', detail: { collectionId } };
      }
      await this.repository.finishCommit(collectionId, session, head);
      await this.repository.completeOperation(operation.handle);
      await this.adoptPresentCopies(sync!, session);
      await this.staging.clear(collectionId);
      this.nudge();
      return { status: 'sent', detail: { collectionId, seq: head.seq } };
    }
    if (status === 409 && (body?.error === 'head_moved' || body?.error === 'file_conflict')) {
      // Drop the stale commit and its upload; the next pass pulls (forking unpushed edits) and re-stages.
      await this.dropSession(collectionId);
      await this.repository.completeOperation(operation.handle);
      this.lastPullAt.delete(collectionId);
      this.nudge();
      return { status: 'conflict', detail: { error: body.error } };
    }
    if (status === 422 && body?.error === 'missing_chunks') {
      const missing = Array.isArray(body.missing) ? body.missing.filter((id:unknown):id is string => typeof id === 'string') : [];
      await this.repository.forgetUpload(collectionId, missing);
      await this.dropSession(collectionId);
      await this.repository.completeOperation(operation.handle);
      this.nudge();
      return { status: 'retry', detail: { error: 'missing_chunks' } };
    }
    return this.failed(operation, `Sulla Cloud returned ${ status }`, { status, error: typeof body?.error === 'string' ? body.error : undefined });
  }

  /** `create` hit an existing collection: adopt it only if its head was signed with our root. */
  private async adoptExistingCollection(operation:QueuedOperation):Promise<{ status:SendStatus; detail:unknown }> {
    const collectionId = operation.collectionId;
    const sync = await this.repository.sync(collectionId);
    const meta = operation.meta as { vaultId:string; vaultEpoch:number };
    if (!sync?.wrappedRoot) return this.failed(operation, 'Cloud backup is not set up for this collection', undefined);
    const root = await this.roots.unwrap(collectionId, sync.keyVersion, sync.wrappedRoot);
    try {
      const page = await this.api.changes(collectionId, 0, 1);
      if (page.head.collectionId !== collectionId || page.head.keyVersion !== sync.keyVersion || !await verifyHead(root, page.head)) {
        await this.repository.completeOperation(operation.handle);
        await this.repository.setStatus(collectionId, 'error', 'This collection already has a different cloud backup; restore it instead');
        return { status: 'failed', detail: { error: 'collection_exists' } };
      }
      await this.repository.adoptExisting(collectionId, meta.vaultId, meta.vaultEpoch);
      await this.repository.completeOperation(operation.handle);
      this.nudge();
      return { status: 'sent', detail: { collectionId, adopted: true } };
    } catch (error) {
      return this.failed(operation, safeError(error), undefined);
    } finally {
      root.fill(0);
    }
  }

  private async failed(operation:QueuedOperation, message:string, detail:unknown):Promise<{ status:SendStatus; detail:unknown }> {
    const attempts = await this.repository.failOperation(operation.handle, message);
    if (attempts < MAX_ATTEMPTS) {
      await this.repository.setStatus(operation.collectionId, 'syncing', message);
      return { status: 'retry', detail: detail ?? { error: 'cloud_sync_retry' } };
    }
    if (operation.op === 'upload-open' || operation.op === 'commit') await this.dropSession(operation.collectionId);
    await this.repository.completeOperation(operation.handle);
    // A failed create/escrow goes back to needs-vault so the next escrow relay queues it again.
    const next = operation.op === 'create' || operation.op === 'escrow' ? 'needs-vault' : 'error';
    await this.repository.setStatus(operation.collectionId, next, message);
    return { status: 'failed', detail: detail ?? { error: 'cloud_sync_failed' } };
  }

  // ---- background bearer work ----

  private nudge():void {
    this.schedule(0);
  }

  private schedule(ms:number):void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.kick();
    }, ms);
    this.timer.unref();
  }

  /** Starts a pass now (or marks the running one to repeat) and returns it. */
  private kick():Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.loop) {
      this.rerun = true;
      return this.loop;
    }
    this.loop = this.runLoop().finally(() => {
      this.loop = undefined;
      const again = this.rerun;
      this.rerun = false;
      this.schedule(again ? 0 : LOOP_MS);
    });
    return this.loop;
  }

  private async runLoop():Promise<void> {
    if (!this.config.keyring?.unlocked) return;
    for (const sync of await this.repository.enabledCollections().catch(() => [])) {
      if (this.stopped) return;
      if (this.locks.has(sync.collectionId)) continue;
      await this.exclusive(sync.collectionId, () => this.advance(sync.collectionId)).catch(() => undefined);
    }
  }

  /** One step of bearer-authenticated work for a collection. */
  private async advance(collectionId:string):Promise<void> {
    const sync = await this.repository.sync(collectionId);
    if (!sync?.enabled || !sync.wrappedRoot || !sync.cloudCreated) return;
    if (await this.repository.hasOperation(collectionId)) return;
    const root = await this.roots.unwrap(collectionId, sync.keyVersion, sync.wrappedRoot);
    try {
      if (sync.uploadSession) {
        await this.continueUpload(sync, sync.uploadSession, root);
        return;
      }
      const lastPull = this.lastPullAt.get(collectionId) ?? 0;
      let current = sync;
      if (Date.now() - lastPull >= PULL_INTERVAL_MS || !sync.head) {
        await this.puller.pull({ collectionId, keyVersion: sync.keyVersion, lastSeq: sync.lastSeq, head: sync.head }, root);
        this.lastPullAt.set(collectionId, Date.now());
        current = (await this.repository.sync(collectionId)) ?? sync;
      }
      const session = await this.pusher.stage(current, root);
      if (!session) {
        await this.repository.setStatus(collectionId, 'idle');
        return;
      }
      if (session.declared.length) {
        await this.repository.saveSession(collectionId, session, this.pendingBytes(session), 'syncing');
        const body = JSON.stringify({ chunks: session.declared });
        await this.repository.queue(collectionId, 'upload-open', `${ BASE }/collections/${ collectionId }/uploads`, 'POST', body, sha256Text(body), randomUUID());
      } else {
        session.uploadId = null;
        await this.repository.saveSession(collectionId, session, 0, 'syncing');
        await this.queueCommit(current, session, root);
      }
    } catch (error) {
      await this.repository.setStatus(collectionId, 'error', safeError(error)).catch(() => undefined);
    } finally {
      root.fill(0);
    }
  }

  /** Resumable chunk upload: ask the server what is still missing, PUT those wires, then queue the commit. */
  private async continueUpload(sync:SyncRow, session:UploadSession, root:Uint8Array):Promise<void> {
    const collectionId = sync.collectionId;
    if (!session.uploadId) {
      await this.dropSession(collectionId);
      return;
    }
    const remote = await this.api.uploadStatus(session.uploadId);
    if (!remote) {
      await this.dropSession(collectionId);
      return;
    }
    const staged = new Set(session.staged);
    for (const id of remote.missing) {
      if (!staged.has(id)) {
        // A chunk we thought Cloud held is gone; forget it so the next staging re-seals it.
        await this.repository.forgetUpload(collectionId, [id]);
        await this.dropSession(collectionId);
        return;
      }
      let wire:Buffer;
      try {
        wire = await this.staging.get(collectionId, id);
      } catch {
        await this.dropSession(collectionId);
        return;
      }
      const status = await this.api.putChunk(session.uploadId, id, wire);
      if (status === 200 || status === 201) {
        await this.repository.markUploaded(collectionId, id);
      } else if (status === 409) {
        // Cloud already holds different bytes for this id; verify and adopt them after the commit.
        if (!session.present.includes(id)) session.present.push(id);
      } else if (status === 404 || status === 410) {
        await this.dropSession(collectionId);
        return;
      } else {
        throw Object.assign(new Error(`Chunk upload failed (${ status })`), { status });
      }
    }
    await this.repository.saveSession(collectionId, session, 0, 'syncing');
    await this.queueCommit(sync, session, root);
  }

  private async queueCommit(sync:SyncRow, session:UploadSession, root:Uint8Array):Promise<void> {
    const commit = await buildCommit(sync, session, await this.repository.cloudHeads(sync.collectionId), root);
    await this.repository.queue(sync.collectionId, 'commit', `${ BASE }/collections/${ sync.collectionId }/commit`, 'POST', commit.body, commit.sha256, randomUUID(), { head: commit.head });
  }

  /**
   * Chunks we sealed but Cloud already held (another device wrote the same plaintext):
   * our recorded sha256 is not the server's, so fetch, open and verify the server copy
   * and record its real bytes. Until that succeeds the chunk is never evictable.
   */
  private async adoptPresentCopies(sync:SyncRow, session:UploadSession):Promise<void> {
    const ours = new Set(session.staged);
    const adopt = session.present.filter(id => ours.has(id));
    if (!adopt.length) return;
    const root = await this.roots.unwrap(sync.collectionId, sync.keyVersion, sync.wrappedRoot!);
    try {
      for (const id of adopt) {
        try {
          const wire = await this.api.getChunk(sync.collectionId, id);
          const plain = await openCloudChunk(root, sync.collectionId, sync.keyVersion, id, wire);
          plain.fill(0);
          await this.repository.adoptServerCopy(sync.collectionId, id, createHash('sha256').update(wire).digest('hex'), wire.length);
        } catch {
          await this.repository.forgetUpload(sync.collectionId, [id]);
        }
      }
    } finally {
      root.fill(0);
    }
  }

  /** Reads every evicted chunk back through the caching store, which hydrates it from Cloud. */
  private async rehydrateEvicted(collectionId:string):Promise<void> {
    for (const chunkId of await this.repository.evictedChunks(collectionId)) {
      try {
        const encrypted = await this.store.get(collectionId, chunkId);
        encrypted.fill(0);
      } catch (error:any) {
        throw new HttpStatusError(409, error?.code === 'FILE_OFFLINE'
          ? 'Some files are only in Sulla Cloud and could not be downloaded; try again when online'
          : 'Some files are only in Sulla Cloud and could not be downloaded');
      }
    }
  }

  private async dropSession(collectionId:string):Promise<void> {
    await this.staging.clear(collectionId);
    await this.repository.dropCollectionOperations(collectionId, ['upload-open', 'commit']);
    await this.repository.saveSession(collectionId, null, 0, 'idle');
  }

  private pendingBytes(session:UploadSession, missing?:Set<unknown>):number {
    const staged = new Set(session.staged);
    return session.declared
      .filter(chunk => staged.has(chunk.id) && (!missing || missing.has(chunk.id)))
      .reduce((total, chunk) => total + chunk.cipherBytes, 0);
  }

  /** Serializes all state changes for one collection (background steps, send, enable, restore). */
  private exclusive<T>(collectionId:string, work:() => Promise<T>):Promise<T> {
    const previous = this.locks.get(collectionId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    const tail = next.catch(() => undefined);
    this.locks.set(collectionId, tail);
    void tail.then(() => {
      if (this.locks.get(collectionId) === tail) this.locks.delete(collectionId);
    });
    return next;
  }
}
