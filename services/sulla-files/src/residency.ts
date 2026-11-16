// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { randomUUID } from 'node:crypto';

import { TransactionRunner } from './FilesTransaction.js';
import { FileResidencyRepository } from './Repositories/FileResidencyRepository.js';
import { FilesMutationCoordinator } from './safeFilesystem.js';
import { ResidencyLocalValidator } from './Services/ResidencyLocalValidator.js';
import { ResidencyRemoteVerifier } from './Services/ResidencyRemoteVerifier.js';
import { ResidencyVersionLoader } from './Services/ResidencyVersionLoader.js';

import type { SecureCollectionKeyExchange } from './keyExchange.js';
import type { FilesKeyring } from './keyring.js';
import type { EvictionReceipt, PublicationReceipt } from './safeFilesystem.js';
import type { AuthenticatedResidencyTransport, LocalValidation, ResidencyState, ResidencyVersion } from './Services/ResidencyContracts.js';
import type { Store } from './store.js';
import type pg from 'pg';

export type {
  AuthenticatedResidencyTransport,
  RemoteChunkDescriptor,
  RemoteVersionDescriptor,
  RemoteVersionReceipt,
  ResidencyState,
} from './Services/ResidencyContracts.js';

/**
 * Moves a file between "kept on this computer" and "online-only". Eviction only happens after the
 * authenticated remote proves it holds ciphertext that decrypts to the exact current version;
 * hydration never overwrites a local file. Every transition is durable in file_residency so a
 * crash mid-operation is finished (or safely retried) by recoverPending.
 */
export class FileResidencyManager {
  private readonly rows:FileResidencyRepository;
  private readonly transactions:TransactionRunner;
  private readonly versions:ResidencyVersionLoader;
  private readonly local:ResidencyLocalValidator;
  private readonly content:ResidencyRemoteVerifier;

  constructor(
    db:pg.Pool,
    private readonly store:Store,
    keyring:FilesKeyring,
    private readonly keyExchange:SecureCollectionKeyExchange,
    remote:AuthenticatedResidencyTransport,
    private readonly mutations:FilesMutationCoordinator,
  ) {
    if (remote.authenticated !== true) throw new Error('Online-only requires an authenticated remote transport');
    this.rows = new FileResidencyRepository(db);
    this.transactions = new TransactionRunner(db);
    this.versions = new ResidencyVersionLoader(db, this.rows);
    this.local = new ResidencyLocalValidator(this.rows, keyring, mutations);
    this.content = new ResidencyRemoteVerifier(this.rows, this.transactions, store, keyring, remote, mutations);
  }

  capabilities() {
    return { keepOnComputer: true, onlineOnly: true, authenticatedRemote: true, verifiedRecovery: true } as const;
  }

  async status(fileId:string):Promise<{ desiredState: 'local' | 'online-only'; state: ResidencyState; lastError: string | null }> {
    const row = await this.rows.findStatus(fileId);
    return row
      ? { desiredState: row.desired_state, state: row.state, lastError: row.last_error ?? null }
      : { desiredState: 'local', state: 'local', lastError: null };
  }

  async makeOnlineOnly(fileId:string, signal = new AbortController().signal):Promise<void> {
    return this.mutations.runExclusive([fileId], async() => {
      await FilesMutationCoordinator.requireAtomicRename();
      const operationId = randomUUID();
      const descriptor = await this.versions.loadCurrent(fileId);
      await this.rows.begin(fileId, descriptor.versionId, operationId, 'online-only', 'evicting');
      const quarantine = this.quarantine(operationId, 'evict');
      let eviction:EvictionReceipt | undefined;
      let committed = false;
      try {
        await this.local.assertLocalVersion(descriptor);
        const keyContext = await this.keyExchange.verifyRemoteRecoverability(descriptor.chunkCollectionId);
        await this.content.uploadAndVerify(descriptor, keyContext, signal);
        await this.assertStillCurrent(descriptor, operationId, 'evicting');
        await this.local.assertLocalVersion(descriptor);
        eviction = await this.mutations.evictVerified({
          source: descriptor.path,
          quarantine,
          verify: this.local.verifier(descriptor),
        });
        await this.finishEviction(descriptor, operationId);
        committed = true;
        await this.mutations.finalizePublication(eviction).catch(() => undefined);
        await this.pruneRemoteBackedCache(descriptor).catch(() => undefined);
      } catch (error) {
        if (eviction && !committed) {
          await this.mutations.recoverEviction(eviction, this.local.verifier(descriptor)).catch(() => undefined);
        }
        await this.recordFailure(fileId, operationId, error, Boolean(eviction && !committed));
        throw error;
      }
    });
  }

  async keepOnComputer(fileId:string, signal = new AbortController().signal):Promise<void> {
    return this.mutations.runExclusive([fileId], async() => {
      await FilesMutationCoordinator.requireAtomicRename();
      const operationId = randomUUID();
      const descriptor = await this.versions.loadCurrent(fileId);
      await this.rows.begin(fileId, descriptor.versionId, operationId, 'local', 'hydrating');
      const stage = this.quarantine(operationId, 'hydrate');
      let publication:PublicationReceipt | undefined;
      let committed = false;
      try {
        if (await this.mutations.exists(descriptor.path)) throw new Error('Hydration will not overwrite an existing local file');
        const keyContext = await this.keyExchange.verifyRemoteRecoverability(descriptor.chunkCollectionId);
        const remoteVersion = await this.content.provenRemoteDescriptor(descriptor, keyContext);
        await this.content.verifyRemoteDescriptor(remoteVersion, signal);
        await this.content.materialize(descriptor, remoteVersion, stage, signal);
        await this.assertStillCurrent(descriptor, operationId, 'hydrating');
        publication = await this.mutations.publishVerified({
          staged: stage,
          target: descriptor.path,
          verify: this.local.verifier(descriptor),
        });
        const local = await this.local.validatePlainFile(descriptor.path, descriptor);
        await this.finishHydration(descriptor, operationId, local);
        committed = true;
        await this.mutations.finalizePublication(publication).catch(() => undefined);
      } catch (error) {
        if (publication && !committed) {
          await this.mutations.rollbackPublication(publication, this.local.verifier(descriptor)).catch(() => undefined);
        }
        await this.recordFailure(fileId, operationId, error, false);
        throw error;
      }
    });
  }

