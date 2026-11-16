// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { isDeepStrictEqual } from 'node:util';

import type { Base64, FilesKeyBundleContext, FilesKeyBundleEnvelope } from '@sulla/vault-crypto';

import type { Database } from './db.js';
import { VaultCryptoFilesKeyBundleCipher, type FilesKeyBundleCipher } from './filesKeys/FilesKeyBundleCipher.js';
import { FilesKeyBundlePolicy } from './filesKeys/FilesKeyBundlePolicy.js';
import type {
  FilesAuthorityIdentityLease,
  RegisteredFilesKeyBundle,
  UnlockedFilesAuthorityIdentity,
} from './filesKeys/FilesKeyBundleTypes.js';
import { VaultFilesKeyBundleError } from './filesKeys/VaultFilesKeyBundleError.js';
import { PostgresFilesKeyBundleRepository } from './repositories/PostgresFilesKeyBundleRepository.js';

export type {
  FilesAuthorityIdentityLease,
  RegisteredFilesKeyBundle,
  UnlockedFilesAuthorityIdentity,
} from './filesKeys/FilesKeyBundleTypes.js';
export { VaultFilesKeyBundleError } from './filesKeys/VaultFilesKeyBundleError.js';

/**
 * Vault-side custody of Files collection key bundles. Accepts only bundles
 * sealed to the unlocked Vault identity, advances the current generation
 * strictly, and re-wraps the current bundle for a recovering device.
 */
export class VaultFilesKeyBundleAuthority {
  constructor(
    db:Database,
    private readonly identityLease:FilesAuthorityIdentityLease,
    private readonly repository:PostgresFilesKeyBundleRepository = new PostgresFilesKeyBundleRepository(db),
    private readonly cipher:FilesKeyBundleCipher = new VaultCryptoFilesKeyBundleCipher(),
    private readonly policy:FilesKeyBundlePolicy = new FilesKeyBundlePolicy(),
  ) {}

  async unlockedPrincipal():Promise<{ principalId: string; generation: number }> {
    return this.identityLease.withUnlockedIdentity(identity => {
      identity.assertCurrent();
      return Promise.resolve({ principalId: identity.principalId, generation: identity.generation });
    });
  }

  async custodyRecipient(context:FilesKeyBundleContext):Promise<{ keyId: string; publicKey: Base64 }> {
    return this.identityLease.withUnlockedIdentity(identity => {
      this.policy.assertUnlockedPrincipal(identity, context);
      return Promise.resolve({ keyId: this.policy.authorityKeyId(identity), publicKey: identity.publicKey });
    });
  }

  async registerBundle(bundle:RegisteredFilesKeyBundle):Promise<void> {
    return this.identityLease.withUnlockedIdentity(async identity => {
      this.policy.assertUnlockedPrincipal(identity, bundle.context);
      const expectedKeyId = this.policy.authorityKeyId(identity);
      if (bundle.authorityKeyId !== expectedKeyId || bundle.envelope.purpose !== 'authority-custody' ||
          !this.policy.sameContext(bundle.envelope.context, bundle.context)) {
        throw new VaultFilesKeyBundleError('invalid_bundle', 400, 'Files custody bundle does not match the unlocked Vault authority');
      }

      // Prove that this immutable envelope was actually sealed to the current
      // Vault identity before accepting it. Plaintext exists only in memory and
      // is erased immediately.
      const material = await this.cipher.open(
        bundle.envelope,
        bundle.context,
        'authority-custody',
        identity.publicKey,
        identity.privateKey,
      );
      material.dataKey.fill(0);
      material.dedupKey.fill(0);
      identity.assertCurrent();

      await this.repository.withCollectionLock(bundle.context.principalId, bundle.context.collectionId, async connection => {
        const existing = await this.repository.findEnvelope(connection, bundle.context);
        if (existing) {
          if (existing.authority_key_id !== bundle.authorityKeyId ||
              !isDeepStrictEqual(existing.authority_bundle, bundle.envelope)) {
            throw new VaultFilesKeyBundleError('bundle_conflict', 409, 'Conflicting immutable Files custody bundle');
          }
          const current = await this.repository.findCurrentForUpdate(connection, bundle.context.principalId, bundle.context.collectionId);
          if (!current || !this.policy.sameContext(this.policy.rowContext(current), bundle.context)) {
            throw new VaultFilesKeyBundleError('stale_context', 409, 'Files custody bundle is not the current authorized generation');
          }
        } else {
          const current = await this.repository.findCurrentForUpdate(connection, bundle.context.principalId, bundle.context.collectionId);
          if (current && !this.policy.strictlyAdvances(current, bundle.context)) {
            throw new VaultFilesKeyBundleError('stale_context', 409, 'Files custody bundle version or epoch is stale');
          }
          await this.repository.insertEnvelope(connection, bundle);
          await this.repository.upsertCurrent(connection, bundle.context);
        }
        identity.assertCurrent();
      });
    });
  }

  async authorizeDeviceRecovery(request:{
    context:         FilesKeyBundleContext;
    devicePublicKey: Base64;
  }):Promise<FilesKeyBundleEnvelope> {
    return this.identityLease.withUnlockedIdentity(async identity => {
      this.policy.assertUnlockedPrincipal(identity, request.context);
      if (typeof request.devicePublicKey !== 'string' || !request.devicePublicKey) {
        throw new VaultFilesKeyBundleError('invalid_device_key', 400, 'Files recovery device key is invalid');
      }
      const row = await this.repository.findCurrentEnvelope(request.context);
      if (row?.authority_key_id !== this.policy.authorityKeyId(identity) ||
          !this.policy.sameContext(this.policy.rowContext(row), request.context)) {
        throw new VaultFilesKeyBundleError('context_denied', 403, 'Files recovery bundle is not authorized for this exact context');
      }
      const envelope = await this.cipher.rewrapForDevice(
        row.authority_bundle,
        request.context,
        identity.publicKey,
        identity.privateKey,
        request.devicePublicKey,
      );
      identity.assertCurrent();
      return envelope;
    });
  }
}

/** @deprecated use FilesKeyBundlePolicy.authorityKeyId — E9 alias, removed in final cleanup */
export const filesKeyBundleAuthorityTestHooks = {
  authorityKeyId: (identity:Pick<UnlockedFilesAuthorityIdentity, 'principalId' | 'publicKey'>):string =>
    new FilesKeyBundlePolicy().authorityKeyId(identity),
};
