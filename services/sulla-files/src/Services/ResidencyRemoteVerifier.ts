// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { decryptAndVerifyChunk, maxEncryptedChunkBytes } from '../crypto.js';
import { ResidencyVersionGeometry as Geometry } from './ResidencyVersionGeometry.js';

import type { TransactionRunner } from '../FilesTransaction.js';
import type { FilesKeyring } from '../keyring.js';
import type { FileResidencyRepository } from '../Repositories/FileResidencyRepository.js';
import type { Store } from '../store.js';
import type { FilesMutationCoordinator } from './FilesMutationCoordinator.js';
import type { AuthenticatedResidencyTransport, RemoteChunkDescriptor, RemoteVersionDescriptor, ResidencyVersion } from './ResidencyContracts.js';
import type { FilesKeyBundleContext } from '@sulla/vault-crypto';

/**
 * Moves one immutable version's ciphertext to and from the authenticated remote and keeps the
 * durable proof that the remote copy decrypts to exactly the local chunk ids.
 */
export class ResidencyRemoteVerifier {
  constructor(
    private readonly rows:FileResidencyRepository,
    private readonly transactions:TransactionRunner,
    private readonly store:Store,
    private readonly keyring:FilesKeyring,
    private readonly remote:AuthenticatedResidencyTransport,
    private readonly mutations:FilesMutationCoordinator,
  ) {}

  async uploadAndVerify(descriptor:ResidencyVersion, keyContext:FilesKeyBundleContext, signal:AbortSignal):Promise<void> {
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
      if (Geometry.sha256(ciphertext) !== chunk.ciphertextSha256) throw new Error(`Local ciphertext changed for ${ chunk.id }`);
      await this.remote.uploadChunk({ versionId: descriptor.versionId, collectionId: descriptor.chunkCollectionId, chunk, ciphertext, signal });
    }
    await this.remote.commitVersion(version, signal);
    await this.verifyRemoteDescriptor(version, signal);
  }

  /** Downloads and decrypts every remote chunk, then records the proof in one short transaction. */
  async verifyRemoteDescriptor(version:RemoteVersionDescriptor, signal:AbortSignal):Promise<void> {
    const receipt = await this.remote.verifyVersion(version, signal);
    if (!Geometry.sameReceipt(version, receipt) || !receipt.remoteRevision) throw new Error('Remote version receipt does not match the requested immutable version');
    const keys = await this.keyring.copyKeys(version.chunkCollectionId);
    try {
      for (const chunk of version.chunks) {
        signal.throwIfAborted();
        const source = await this.remote.downloadChunk({ versionId: version.versionId, collectionId: version.chunkCollectionId, chunk, signal });
        const ciphertext = await Geometry.collectBounded(source, chunk.storedSize, maxEncryptedChunkBytes(chunk.size), signal);
        if (Geometry.sha256(ciphertext) !== chunk.ciphertextSha256) throw new Error(`Remote ciphertext verification failed for ${ chunk.id }`);
        await decryptAndVerifyChunk(ciphertext, keys.data, keys.dedup, chunk.id, chunk.size);
      }
    } finally {
      keys.data.fill(0);
      keys.dedup.fill(0);
    }
    await this.transactions.run('residency.remote-proof', client => this.rows.saveRemoteProof(client, {
      versionId:      version.versionId,
      collectionId:   version.chunkCollectionId,
      manifestHash:   version.manifestHash,
      remoteRevision: receipt.remoteRevision,
      chunksDigest:   Geometry.chunksDigest(version.chunks),
      keyVersion:     version.keyContext.keyVersion,
      keyEpoch:       version.keyContext.epoch,
      chunks:         version.chunks,
    }));
  }

  async remoteDescriptor(descriptor:ResidencyVersion, keyContext:FilesKeyBundleContext):Promise<RemoteVersionDescriptor> {
    if (keyContext.collectionId !== descriptor.chunkCollectionId) throw new Error('Collection key proof does not match the file version');
    const chunks:RemoteChunkDescriptor[] = [];
    for (const chunk of descriptor.chunks) {
      const ciphertext = await this.store.getBounded(descriptor.chunkCollectionId, chunk.id, maxEncryptedChunkBytes(chunk.size), chunk.storedSize);
      chunks.push({ ...chunk, ciphertextSha256: Geometry.sha256(ciphertext) });
    }
    return Geometry.remoteVersion(descriptor, chunks, keyContext);
  }

  /** Rebuilds the remote descriptor from the stored proof; refuses a proof made under another key. */
  async provenRemoteDescriptor(descriptor:ResidencyVersion, keyContext:FilesKeyBundleContext):Promise<RemoteVersionDescriptor> {
    if (keyContext.collectionId !== descriptor.chunkCollectionId) throw new Error('Collection key proof does not match the file version');
    const proof = await this.rows.findRemoteProof(descriptor.versionId, descriptor.chunkCollectionId, descriptor.manifestHash);
    const chunks = Array.isArray(proof?.chunks) ? proof.chunks as RemoteChunkDescriptor[] : [];
    if (!proof || Number(proof.key_version) !== keyContext.keyVersion || Number(proof.key_epoch) !== keyContext.epoch ||
        !Geometry.matchesProof(chunks, proof.chunks_digest, descriptor)) {
      throw new Error('Verified remote chunk proof is missing or stale');
    }
    return Geometry.remoteVersion(descriptor, chunks, keyContext);
  }

  /** Crash recovery may only finish an operation whose proof matches the collection's current key. */
  async assertRemoteProof(descriptor:ResidencyVersion):Promise<void> {
    const proof = await this.rows.findRecoverableRemoteProof(descriptor.versionId, descriptor.chunkCollectionId, descriptor.manifestHash);
    const chunks = Array.isArray(proof?.chunks) ? proof.chunks as RemoteChunkDescriptor[] : [];
    if (!Geometry.matchesProof(chunks, proof?.chunks_digest, descriptor)) {
      throw new Error('Verified remote recovery proof is unavailable');
    }
  }

  /** Writes verified plaintext into a private exclusive stage and re-caches each verified ciphertext. */
  async materialize(descriptor:ResidencyVersion, remoteVersion:RemoteVersionDescriptor, stage:string, signal:AbortSignal):Promise<void> {
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
        const ciphertext = await Geometry.collectBounded(remoteChunk, chunk.storedSize, maxEncryptedChunkBytes(chunk.size), signal);
        if (Geometry.sha256(ciphertext) !== chunk.ciphertextSha256) throw new Error(`Remote ciphertext verification failed for ${ chunk.id }`);
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
    if (!await this.rows.isKeyRecoveryCurrent(remoteVersion.keyContext)) throw new Error('Collection recovery proof changed during hydration');
  }
}
