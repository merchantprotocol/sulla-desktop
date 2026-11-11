// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import sodium from 'libsodium-wrappers-sumo';
import { AccountAuth, AccountKdfPolicy, type AccountKdf, type RandomSource } from '@sulla/domain';

import { SodiumAccountPrimitives } from './SodiumAccountPrimitives';

export interface DerivedAccountCredential {
  authHash:  string;
  kdf:       AccountKdf;
  /** Owned by the caller, who must zero it. */
  masterKey: Uint8Array;
}

/**
 * The Cloud password to master key and authHash, over the shared domain AccountAuth.
 * The key bytes and the authHash are the same ones the Desktop vault-crypto helpers produce
 * (see CloudAccountCredentialService.spec.ts). The endpoint choice, NFC retry and zeroing after a failed
 * request stay with the caller, sullaCloudAuth.ts.
 */
export class CloudAccountCredentialService {
  static async forDesktop(): Promise<CloudAccountCredentialService> {
    await sodium.ready;
    const primitives = new SodiumAccountPrimitives(sodium);
    return new CloudAccountCredentialService(new AccountAuth(primitives), new AccountKdfPolicy(), primitives);
  }

  constructor(
    private readonly auth: AccountAuth,
    private readonly policy: AccountKdfPolicy,
    private readonly random: RandomSource,
  ) {}

  /** The KDF Sulla Cloud issued, or an error: a downgraded or malformed KDF is never accepted. */
  parseIssuedKdf(value: unknown): AccountKdf {
    const kdf = this.policy.parse(value);
    if (!kdf) throw new Error('Sulla Cloud returned an unsupported account KDF.');
    return kdf;
  }

  /** Derives with the account's issued KDF, or with a fresh salt for a new account or password. */
  async derive(password: string, accountKdf?: AccountKdf): Promise<DerivedAccountCredential> {
    const kdf = accountKdf ?? this.policy.issue(this.random.bytes(AccountKdfPolicy.SALT_BYTES));
    const masterKey = this.auth.deriveMasterKey(password, kdf);
    try {
      return { authHash: this.auth.authHash(masterKey), kdf: { ...kdf }, masterKey };
    } catch (error) {
      masterKey.fill(0);
      throw error;
    }
  }
}
