import { createHash, randomUUID } from 'node:crypto';

import { chunkId, decryptAndVerifyChunk, maxEncryptedChunkBytes } from './crypto.js';
import { SecureCollectionKeyExchange } from './keyExchange.js';
import { assertUnprotectedFile } from './protectedFiles.js';
import { FilesMutationCoordinator } from './safeFilesystem.js';

import type { FilesKeyring } from './keyring.js';
import type { EvictionReceipt, PinnedRegularFile, PublicationReceipt } from './safeFilesystem.js';
import type { Store } from './store.js';
import type { FilesKeyBundleContext } from '@sulla/vault-crypto';
import type pg from 'pg';

const CHUNK_BYTES = 4 * 1024 * 1024;

export type ResidencyState = 'local' | 'evicting' | 'online-only' | 'hydrating' | 'error';

export interface RemoteChunkDescriptor {
  id:               string;
  size:             number;
  storedSize:       number;
  ciphertextSha256: string;
}

export interface RemoteVersionDescriptor {
  fileId:            string;
  versionId:         string;
  collectionId:      string;
  chunkCollectionId: string;
  manifestHash:      string;
  size:              number;
  chunks:            RemoteChunkDescriptor[];
  keyContext:        FilesKeyBundleContext;
}

export interface RemoteVersionReceipt {
  fileId:            string;
  versionId:         string;
  collectionId:      string;
  chunkCollectionId: string;
  manifestHash:      string;
  size:              number;
  remoteRevision:    string;
  chunks:            RemoteChunkDescriptor[];
  keyContext:        FilesKeyBundleContext;
}

/** Implementations must authenticate the server and bound every response. */
export interface AuthenticatedResidencyTransport {
  readonly authenticated: true;
  prepareVersion(version:RemoteVersionDescriptor, signal:AbortSignal):Promise<{ missingChunkIds: string[] }>;
  uploadChunk(input:{ versionId: string; collectionId: string; chunk: RemoteChunkDescriptor; ciphertext: Uint8Array; signal: AbortSignal }):Promise<void>;
  commitVersion(version:RemoteVersionDescriptor, signal:AbortSignal):Promise<void>;
  verifyVersion(version:RemoteVersionDescriptor, signal:AbortSignal):Promise<RemoteVersionReceipt>;
  downloadChunk(input:{ versionId: string; collectionId: string; chunk: RemoteChunkDescriptor; signal: AbortSignal }):Promise<AsyncIterable<Uint8Array>>;
}

interface VersionRow {
  file_id:             string;
  path:                string;
  current_version_id:  string;
  collection_id:       string;
  version_id:          string;
  chunk_collection_id: string;
  manifest_hash:       string;
  size:                string | number;
  total_size:          string | number;
  chunk_ids:           unknown;
}

interface VersionDescriptor {
  fileId:            string;
  path:              string;
  versionId:         string;
  collectionId:      string;
  chunkCollectionId: string;
  manifestHash:      string;
  size:              number;
  chunks:            { id: string; size: number; storedSize: number }[];
}

interface LocalValidation { contentHash: string; size: number; mtimeMs: number }

export class FileResidencyManager {
  constructor(
    private readonly db:pg.Pool,
    private readonly store:Store,
    private readonly keyring:FilesKeyring,
    private readonly keyExchange:SecureCollectionKeyExchange,
    private readonly remote:AuthenticatedResidencyTransport,
    private readonly mutations:FilesMutationCoordinator,
  ) {
    if (remote.authenticated !== true) throw new Error('Online-only requires an authenticated remote transport');
  }

  capabilities() {
    return { keepOnComputer: true, onlineOnly: true, authenticatedRemote: true, verifiedRecovery: true } as const;
  }

  async status(fileId:string):Promise<{ desiredState: 'local' | 'online-only'; state: ResidencyState; lastError: string | null }> {
    const row = (await this.db.query(
      `SELECT desired_state,state,last_error FROM file_residency WHERE file_id=$1`,
      [fileId],
    )).rows[0];
    return row
      ? { desiredState: row.desired_state, state: row.state, lastError: row.last_error ?? null }
      : { desiredState: 'local', state: 'local', lastError: null };
  }

