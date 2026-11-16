// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { createHash } from 'node:crypto';

import type { FilesKeyBundleContext } from '@sulla/vault-crypto';

import type { FilesKeyBundleCurrentRow } from '../repositories/PostgresFilesKeyBundleRepository.js';
import type { UnlockedFilesAuthorityIdentity } from './FilesKeyBundleTypes.js';
import { VaultFilesKeyBundleError } from './VaultFilesKeyBundleError.js';

/**
 * Context, principal and generation rules for Files key bundle custody.
 * Bodies moved verbatim from the former free helpers in filesKeyBundleAuthority.ts (E9).
 */
export class FilesKeyBundlePolicy {
  assertContext(context:FilesKeyBundleContext):void {
    if (!context || typeof context.collectionId !== 'string' || !context.collectionId ||
        typeof context.principalId !== 'string' || !context.principalId ||
        !Number.isSafeInteger(context.keyVersion) || context.keyVersion < 1 ||
        !Number.isSafeInteger(context.epoch) || context.epoch < 1) {
      throw new VaultFilesKeyBundleError('invalid_context', 400, 'Files key bundle context is invalid');
    }
  }

  sameContext(left:FilesKeyBundleContext, right:FilesKeyBundleContext):boolean {
    return left.collectionId === right.collectionId && left.principalId === right.principalId &&
      left.keyVersion === right.keyVersion && left.epoch === right.epoch;
  }

  authorityKeyId(identity:Pick<UnlockedFilesAuthorityIdentity, 'principalId' | 'publicKey'>):string {
    const fingerprint = createHash('sha256').update(identity.publicKey).digest('base64url');
    return `vault-user-x25519:v1:${ identity.principalId }:${ fingerprint }`;
  }

  assertUnlockedPrincipal(identity:UnlockedFilesAuthorityIdentity, context:FilesKeyBundleContext):void {
    this.assertContext(context);
    if (context.principalId !== identity.principalId) {
      throw new VaultFilesKeyBundleError('principal_denied', 403, 'Files recovery principal is not the unlocked Vault principal');
    }
    identity.assertCurrent();
  }

  strictlyAdvances(current:FilesKeyBundleCurrentRow, context:FilesKeyBundleContext):boolean {
    const version = Number(current.key_version);
    const epoch = Number(current.key_epoch);
    return context.keyVersion >= version && context.epoch >= epoch &&
      (context.keyVersion > version || context.epoch > epoch);
  }

  rowContext(row:FilesKeyBundleCurrentRow):FilesKeyBundleContext {
    return {
      principalId:  row.principal_id,
      collectionId: row.collection_id,
      keyVersion:   Number(row.key_version),
      epoch:        Number(row.key_epoch),
    };
  }
}
