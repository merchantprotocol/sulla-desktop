// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { SodiumRuntime } from './SodiumRuntime.js';
import { VaultCipher } from './VaultCipher.js';
import { DEFAULT_ARGON2ID, type Argon2idParameters, type Base64, type DerivedMasterKey } from './types.js';

/** Password and hash derivations (Argon2id master key, BLAKE2b auth/login/join hashes). */
export class VaultKeyDerivation {
  private static readonly SALT_BYTES = 16;
  private static readonly CLOUD_AUTH_DOMAIN = 'sulla-cloud-auth-v1';
  private static readonly LOGIN_DOMAIN = 'sulla-vault-login-v1';

  private readonly encoder = new TextEncoder();

  constructor(private readonly runtime: SodiumRuntime, private readonly cipher: VaultCipher) {}

  async deriveMasterKey(
    masterPassword: string,
    salt?: Base64,
    parameters: Argon2idParameters = DEFAULT_ARGON2ID,
  ): Promise<DerivedMasterKey> {
    const sodium = await this.runtime.ready();
    if (!masterPassword) {
      throw new Error('Master password cannot be empty');
    }
    const saltBytes = salt ? this.runtime.decode(salt) : sodium.randombytes_buf(VaultKeyDerivation.SALT_BYTES);
    if (saltBytes.byteLength !== sodium.crypto_pwhash_SALTBYTES) {
      throw new Error(`Argon2id salt must be ${ sodium.crypto_pwhash_SALTBYTES } bytes`);
    }
    const key = sodium.crypto_pwhash(
      VaultCipher.KEY_BYTES,
      masterPassword,
      saltBytes,
      parameters.operations,
      parameters.memoryBytes,
      sodium.crypto_pwhash_ALG_ARGON2ID13,
    );
    return { key, salt: this.runtime.encode(saltBytes), parameters };
  }

  deriveAccountAuthHash(masterKey: Uint8Array): Promise<Base64> {
    return this.domainHash(masterKey, VaultKeyDerivation.CLOUD_AUTH_DOMAIN);
  }

  deriveLoginHash(masterKey: Uint8Array): Promise<Base64> {
    return this.domainHash(masterKey, VaultKeyDerivation.LOGIN_DOMAIN);
  }

  async deriveOrgJoinHash(joinPassword: string, orgId: string): Promise<Base64> {
    const sodium = await this.runtime.ready();
    if (!joinPassword || !orgId) {
      throw new Error('Join password and organization id are required');
    }
    const input = this.encoder.encode(`sulla:org-join:v1:${ orgId }\0${ joinPassword }`);
    return this.runtime.encode(sodium.crypto_generichash(VaultCipher.KEY_BYTES, input, null));
  }

  async publicKeyFingerprint(publicKey: Base64): Promise<string> {
    const sodium = await this.runtime.ready();
    return this.runtime.encode(sodium.crypto_generichash(8, this.runtime.decode(publicKey), null));
  }

  /** BLAKE2b-256 of the domain string keyed with the master key. */
  private async domainHash(masterKey: Uint8Array, domain: string): Promise<Base64> {
    const sodium = await this.runtime.ready();
    this.cipher.assertKey(masterKey, 'Master key');
    return this.runtime.encode(sodium.crypto_generichash(VaultCipher.KEY_BYTES, this.encoder.encode(domain), masterKey));
  }
}