  async makeOnlineOnly(fileId:string, signal = new AbortController().signal):Promise<void> {
    return this.mutations.runExclusive([fileId], async() => {
      const operationId = randomUUID();
      const descriptor = await this.loadCurrent(fileId);
      await this.begin(fileId, descriptor.versionId, operationId, 'online-only', 'evicting');
      const quarantine = this.quarantine(operationId, 'evict');
      let eviction:EvictionReceipt | undefined;
      let committed = false;
      try {
        await this.assertLocalVersion(descriptor);
        const keyContext = await this.keyExchange.verifyRemoteRecoverability(descriptor.chunkCollectionId);
        await this.uploadAndVerify(descriptor, keyContext, signal);
        await this.assertStillCurrent(descriptor, operationId, 'evicting');
        await this.assertLocalVersion(descriptor);
        eviction = await this.mutations.evictVerified({
          source: descriptor.path,
          quarantine,
          verify: pinned => this.validatePinnedFile(pinned, descriptor).then(() => undefined),
        });
        await this.finishEviction(descriptor, operationId);
        committed = true;
        await this.mutations.finalizePublication(eviction).catch(() => undefined);
        await this.pruneRemoteBackedCache(descriptor).catch(() => undefined);
      } catch (error) {
        if (eviction && !committed) {
          await this.mutations.recoverEviction(
            eviction,
            pinned => this.validatePinnedFile(pinned, descriptor).then(() => undefined),
          ).catch(() => undefined);
        }
        await this.recordFailure(fileId, operationId, error, Boolean(eviction && !committed));
        throw error;
      }
    });
  }

  async keepOnComputer(fileId:string, signal = new AbortController().signal):Promise<void> {
    return this.mutations.runExclusive([fileId], async() => {
      const operationId = randomUUID();
      const descriptor = await this.loadCurrent(fileId);
      await this.begin(fileId, descriptor.versionId, operationId, 'local', 'hydrating');
      const stage = this.quarantine(operationId, 'hydrate');
      let publication:PublicationReceipt | undefined;
      let committed = false;
      try {
        if (await this.mutations.exists(descriptor.path)) throw new Error('Hydration will not overwrite an existing local file');
        const keyContext = await this.keyExchange.verifyRemoteRecoverability(descriptor.chunkCollectionId);
        const remoteVersion = await this.provenRemoteDescriptor(descriptor, keyContext);
        await this.verifyRemoteDescriptor(remoteVersion, signal);
        await this.materialize(descriptor, remoteVersion, stage, signal);
        await this.assertStillCurrent(descriptor, operationId, 'hydrating');
        publication = await this.mutations.publishVerified({
          staged: stage,
          target: descriptor.path,
          verify: pinned => this.validatePinnedFile(pinned, descriptor).then(() => undefined),
        });
        const local = await this.validatePlainFile(descriptor.path, descriptor);
        await this.finishHydration(descriptor, operationId, local);
        committed = true;
        await this.mutations.finalizePublication(publication).catch(() => undefined);
      } catch (error) {
        if (publication && !committed) {
          await this.mutations.rollbackPublication(
            publication,
            pinned => this.validatePinnedFile(pinned, descriptor).then(() => undefined),
          ).catch(() => undefined);
        }
        await this.recordFailure(fileId, operationId, error, false);
        throw error;
      }
    });
  }

