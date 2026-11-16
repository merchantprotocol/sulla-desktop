// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { AccountPasswordRewrapRequest, AccountPasswordRewrapResponse } from '../contracts.js';
import type { LocalAuthorityHost } from './LocalAuthorityHost.js';
import { LocalVaultError } from './LocalVaultError.js';

/**
 * Local password changes and Cloud account-password metadata: re-wraps the user key under a
 * new password, or records Cloud ownership without touching the local key wrap.
 * Moved verbatim from LocalVaultAuthority (E9); vault state lives on the host.
 */
export class AccountPasswordService {
  constructor(private readonly host: LocalAuthorityHost) {}

  async changeHumanPassword(
    sessionId: string | undefined, csrf: string | undefined, currentPassword: string, nextPassword: string,
  ): Promise<{ cacheMode: 'helper-update-required' }> {
    return this.host.runSecurityOperation(async() => {
    const session = this.host.validateHumanSession(sessionId, csrf);
    if (session.phase !== 'unlocked') throw new LocalVaultError('vault_locked', 423, 'Vault is locked');
    if (!currentPassword || !nextPassword) throw new LocalVaultError('invalid_credentials', 400, 'Current and new passwords are required');
    const keys = this.host.requireKeys();
    const generation = this.host.generation;
    const account = await this.host.userRepository.findCredentials<{
      login_hash_salt: Buffer; login_hash_verifier: Buffer;
      kdf: unknown;
    }>(keys.userId);
    const crypto = await this.host.localCryptoProvider.get();
    const stored = account.rows[0]?.kdf as { password?: unknown } | undefined;
    const passwordKdf = stored?.password ? crypto.readKdf(stored)?.passwordKdf() : undefined;
    if (!passwordKdf) throw new LocalVaultError('invalid_credentials', 409, 'Password unlock is not configured');
    const nextKdf = crypto.credential.newPasswordKdf();
    const current = crypto.credential.deriveMasterKey(currentPassword, passwordKdf);
    const next = crypto.credential.deriveMasterKey(nextPassword, nextKdf);
    try {
      if (!crypto.verifyPassword(current, account.rows[0].login_hash_salt, account.rows[0].login_hash_verifier)) {
        throw new LocalVaultError('invalid_credentials', 401, 'Current password is invalid');
      }
      const verifier = crypto.newVerifier(next);
      const wrapped = crypto.credential.sealUserKey(next, keys.userKey);
      await this.host.runTransaction(async client => {
      await this.host.rewrapHistory.preserveCurrentPasswordWrap(keys.userId, 'password_change', client);
      await this.host.userRepository.updatePassword(keys.userId, [
        verifier.salt, verifier.verifier, wrapped, crypto.kdfColumn(nextKdf),
      ], client);
      this.host.requireGeneration(generation);
      await this.host.auditHumanAction(client, keys.userId, 'human_password_changed');
      this.host.requireGeneration(generation);
      });
      this.host.stageCacheUpdate(next);
      return { cacheMode: 'helper-update-required' };
    } finally {
      current.fill(0);
      next.fill(0);
    }
    });
  }

  /** Record Cloud ownership metadata without changing the local user-key wrap. */
  async rewrapForAccountPassword(
    serviceId: string, token: string | undefined, input: AccountPasswordRewrapRequest,
  ): Promise<AccountPasswordRewrapResponse> {
    this.host.requireApprovalIdentity(serviceId, token);
    const kdf = input?.kdf;
    const cloudUserId = typeof input?.cloudUserId === 'string' ? input.cloudUserId.trim() : '';
    if (!cloudUserId || Buffer.byteLength(cloudUserId) > 256) {
      throw new LocalVaultError('invalid_operation', 400, 'Cloud account is invalid');
    }
    if (kdf?.alg !== 'argon2id13' || !/^[A-Za-z0-9_-]{22}$/.test(kdf.salt) ||
        kdf.memoryBytes !== 67_108_864 || kdf.ops !== 3) {
      throw new LocalVaultError('invalid_operation', 400, 'Account KDF is unsupported');
    }
    const masterKey = Buffer.from(input.masterKey || '', 'base64url');
    if (!/^[A-Za-z0-9_-]{43}$/.test(input.masterKey || '') || masterKey.byteLength !== 32) {
      masterKey.fill(0);
      throw new LocalVaultError('invalid_unlock_material', 400, 'Account master key is invalid');
    }
    const response = { migrated: false, recoveryCreated: false, cacheMode: 'helper-update-required' } as const;
    // A fresh install has no local key wrap to rewrite: bootstrap the new vault
    // once. An existing locked vault remains a strict no-op, aside from owner guard.
    const keys = this.host.keys;
    if (!keys) {
      try {
        await this.host.runSecurityOperation(async() => {
          if (this.host.keys || !await this.host.isSetupRequired()) return false;
          await this.host.activateMasterKey(Uint8Array.from(masterKey), undefined, {
            authority: 'container', version: 1, cloudUserId,
            password: { salt: kdf.salt, parameters: { memoryBytes: kdf.memoryBytes, operations: kdf.ops } },
          });
          return true;
        });
        if (!this.host.keys) {
          const existing = await this.host.userRepository.findActiveOwner<{ id: string; kdf: { cloudUserId?: string } }>();
          const owner = existing.rows[0]?.kdf?.cloudUserId;
          if (owner && owner !== cloudUserId) {
            throw new LocalVaultError('invalid_credentials', 409, 'This Mac has a vault for a different Sulla account. Sign in with that account.');
          }
        }
        return response;
      } finally { masterKey.fill(0); }
    }

    try {
    const current = await this.host.userRepository.findCredentials<{
      kdf: { cloudUserId?: string; password?: { salt?: string; parameters?: { memoryBytes?: number; operations?: number } } };
    }>(keys.userId);
    if (!current.rows.length) throw new LocalVaultError('invalid_credentials', 404, 'Local vault owner was not found');
    const currentOwner = current.rows[0].kdf?.cloudUserId;
    if (currentOwner && currentOwner !== cloudUserId) {
      throw new LocalVaultError('invalid_credentials', 409, 'This Mac has a vault for a different Sulla account. Sign in with that account.');
    }
    if (!currentOwner) {
      const priorCloud = await this.host.localStore.findPriorSullaCloudAccount<{ active_account_id: string }>(keys.userId);
      if (priorCloud.rows[0]?.active_account_id && priorCloud.rows[0].active_account_id !== cloudUserId) {
        throw new LocalVaultError('invalid_credentials', 409, 'This Mac has a vault for a different Sulla account. Sign in with that account.');
      }
      await this.host.userRepository.updateKdf(keys.userId, {
        authority: 'container', version: 1, cloudUserId,
        ...(current.rows[0].kdf?.password ? { password: current.rows[0].kdf.password } : {}),
      });
    }
    return response;
    } finally { masterKey.fill(0); }
  }
}
