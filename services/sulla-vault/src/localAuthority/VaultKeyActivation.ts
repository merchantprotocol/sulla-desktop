// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { EncryptedEnvelope } from '@sulla/vault-crypto';

import type { LocalVaultState } from '../contracts.js';
import type { LocalAuthorityHost } from './LocalAuthorityHost.js';
import type { UnlockedKeys } from './LocalAuthorityTypes.js';
import { LocalVaultError } from './LocalVaultError.js';

/**
 * Installs unlocked key material: password unlock (KDF read/upgrade) and master-key
 * activation (create or open the account, generation bump, migration state).
 * Moved verbatim from LocalVaultAuthority (E9); vault state lives on the host.
 */
export class VaultKeyActivation {
  constructor(private readonly host: LocalAuthorityHost) {}

  async unlockWithPassword(password: string): Promise<{ state: LocalVaultState; cacheUpdateRequired: boolean }> {
    const attemptGeneration = this.host.generation;
    if (!password || password.length > 1024) throw new LocalVaultError('invalid_credentials', 400, 'Password is required');
    const existing = await this.host.userRepository.findActiveKdf<{ kdf: unknown }>();
    const crypto = await this.host.localCryptoProvider.get();
    const stored = existing.rowCount ? crypto.readKdf(existing.rows[0]?.kdf) : undefined;
    const storedPasswordKdf = stored?.passwordKdf();
    if (existing.rowCount && !storedPasswordKdf) {
      throw new LocalVaultError('invalid_credentials', 409, 'This vault requires the OS-protected unlock cache');
    }
    // A fresh vault draws a new salt; an existing one reuses its stored salt and cost exactly.
    const passwordKdf = storedPasswordKdf ?? crypto.credential.newPasswordKdf();
    const masterKey = crypto.credential.deriveMasterKey(password, passwordKdf);
    try {
      const result = await this.host.activateMasterKey(masterKey, undefined, crypto.kdfColumn(passwordKdf), attemptGeneration);
      // Older builds stored a flat {salt, parameters}; it is upgraded once to the current shape (same key bytes).
      if (stored?.isLegacyFlat) {
        const keys = this.host.requireKeys();
        await this.host.userRepository.updateKdf(keys.userId, crypto.kdfColumn(passwordKdf));
      }
      this.host.stageCacheUpdate(masterKey);
      return { ...result, cacheUpdateRequired: true };
    } finally {
      masterKey.fill(0);
    }
  }

  async activateMasterKey(
    masterKey: Uint8Array,
    legacyVmk?: Buffer,
    newAccountKdf: unknown = { authority: 'container', version: 1 },
    attemptGeneration = this.host.generation,
  ): Promise<{ state: LocalVaultState }> {
      const existing = await this.host.userRepository.findActive<{
        id: string; login_hash_salt: Buffer; login_hash_verifier: Buffer; public_key: string;
        encrypted_private_key: EncryptedEnvelope; encrypted_user_key: EncryptedEnvelope;
      }>();

      const crypto = await this.host.localCryptoProvider.get();
      let next: UnlockedKeys;
      if (!existing.rowCount) {
        const created = crypto.createAccount(masterKey);
        try {
          const result = await this.host.userRepository.create<{ id: string }>(
            [created.verifier.salt, created.verifier.verifier, created.publicKey, created.encryptedPrivateKey, created.encryptedUserKey, newAccountKdf],
          );
          next = { userId: result.rows[0].id, publicKey: created.publicKey, userKey: created.userKey, privateKey: created.privateKey, legacyVmk };
        } catch (error) {
          created.userKey.fill(0);
          created.privateKey.fill(0);
          throw error;
        }
      } else {
        const account = existing.rows[0];
        if (!crypto.verifyPassword(masterKey, account.login_hash_salt, account.login_hash_verifier)) {
          throw new LocalVaultError('invalid_credentials', 401, 'Unlock material did not match the vault');
        }
        const userKey = crypto.credential.openUserKey(masterKey, account.encrypted_user_key);
        try {
          next = {
            userId: account.id,
            publicKey: account.public_key,
            userKey,
            privateKey: crypto.credential.openPrivateKey(userKey, account.encrypted_private_key),
            legacyVmk,
          };
        } catch (error) {
          userKey.fill(0);
          throw error;
        }
      }
      if (attemptGeneration !== this.host.generation) {
        next.userKey.fill(0);
        next.privateKey.fill(0);
        next.legacyVmk?.fill(0);
        throw new LocalVaultError('vault_locked', 423, 'Unlock was cancelled by a concurrent lock');
      }
      this.host.lockNow();
      this.host.keys = next;
      this.host.generation += 1;
      const activeGeneration = this.host.generation;
      const committed = this.host.config.legacyDatabaseUrl
        ? await this.host.migrationRepository.hasCommitted()
        : { rowCount: 1 };
      this.host.requireGeneration(activeGeneration);
      this.host.migrationState = committed.rowCount ? 'unlocked' : 'migration_required';
      this.host.retryPendingSullaCloudRevocations();
      return { state: this.host.migrationState };
  }
}