  /** Completes crash-interrupted publication without clobbering user edits. */
  async recoverPending(signal = new AbortController().signal):Promise<void> {
    return this.mutations.runExclusive([], async() => {
      const rows = (await this.db.query(
        `SELECT file_id,state,operation_id FROM file_residency
        WHERE state IN('evicting','hydrating') ORDER BY updated_at`,
      )).rows as { file_id: string; state: ResidencyState; operation_id: string }[];
      for (const row of rows) {
        const descriptor = await this.loadCurrent(row.file_id);
        const stage = this.quarantine(row.operation_id, row.state === 'evicting' ? 'evict' : 'hydrate');
        if (row.state === 'evicting' && !await this.mutations.exists(descriptor.path) && await this.mutations.exists(stage)) {
          await this.assertRemoteProof(descriptor);
          await this.validatePlainFile(stage, descriptor);
          await this.finishEviction(descriptor, row.operation_id);
          await this.pruneRemoteBackedCache(descriptor);
          const pinned = await this.mutations.pin(stage);
          const receipt:EvictionReceipt = { source: descriptor.path, quarantine: stage, fingerprint: pinned.fingerprint };
          await pinned.close();
          await this.mutations.finalizePublication(receipt);
        } else if (row.state === 'hydrating' && await this.mutations.exists(descriptor.path)) {
          const local = await this.validatePlainFile(descriptor.path, descriptor);
          await this.finishHydration(descriptor, row.operation_id, local);
          if (await this.mutations.exists(stage)) {
            const pinned = await this.mutations.pin(stage);
            const receipt:PublicationReceipt = { staged: stage, target: descriptor.path, fingerprint: pinned.fingerprint };
            await pinned.close();
            await this.mutations.finalizePublication(receipt);
          }
        } else if (row.state === 'hydrating' && await this.mutations.exists(stage)) {
          await this.assertRemoteProof(descriptor);
          const publication = await this.mutations.publishVerified({
            staged: stage,
            target: descriptor.path,
            verify: pinned => this.validatePinnedFile(pinned, descriptor).then(() => undefined),
          });
          try {
            const local = await this.validatePlainFile(descriptor.path, descriptor);
            await this.finishHydration(descriptor, row.operation_id, local);
            await this.mutations.finalizePublication(publication);
          } catch (error) {
            await this.mutations.rollbackPublication(
              publication,
              pinned => this.validatePinnedFile(pinned, descriptor).then(() => undefined),
            ).catch(() => undefined);
            throw error;
          }
        } else if (row.state === 'evicting' && await this.mutations.exists(descriptor.path) && await this.mutations.exists(stage)) {
          await this.recordFailure(row.file_id, row.operation_id, new Error('Eviction source was replaced; both files were preserved'), false);
        } else if (row.state === 'evicting') {
          await this.makeOnlineOnly(row.file_id, signal);
        } else {
          await this.keepOnComputer(row.file_id, signal);
        }
      }
    });
  }

  private async loadCurrent(fileId:string):Promise<VersionDescriptor> {
    const row = (await this.db.query(
      `SELECT f.id AS file_id,f.path,f.current_version_id,f.collection_id,
              v.id AS version_id,v.chunk_collection_id,v.manifest_hash,v.size,
              m.total_size,m.chunk_ids
         FROM files f JOIN file_versions v ON v.id=f.current_version_id AND v.file_id=f.id
         JOIN manifests m ON m.hash=v.manifest_hash
        WHERE f.id=$1 AND f.deleted_at IS NULL AND NOT v.deleted`,
      [fileId],
    )).rows[0] as VersionRow | undefined;
    if (!row) throw new Error('Current file version is unavailable');
    await assertUnprotectedFile(this.db, { id: row.file_id, path: row.path });
    const size = Number(row.size);
    const ids = Array.isArray(row.chunk_ids) ? row.chunk_ids.map(String) : [];
    const expectedCount = Math.max(1, Math.ceil(size / CHUNK_BYTES));
    if (!Number.isSafeInteger(size) || size < 0 || Number(row.total_size) !== size || ids.length !== expectedCount) {
      throw new Error('File manifest has invalid chunk geometry');
    }
    const result = await this.db.query(
      'SELECT id,size,stored_size FROM chunks WHERE collection_id=$1 AND id=ANY($2::text[])',
      [row.chunk_collection_id, ids],
    );
    const metadata = new Map(result.rows.map(value => [String(value.id), value]));
    const chunks = ids.map((id, index) => {
      const value = metadata.get(id);
      const plainSize = index < ids.length - 1 ? CHUNK_BYTES : size - CHUNK_BYTES * (ids.length - 1);
      const storedSize = Number(value?.stored_size);
      if (!value || Number(value.size) !== plainSize || !Number.isSafeInteger(storedSize) || storedSize < 0 || storedSize > maxEncryptedChunkBytes(plainSize)) {
        throw new Error(`Missing or invalid chunk metadata for ${ id }`);
      }
      return { id, size: plainSize, storedSize };
    });
    return {
      fileId:            row.file_id,
      path:              row.path,
      versionId:         row.version_id,
      collectionId:      row.collection_id,
      chunkCollectionId: row.chunk_collection_id,
      manifestHash:      row.manifest_hash,
      size,
      chunks,
    };
  }

