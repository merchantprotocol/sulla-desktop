// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { randomUUID } from 'node:crypto';

import type { PendingRevocationQueue } from '@sulla/domain';
import { decryptItemText, encryptItem, type EncryptedEnvelope } from '@sulla/vault-crypto';

import type { PostgresSullaCloudRevocationRepository } from '../repositories/PostgresSullaCloudRevocationRepository.js';

/** The unlocked vault user key, or a thrown error when the vault is locked. */
export interface VaultUserKeyHolder {
  userKey(): { userId: string; userKey: Uint8Array };
}

interface QueuedRow {
  id:                 string;
  ciphertext:         EncryptedEnvelope;
  encrypted_item_key: EncryptedEnvelope;
}

/**
 * Durable PendingRevocationQueue: each queued refresh token is encrypted with the vault user key (the same item
 * envelope), so a copy of the database never holds a usable token. It survives restart; entries leave only through remove().
 */
export class VaultRevocationQueue implements PendingRevocationQueue {
  constructor(
    private readonly repository: PostgresSullaCloudRevocationRepository,
    private readonly keys: VaultUserKeyHolder,
  ) {}

  async push(refreshToken: string): Promise<void> {
    const { userId, userKey } = this.keys.userKey();
    if ((await this.entries()).some(entry => entry.token === refreshToken)) return;
    const id = randomUUID();
    const encrypted = await encryptItem(JSON.stringify({ refreshToken }), userKey, { itemId: id, ownerId: userId });
    await this.repository.insert([id, userId, encrypted.ciphertext, encrypted.encryptedItemKey]);
  }

  async drain(): Promise<string[]> {
    return (await this.entries()).map(entry => entry.token);
  }

  async remove(refreshToken: string): Promise<void> {
    const { userId } = this.keys.userKey();
    for (const entry of await this.entries()) {
      if (entry.token === refreshToken) await this.repository.deleteOwned([entry.id, userId]);
    }
  }

  private async entries(): Promise<Array<{ id: string; token: string }>> {
    const { userId, userKey } = this.keys.userKey();
    const rows = (await this.repository.listForOwner<QueuedRow>([userId])).rows;
    const entries: Array<{ id: string; token: string }> = [];
    for (const row of rows) {
      try {
        const plaintext = JSON.parse(await decryptItemText(
          { version: 1, ciphertext: row.ciphertext, encryptedItemKey: row.encrypted_item_key }, userKey, { itemId: row.id, ownerId: userId },
        )) as { refreshToken?: unknown };
        if (typeof plaintext.refreshToken === 'string' && plaintext.refreshToken) entries.push({ id: row.id, token: plaintext.refreshToken });
      } catch {
        // An undecryptable row (wrong key after a rewrap) is skipped, never logged: it cannot be retried.
      }
    }
    return entries;
  }
}
