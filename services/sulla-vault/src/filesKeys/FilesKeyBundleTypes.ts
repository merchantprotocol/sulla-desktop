// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { Base64, FilesKeyBundleContext, FilesKeyBundleEnvelope } from '@sulla/vault-crypto';

export interface RegisteredFilesKeyBundle {
  context:        FilesKeyBundleContext;
  authorityKeyId: string;
  envelope:       FilesKeyBundleEnvelope;
}

/**
 * A lease is issued by LocalVaultAuthority while it is unlocked. Its
 * implementation lends an erasable private-key copy and verifies the generation
 * again before returning, so lock stays responsive and no stale response or key
 * reference survives a Vault generation.
 */
export interface UnlockedFilesAuthorityIdentity {
  principalId: string;
  publicKey:   Base64;
  privateKey:  Uint8Array;
  generation:  number;
  assertCurrent(): void;
}

export interface FilesAuthorityIdentityLease {
  withUnlockedIdentity<T>(operation:(identity:UnlockedFilesAuthorityIdentity) => Promise<T>):Promise<T>;
}
