// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { VaultCipher } from './VaultCipher.js';
import { VAULT_CRYPTO_VERSION, type Base64, type EncryptedItem, type ItemContext } from './types.js';

/**
 * Seals one vault item: a fresh item key encrypts the payload, the owner key wraps the item key,
 * and an optional agent public key gets its own sealed copy. Both AEAD layers are bound to the
 * owner and item ids, so an item cannot be replayed under another owner or id.
 */
export class VaultItemEncryptor {
  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder();

  constructor(private readonly cipher: VaultCipher) {}

  /** The AEAD context string for an item layer. Throws synchronously when an id is missing. */
  associatedData(purpose: 'key' | 'ciphertext', context: ItemContext): string {
    if (!context.itemId || !context.ownerId) {
      throw new Error('Item context requires an item id and owner id');
    }
    return `sulla:item:${ purpose }:v1:${ JSON.stringify([context.ownerId, context.itemId]) }`;
  }

  async encrypt(
    plaintext: Uint8Array | string,
    ownerKey: Uint8Array,
    context: ItemContext,
    agentPublicKey?: Base64,
  ): Promise<EncryptedItem> {
    const itemKey = await this.cipher.generateKey();
    const payload = typeof plaintext === 'string' ? this.encoder.encode(plaintext) : plaintext;
    return {
      version:             VAULT_CRYPTO_VERSION,
      encryptedItemKey:    await this.cipher.encryptWithKey(itemKey, ownerKey, this.associatedData('key', context)),
      ciphertext:          await this.cipher.encryptWithKey(payload, itemKey, this.associatedData('ciphertext', context)),
      agentWrappedItemKey: agentPublicKey ? await this.cipher.wrapKeyToPublicKey(itemKey, agentPublicKey) : undefined,
    };
  }

  async decrypt(item: EncryptedItem, ownerKey: Uint8Array, context: ItemContext): Promise<Uint8Array> {
    if (item.version !== VAULT_CRYPTO_VERSION) {
      throw new Error('Unsupported item version');
    }
    const itemKey = await this.cipher.decryptWithKey(item.encryptedItemKey, ownerKey, this.associatedData('key', context));
    return this.cipher.decryptWithKey(item.ciphertext, itemKey, this.associatedData('ciphertext', context));
  }

  async decryptText(item: EncryptedItem, ownerKey: Uint8Array, context: ItemContext): Promise<string> {
    return this.decoder.decode(await this.decrypt(item, ownerKey, context));
  }
}
