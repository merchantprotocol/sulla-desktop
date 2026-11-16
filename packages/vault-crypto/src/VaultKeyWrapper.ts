// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { VaultCipher } from './VaultCipher.js';
import type { EncryptedEnvelope, WrappedKeyPair } from './types.js';

/** The vault key hierarchy: master key → user key → user private key; org key → collection key. */
export class VaultKeyWrapper {
  private static readonly USER_KEY_CONTEXT = 'sulla:user-key:v1';
  private static readonly USER_PRIVATE_KEY_CONTEXT = 'sulla:user-private-key:v1';
  private static readonly COLLECTION_KEY_CONTEXT = 'sulla:collection-key:v1';

  constructor(private readonly cipher: VaultCipher) {}

  async createUserKey(masterKey: Uint8Array): Promise<{ userKey: Uint8Array; encryptedUserKey: EncryptedEnvelope }> {
    const userKey = await this.cipher.generateKey();
    return { userKey, encryptedUserKey: await this.cipher.encryptWithKey(userKey, masterKey, VaultKeyWrapper.USER_KEY_CONTEXT) };
  }

  unwrapUserKey(encryptedUserKey: EncryptedEnvelope, masterKey: Uint8Array): Promise<Uint8Array> {
    return this.cipher.decryptWithKey(encryptedUserKey, masterKey, VaultKeyWrapper.USER_KEY_CONTEXT);
  }

  async createUserKeyPair(userKey: Uint8Array): Promise<WrappedKeyPair & { privateKey: Uint8Array }> {
    const pair = await this.cipher.generateKeyPair();
    return {
      publicKey:           pair.publicKey,
      privateKey:          pair.privateKey,
      encryptedPrivateKey: await this.cipher.encryptWithKey(pair.privateKey, userKey, VaultKeyWrapper.USER_PRIVATE_KEY_CONTEXT),
    };
  }

  unwrapUserPrivateKey(encryptedPrivateKey: EncryptedEnvelope, userKey: Uint8Array): Promise<Uint8Array> {
    return this.cipher.decryptWithKey(encryptedPrivateKey, userKey, VaultKeyWrapper.USER_PRIVATE_KEY_CONTEXT);
  }

  wrapCollectionKey(collectionKey: Uint8Array, orgKey: Uint8Array): Promise<EncryptedEnvelope> {
    return this.cipher.encryptWithKey(collectionKey, orgKey, VaultKeyWrapper.COLLECTION_KEY_CONTEXT);
  }

  unwrapCollectionKey(encryptedCollectionKey: EncryptedEnvelope, orgKey: Uint8Array): Promise<Uint8Array> {
    return this.cipher.decryptWithKey(encryptedCollectionKey, orgKey, VaultKeyWrapper.COLLECTION_KEY_CONTEXT);
  }
}