  private async uploadAndVerify(descriptor:VersionDescriptor, keyContext:FilesKeyBundleContext, signal:AbortSignal):Promise<void> {
    const version = await this.remoteDescriptor(descriptor, keyContext);
    const prepared = await this.remote.prepareVersion(version, signal);
    const missing = new Set(prepared.missingChunkIds);
    if (missing.size !== prepared.missingChunkIds.length || [...missing].some(id => !descriptor.chunks.some(chunk => chunk.id === id))) {
      throw new Error('Remote requested chunks outside the exact manifest');
    }
    for (const chunk of version.chunks) {
      if (!missing.has(chunk.id)) continue;
      signal.throwIfAborted();
      const ciphertext = await this.store.getBounded(descriptor.chunkCollectionId, chunk.id, maxEncryptedChunkBytes(chunk.size), chunk.storedSize);
      if (sha256(ciphertext) !== chunk.ciphertextSha256) throw new Error(`Local ciphertext changed for ${ chunk.id }`);
      await this.remote.uploadChunk({ versionId: descriptor.versionId, collectionId: descriptor.chunkCollectionId, chunk, ciphertext, signal });
    }
    await this.remote.commitVersion(version, signal);
    await this.verifyRemoteDescriptor(version, signal);
  }

  private async verifyRemoteDescriptor(version:RemoteVersionDescriptor, signal:AbortSignal):Promise<void> {
    const receipt = await this.remote.verifyVersion(version, signal);
    if (!sameReceipt(version, receipt) || !receipt.remoteRevision) throw new Error('Remote version receipt does not match the requested immutable version');
    const keys = await this.keyring.copyKeys(version.chunkCollectionId);
    try {
      for (const chunk of version.chunks) {
        signal.throwIfAborted();
        const source = await this.remote.downloadChunk({ versionId: version.versionId, collectionId: version.chunkCollectionId, chunk, signal });
        const ciphertext = await collectBounded(source, chunk.storedSize, maxEncryptedChunkBytes(chunk.size), signal);
        if (sha256(ciphertext) !== chunk.ciphertextSha256) throw new Error(`Remote ciphertext verification failed for ${ chunk.id }`);
        await decryptAndVerifyChunk(ciphertext, keys.data, keys.dedup, chunk.id, chunk.size);
      }
    } finally {
      keys.data.fill(0);
      keys.dedup.fill(0);
    }
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO file_remote_version_proofs
          (version_id,collection_id,manifest_hash,remote_revision,chunks_digest,key_version,key_epoch,verified_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,NOW())
         ON CONFLICT(version_id) DO UPDATE SET
           collection_id=EXCLUDED.collection_id,manifest_hash=EXCLUDED.manifest_hash,
           remote_revision=EXCLUDED.remote_revision,chunks_digest=EXCLUDED.chunks_digest,
           key_version=EXCLUDED.key_version,key_epoch=EXCLUDED.key_epoch,verified_at=EXCLUDED.verified_at`,
        [version.versionId, version.chunkCollectionId, version.manifestHash, receipt.remoteRevision,
          chunksDigest(version.chunks), version.keyContext.keyVersion, version.keyContext.epoch],
      );
      await client.query('DELETE FROM file_remote_chunk_proofs WHERE version_id=$1', [version.versionId]);
      for (const [ordinal, chunk] of version.chunks.entries()) {
        await client.query(
          `INSERT INTO file_remote_chunk_proofs(version_id,ordinal,chunk_id,size,stored_size,ciphertext_sha256)
           VALUES($1,$2,$3,$4,$5,$6)`,
          [version.versionId, ordinal, chunk.id, chunk.size, chunk.storedSize, chunk.ciphertextSha256],
        );
      }
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  }

  private async remoteDescriptor(descriptor:VersionDescriptor, keyContext:FilesKeyBundleContext):Promise<RemoteVersionDescriptor> {
    if (keyContext.collectionId !== descriptor.chunkCollectionId) throw new Error('Collection key proof does not match the file version');
    const chunks:RemoteChunkDescriptor[] = [];
    for (const chunk of descriptor.chunks) {
      const ciphertext = await this.store.getBounded(descriptor.chunkCollectionId, chunk.id, maxEncryptedChunkBytes(chunk.size), chunk.storedSize);
      chunks.push({ ...chunk, ciphertextSha256: sha256(ciphertext) });
    }
    return remoteVersion(descriptor, chunks, keyContext);
  }

  private async provenRemoteDescriptor(descriptor:VersionDescriptor, keyContext:FilesKeyBundleContext):Promise<RemoteVersionDescriptor> {
    if (keyContext.collectionId !== descriptor.chunkCollectionId) throw new Error('Collection key proof does not match the file version');
    const proof = (await this.db.query(
      `SELECT p.key_version,p.key_epoch,p.chunks_digest,
              json_agg(json_build_object('id',c.chunk_id,'size',c.size,'storedSize',c.stored_size,
                'ciphertextSha256',c.ciphertext_sha256) ORDER BY c.ordinal) AS chunks
         FROM file_remote_version_proofs p JOIN file_remote_chunk_proofs c ON c.version_id=p.version_id
        WHERE p.version_id=$1 AND p.collection_id=$2 AND p.manifest_hash=$3
        GROUP BY p.key_version,p.key_epoch,p.chunks_digest`,
      [descriptor.versionId, descriptor.chunkCollectionId, descriptor.manifestHash],
    )).rows[0];
    const chunks = Array.isArray(proof?.chunks) ? proof.chunks as RemoteChunkDescriptor[] : [];
    if (!proof || Number(proof.key_version) !== keyContext.keyVersion || Number(proof.key_epoch) !== keyContext.epoch ||
        chunksDigest(chunks) !== proof.chunks_digest || chunks.length !== descriptor.chunks.length ||
        chunks.some((chunk, index) => chunk.id !== descriptor.chunks[index].id || chunk.size !== descriptor.chunks[index].size || chunk.storedSize !== descriptor.chunks[index].storedSize)) {
      throw new Error('Verified remote chunk proof is missing or stale');
    }
    return remoteVersion(descriptor, chunks, keyContext);
  }

  private async materialize(descriptor:VersionDescriptor, remoteVersion:RemoteVersionDescriptor, stage:string, signal:AbortSignal):Promise<void> {
    const handle = await this.mutations.openPrivateExclusive(stage);
    const keys = await this.keyring.copyKeys(descriptor.chunkCollectionId);
    let total = 0;
    try {
      for (const chunk of remoteVersion.chunks) {
        signal.throwIfAborted();
        const remoteChunk = await this.remote.downloadChunk({
          versionId:    descriptor.versionId,
          collectionId: descriptor.chunkCollectionId,
          chunk,
          signal,
        });
        const ciphertext = await collectBounded(remoteChunk, chunk.storedSize, maxEncryptedChunkBytes(chunk.size), signal);
        if (sha256(ciphertext) !== chunk.ciphertextSha256) throw new Error(`Remote ciphertext verification failed for ${ chunk.id }`);
        const plain = await decryptAndVerifyChunk(ciphertext, keys.data, keys.dedup, chunk.id, chunk.size);
        await this.store.put(descriptor.chunkCollectionId, chunk.id, ciphertext);
        const cached = await this.store.getBounded(
          descriptor.chunkCollectionId,
          chunk.id,
          maxEncryptedChunkBytes(chunk.size),
          chunk.storedSize,
        );
        const cachedPlain = await decryptAndVerifyChunk(cached, keys.data, keys.dedup, chunk.id, chunk.size);
        if (!cachedPlain.equals(plain)) throw new Error(`Local ciphertext cache verification failed for ${ chunk.id }`);
        let offset = 0;
        while (offset < plain.byteLength) {
          const { bytesWritten } = await handle.write(plain, offset);
          if (bytesWritten === 0) throw new Error('Hydration made no write progress');
          offset += bytesWritten;
        }
        total += plain.byteLength;
      }
      if (total !== descriptor.size) throw new Error('Hydrated plaintext size does not match the version');
      await handle.sync();
    } finally {
      await handle.close();
      keys.data.fill(0);
      keys.dedup.fill(0);
    }
    // Ensure the exact key context used for decryption is still current.
    const proof = await this.db.query(
      `SELECT 1 FROM files_remote_key_recovery WHERE collection_id=$1 AND principal_id=$2
        AND key_version=$3 AND key_epoch=$4`,
      [remoteVersion.keyContext.collectionId, remoteVersion.keyContext.principalId,
        remoteVersion.keyContext.keyVersion, remoteVersion.keyContext.epoch],
    );
    if (proof.rowCount !== 1) throw new Error('Collection recovery proof changed during hydration');
  }

  private async assertLocalVersion(descriptor:VersionDescriptor):Promise<LocalValidation> {
    const watched = (await this.db.query(
      'SELECT content_hash,size,mtime_ms FROM watched_folder_state WHERE collection_id=$1 AND file_id=$2 AND path=$3',
      [descriptor.collectionId, descriptor.fileId, descriptor.path],
    )).rows[0];
    if (!watched) throw new Error('Online-only refused because the local file has pending or untracked state');
    const local = await this.validatePlainFile(descriptor.path, descriptor);
    if (String(watched.content_hash) !== local.contentHash || Number(watched.size) !== local.size) {
      throw new Error('Online-only refused because the local file has pending edits');
    }
    return local;
  }

  private async validatePlainFile(path:string, descriptor:VersionDescriptor):Promise<LocalValidation> {
    const pinned = await this.mutations.pin(path);
    try { return await this.validatePinnedFile(pinned, descriptor) } finally { await pinned.close() }
  }

  private async validatePinnedFile(pinned:PinnedRegularFile, descriptor:VersionDescriptor):Promise<LocalValidation> {
    const whole = createHash('sha256');
    let total = 0;
    let index = 0;
    const keys = await this.keyring.copyKeys(descriptor.chunkCollectionId);
    try {
      const stream = pinned.createReadStream(CHUNK_BYTES);
      for await (const value of stream) {
        const plain = Buffer.from(value);
        const expected = descriptor.chunks[index++];
        if (plain.byteLength !== expected?.size || chunkId(plain, keys.dedup) !== expected.id) {
          throw new Error('Local file does not match its current version');
        }
        whole.update(plain);
        total += plain.byteLength;
      }
      if (total === 0) {
        const expected = descriptor.chunks[index++];
        if (expected?.size !== 0 || chunkId(Buffer.alloc(0), keys.dedup) !== expected.id) throw new Error('Empty local file does not match its current version');
      }
      await pinned.assertUnchanged();
      if (index !== descriptor.chunks.length || total !== descriptor.size) {
        throw new Error('Local file changed during residency verification');
      }
      return { contentHash: whole.digest('hex'), size: total, mtimeMs: Math.trunc(pinned.fingerprint.mtimeMs) };
    } finally {
      keys.data.fill(0);
      keys.dedup.fill(0);
    }
  }

  private async begin(fileId:string, versionId:string, operationId:string, desired:'local' | 'online-only', state:'evicting' | 'hydrating'):Promise<void> {
    await this.db.query(
      `INSERT INTO file_residency(file_id,desired_state,state,version_id,operation_id,generation,last_error)
       VALUES($1,$2,$3,$4,$5,1,NULL)
       ON CONFLICT(file_id) DO UPDATE SET desired_state=EXCLUDED.desired_state,state=EXCLUDED.state,
         version_id=EXCLUDED.version_id,operation_id=EXCLUDED.operation_id,
         generation=file_residency.generation+1,last_error=NULL,updated_at=NOW()`,
      [fileId, desired, state, versionId, operationId],
    );
  }

  private async assertStillCurrent(descriptor:VersionDescriptor, operationId:string, state:'evicting' | 'hydrating'):Promise<void> {
    const result = await this.db.query(
      `SELECT 1 FROM files f JOIN file_residency r ON r.file_id=f.id
        WHERE f.id=$1 AND f.current_version_id=$2 AND r.version_id=$2 AND r.operation_id=$3 AND r.state=$4`,
      [descriptor.fileId, descriptor.versionId, operationId, state],
    );
    if (result.rowCount !== 1) throw new Error('File version or residency operation changed while work was in flight');
  }

  private async assertRemoteProof(descriptor:VersionDescriptor):Promise<void> {
    const proof = (await this.db.query(
      `SELECT p.chunks_digest,
              json_agg(json_build_object('id',c.chunk_id,'size',c.size,'storedSize',c.stored_size,
                'ciphertextSha256',c.ciphertext_sha256) ORDER BY c.ordinal) AS chunks
         FROM file_remote_version_proofs p JOIN files_remote_key_recovery k ON k.collection_id=p.collection_id
         JOIN file_remote_chunk_proofs c ON c.version_id=p.version_id
        WHERE p.version_id=$1 AND p.collection_id=$2 AND p.manifest_hash=$3
          AND p.key_version=k.key_version AND p.key_epoch=k.key_epoch
        GROUP BY p.chunks_digest`,
      [descriptor.versionId, descriptor.chunkCollectionId, descriptor.manifestHash],
    )).rows[0];
    const chunks = Array.isArray(proof?.chunks) ? proof.chunks as RemoteChunkDescriptor[] : [];
    if (chunksDigest(chunks) !== proof?.chunks_digest || chunks.length !== descriptor.chunks.length ||
        chunks.some((chunk, index) => chunk.id !== descriptor.chunks[index].id || chunk.size !== descriptor.chunks[index].size || chunk.storedSize !== descriptor.chunks[index].storedSize)) {
      throw new Error('Verified remote recovery proof is unavailable');
    }
  }

  private async finishEviction(descriptor:VersionDescriptor, operationId:string):Promise<void> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      await this.assertTransactionState(client, descriptor, operationId, 'evicting');
      const proof = await client.query('SELECT 1 FROM file_remote_version_proofs WHERE version_id=$1 AND collection_id=$2 AND manifest_hash=$3', [descriptor.versionId, descriptor.chunkCollectionId, descriptor.manifestHash]);
      if (proof.rowCount !== 1) throw new Error('Local eviction requires a verified remote version');
      await client.query('DELETE FROM watched_folder_state WHERE collection_id=$1 AND file_id=$2 AND path=$3', [descriptor.collectionId, descriptor.fileId, descriptor.path]);
      await client.query("UPDATE file_residency SET state='online-only',desired_state='online-only',operation_id=NULL,last_error=NULL,updated_at=NOW() WHERE file_id=$1", [descriptor.fileId]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  }

  private async finishHydration(descriptor:VersionDescriptor, operationId:string, local:LocalValidation):Promise<void> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      await this.assertTransactionState(client, descriptor, operationId, 'hydrating');
      await client.query(
        `INSERT INTO watched_folder_state(collection_id,path,file_id,content_hash,size,mtime_ms)
         VALUES($1,$2,$3,$4,$5,$6)
         ON CONFLICT(collection_id,path) DO UPDATE SET file_id=EXCLUDED.file_id,
           content_hash=EXCLUDED.content_hash,size=EXCLUDED.size,mtime_ms=EXCLUDED.mtime_ms`,
        [descriptor.collectionId, descriptor.path, descriptor.fileId, local.contentHash, local.size, local.mtimeMs],
      );
      await client.query("UPDATE file_residency SET state='local',desired_state='local',operation_id=NULL,last_error=NULL,updated_at=NOW() WHERE file_id=$1", [descriptor.fileId]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  }

  private async pruneRemoteBackedCache(descriptor:VersionDescriptor):Promise<void> {
    for (const chunk of descriptor.chunks) {
      const held = (await this.db.query(
        `SELECT
          EXISTS(
            SELECT 1 FROM file_versions v JOIN manifests m ON m.hash=v.manifest_hash
            LEFT JOIN file_remote_version_proofs p ON p.version_id=v.id
            WHERE v.chunk_collection_id=$1 AND m.chunk_ids ? $2 AND p.version_id IS NULL
          ) AS unbacked_history,
          EXISTS(
            SELECT 1 FROM files f JOIN file_versions v ON v.id=f.current_version_id
            JOIN manifests m ON m.hash=v.manifest_hash
            LEFT JOIN file_residency r ON r.file_id=f.id
            WHERE v.chunk_collection_id=$1 AND m.chunk_ids ? $2
              AND COALESCE(r.state,'local')<>'online-only'
          ) AS locally_required`,
        [descriptor.chunkCollectionId, chunk.id],
      )).rows[0];
      if (!held?.unbacked_history && !held?.locally_required) await this.store.delete(descriptor.chunkCollectionId, chunk.id);
    }
  }

  private async assertTransactionState(client:pg.PoolClient, descriptor:VersionDescriptor, operationId:string, state:'evicting' | 'hydrating'):Promise<void> {
    const result = await client.query(
      `SELECT 1 FROM files f JOIN file_residency r ON r.file_id=f.id
        WHERE f.id=$1 AND f.current_version_id=$2 AND r.version_id=$2 AND r.operation_id=$3 AND r.state=$4
        FOR UPDATE OF f,r`,
      [descriptor.fileId, descriptor.versionId, operationId, state],
    );
    if (result.rowCount !== 1) throw new Error('Out-of-order remote version or residency operation');
  }

  private async recordFailure(fileId:string, operationId:string, error:unknown, keepPending:boolean):Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    await this.db.query(
      `UPDATE file_residency SET state=CASE WHEN $3 THEN state ELSE 'error' END,last_error=$4,updated_at=NOW()
        WHERE file_id=$1 AND operation_id=$2`,
      [fileId, operationId, keepPending, message.slice(0, 2000)],
    ).catch(() => undefined);
  }

  private quarantine(operationId:string, suffix:string):string {
    return `.sulla-trash/.residency/residency/${ operationId }.${ suffix }`;
  }
}

async function collectBounded(source:AsyncIterable<Uint8Array>, expectedBytes:number, maxBytes:number, signal:AbortSignal):Promise<Buffer> {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0 || expectedBytes > maxBytes) throw new Error('Invalid remote chunk bound');
  const parts:Buffer[] = [];
  let total = 0;
  for await (const value of source) {
    signal.throwIfAborted();
    const part = Buffer.from(value);
    total += part.byteLength;
    if (total > expectedBytes || total > maxBytes) throw new Error('Remote chunk exceeded its declared bound');
    parts.push(part);
  }
  if (total !== expectedBytes) throw new Error('Remote chunk did not match its declared size');
  return Buffer.concat(parts, total);
}

function sameContext(left:FilesKeyBundleContext, right:FilesKeyBundleContext):boolean {
  return left.collectionId === right.collectionId && left.principalId === right.principalId &&
    left.keyVersion === right.keyVersion && left.epoch === right.epoch;
}

function sameReceipt(version:RemoteVersionDescriptor, receipt:RemoteVersionReceipt):boolean {
  return receipt.fileId === version.fileId && receipt.versionId === version.versionId &&
    receipt.collectionId === version.collectionId && receipt.chunkCollectionId === version.chunkCollectionId &&
    receipt.manifestHash === version.manifestHash &&
    receipt.size === version.size && sameContext(receipt.keyContext, version.keyContext) &&
    JSON.stringify(receipt.chunks) === JSON.stringify(version.chunks);
}

function remoteVersion(descriptor:VersionDescriptor, chunks:RemoteChunkDescriptor[], keyContext:FilesKeyBundleContext):RemoteVersionDescriptor {
  return {
    fileId:            descriptor.fileId,
    versionId:         descriptor.versionId,
    collectionId:      descriptor.collectionId,
    chunkCollectionId: descriptor.chunkCollectionId,
    manifestHash:      descriptor.manifestHash,
    size:              descriptor.size,
    chunks,
    keyContext,
  };
}

function chunksDigest(chunks:Pick<RemoteChunkDescriptor, 'id' | 'size' | 'storedSize' | 'ciphertextSha256'>[]):string {
  return sha256(Buffer.from(JSON.stringify(chunks)));
}

function sha256(value:Uint8Array):string { return createHash('sha256').update(value).digest('hex') }