  /** Completes crash-interrupted publication without clobbering user edits. */
  async recoverPending(signal = new AbortController().signal):Promise<void> {
    return this.mutations.runExclusive([], async() => {
      const rows = await this.rows.listPending();
      for (const row of rows) {
        const descriptor = await this.versions.loadCurrent(row.file_id);
        const stage = this.quarantine(row.operation_id, row.state === 'evicting' ? 'evict' : 'hydrate');
        if (row.state === 'evicting' && !await this.mutations.exists(descriptor.path) && await this.mutations.exists(stage)) {
          await this.content.assertRemoteProof(descriptor);
          await this.local.validatePlainFile(stage, descriptor);
          await this.finishEviction(descriptor, row.operation_id);
          await this.pruneRemoteBackedCache(descriptor);
          const pinned = await this.mutations.pin(stage);
          const receipt:EvictionReceipt = { source: descriptor.path, quarantine: stage, fingerprint: pinned.fingerprint };
          await pinned.close();
          await this.mutations.finalizePublication(receipt);
        } else if (row.state === 'hydrating' && await this.mutations.exists(descriptor.path)) {
          const local = await this.local.validatePlainFile(descriptor.path, descriptor);
          await this.finishHydration(descriptor, row.operation_id, local);
          if (await this.mutations.exists(stage)) {
            const pinned = await this.mutations.pin(stage);
            const receipt:PublicationReceipt = { staged: stage, target: descriptor.path, fingerprint: pinned.fingerprint };
            await pinned.close();
            await this.mutations.finalizePublication(receipt);
          }
        } else if (row.state === 'hydrating' && await this.mutations.exists(stage)) {
          await this.content.assertRemoteProof(descriptor);
          const publication = await this.mutations.publishVerified({
            staged: stage,
            target: descriptor.path,
            verify: this.local.verifier(descriptor),
          });
          try {
            const local = await this.local.validatePlainFile(descriptor.path, descriptor);
            await this.finishHydration(descriptor, row.operation_id, local);
            await this.mutations.finalizePublication(publication);
          } catch (error) {
            await this.mutations.rollbackPublication(publication, this.local.verifier(descriptor)).catch(() => undefined);
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

  private async assertStillCurrent(descriptor:ResidencyVersion, operationId:string, state:'evicting' | 'hydrating'):Promise<void> {
    if (!await this.rows.isOperationCurrent(descriptor.fileId, descriptor.versionId, operationId, state)) {
      throw new Error('File version or residency operation changed while work was in flight');
    }
  }

  private async finishEviction(descriptor:ResidencyVersion, operationId:string):Promise<void> {
    await this.transactions.run('residency.finish-eviction', async client => {
      await this.assertTransactionState(client, descriptor, operationId, 'evicting');
      if (!await this.rows.hasRemoteVersionProof(client, descriptor.versionId, descriptor.chunkCollectionId, descriptor.manifestHash)) {
        throw new Error('Local eviction requires a verified remote version');
      }
      await this.rows.deleteWatchedState(client, descriptor.collectionId, descriptor.fileId, descriptor.path);
      await this.rows.markOnlineOnly(client, descriptor.fileId);
    });
  }

  private async finishHydration(descriptor:ResidencyVersion, operationId:string, local:LocalValidation):Promise<void> {
    await this.transactions.run('residency.finish-hydration', async client => {
      await this.assertTransactionState(client, descriptor, operationId, 'hydrating');
      await this.rows.upsertWatchedState(client, {
        collectionId: descriptor.collectionId,
        path:         descriptor.path,
        fileId:       descriptor.fileId,
        contentHash:  local.contentHash,
        size:         local.size,
        mtimeMs:      local.mtimeMs,
      });
      await this.rows.markLocal(client, descriptor.fileId);
    });
  }

  /** Drops cached ciphertext that every holder can now recover from the remote. */
  private async pruneRemoteBackedCache(descriptor:ResidencyVersion):Promise<void> {
    for (const chunk of descriptor.chunks) {
      const held = await this.rows.findChunkHolds(descriptor.chunkCollectionId, chunk.id);
      if (!held?.unbacked_history && !held?.locally_required) await this.store.delete(descriptor.chunkCollectionId, chunk.id);
    }
  }

  private async assertTransactionState(client:pg.PoolClient, descriptor:ResidencyVersion, operationId:string, state:'evicting' | 'hydrating'):Promise<void> {
    if (!await this.rows.lockOperation(client, descriptor.fileId, descriptor.versionId, operationId, state)) {
      throw new Error('Out-of-order remote version or residency operation');
    }
  }

  private async recordFailure(fileId:string, operationId:string, error:unknown, keepPending:boolean):Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    await this.rows.recordFailure(fileId, operationId, keepPending, message.slice(0, 2000)).catch(() => undefined);
  }

  private quarantine(operationId:string, suffix:string):string {
    return `.sulla-trash/.residency/residency/${ operationId }.${ suffix }`;
  }
}
