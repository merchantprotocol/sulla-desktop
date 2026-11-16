// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { VaultOperationError } from '@sulla/domain';
import type { EncryptedEnvelope } from '@sulla/vault-crypto';

import type { HumanBackupEnvelope, LocalVaultState } from '../contracts.js';
import { DesktopHumanBackup, type VaultUserBackupRow } from '../localCrypto/DesktopHumanBackup.js';
import type { LocalAuthorityHost } from './LocalAuthorityHost.js';
import { LocalVaultError } from './LocalVaultError.js';

/**
 * Recovery and backups: account recovery-key rotation, human recovery codes, recovery unlock,
 * and password-sealed backup export/import into an empty vault.
 * Moved verbatim from LocalVaultAuthority (E9); vault state lives on the host.
 */
export class HumanRecoveryService {
  constructor(private readonly host: LocalAuthorityHost) {}

  /** Replace the account recovery wrap while retaining the previous encrypted wrap as a restore point. */
  async rotateAccountRecoveryKey(
    serviceId: string, token: string | undefined,
  ): Promise<{ recoveryKey: string; replacedExisting: boolean }> {
    this.host.requireApprovalIdentity(serviceId, token);
    const keys = this.host.requireKeys();
    const generation = this.host.generation;
    const rotation = (await this.host.localCryptoProvider.get()).recovery.rotate(keys.userKey);
    let replacedExisting = false;
    await this.host.runTransaction(async client => {
      replacedExisting = await this.host.rewrapHistory.preserveCurrentRecoveryWrap(keys.userId, 'rotation', client);
      await this.host.recoveryRepository.upsertForRotation([keys.userId, rotation.row.recoverySalt, rotation.row.recoveryVerifier, rotation.row.encryptedUserKey], client);
      this.host.requireGeneration(generation);
      await this.host.auditHumanAction(client, keys.userId, 'account_recovery_key_rotated');
    });
    return { recoveryKey: rotation.recoveryKey, replacedExisting };
  }

  async configureHumanRecovery(
    sessionId: string | undefined, csrf: string | undefined, recoveryCode: string,
  ): Promise<void> {
    return this.host.runSecurityOperation(async() => {
    const session = this.host.validateHumanSession(sessionId, csrf);
    if (session.phase !== 'unlocked') throw new LocalVaultError('vault_locked', 423, 'Vault is locked');
    if (recoveryCode.length < 12) throw new LocalVaultError('invalid_credentials', 400, 'Recovery code is too short');
    const keys = this.host.requireKeys();
    const generation = this.host.generation;
    const row = (await this.host.localCryptoProvider.get()).recovery.configure(keys.userKey, recoveryCode);
    await this.host.runTransaction(async client => {
    await this.host.recoveryRepository.upsertForHumanRecovery([keys.userId, row.recoverySalt, row.recoveryVerifier, row.encryptedUserKey], client);
    this.host.requireGeneration(generation);
    await this.host.auditHumanAction(client, keys.userId, 'human_recovery_configured');
    this.host.requireGeneration(generation);
    });
    });
  }

  async recoverHumanSession(
    sessionId: string | undefined, csrf: string | undefined, recoveryCode: string, nextPassword: string,
  ): Promise<{ sessionId: string; csrf: string; expiresAt: number; phase: 'unlocked'; state: LocalVaultState; cacheMode: 'helper-update-required' }> {
    return this.host.runSecurityOperation(async() => {
    const session = this.host.validateHumanSession(sessionId, csrf);
    if (session.phase !== 'pre-unlock') throw new LocalVaultError('invalid_human_session', 409, 'Recovery requires a locked vault');
    const attemptGeneration = this.host.generation;
    const result = await this.host.recoveryRepository.findAny<{ user_id: string; recovery_salt: string; recovery_verifier: string; encrypted_user_key: EncryptedEnvelope }>();
    if (!result.rowCount) throw new LocalVaultError('invalid_credentials', 404, 'Vault recovery is not configured');
    const row = result.rows[0];
    const crypto = await this.host.localCryptoProvider.get();
    const nextKdf = crypto.credential.newPasswordKdf();
    const next = crypto.credential.deriveMasterKey(nextPassword, nextKdf);
    let recoveredUserKey: Uint8Array | undefined;
    try {
      try {
        recoveredUserKey = crypto.recovery.open(
          { recoverySalt: row.recovery_salt, recoveryVerifier: row.recovery_verifier, encryptedUserKey: row.encrypted_user_key }, recoveryCode);
      } catch (error) {
        if (error instanceof VaultOperationError && error.code === 'invalid_credential') {
          throw new LocalVaultError('invalid_credentials', 401, 'Recovery code is invalid');
        }
        throw error;
      }
      const verifier = crypto.newVerifier(next);
      const wrapped = crypto.credential.sealUserKey(next, recoveredUserKey);
      await this.host.runTransaction(async client => {
      await this.host.rewrapHistory.preserveCurrentPasswordWrap(row.user_id, 'recovery', client);
      await this.host.userRepository.updatePassword(row.user_id, [
        verifier.salt, verifier.verifier, wrapped, crypto.kdfColumn(nextKdf),
      ], client);
      this.host.requireStableGeneration(attemptGeneration);
      await this.host.auditHumanAction(client, row.user_id, 'human_recovery_unlocked');
      });
      const unlocked = await this.host.activateMasterKey(next, undefined, crypto.kdfColumn(nextKdf), attemptGeneration);
      this.host.stageCacheUpdate(next);
      const rotated = this.host.parts.humanSessions.issueHumanSession();
      if (rotated.phase !== 'unlocked') throw new LocalVaultError('vault_unavailable', 503, 'Recovery did not unlock the vault');
      return { ...rotated, phase: 'unlocked', state: unlocked.state, cacheMode: 'helper-update-required' };
    } finally {
      next.fill(0);
      recoveredUserKey?.fill(0);
    }
    });
  }

  async exportHumanBackup(
    sessionId: string | undefined, csrf: string | undefined, backupPassword: string,
  ): Promise<HumanBackupEnvelope> {
    return this.host.runSecurityOperation(async() => {
    const session = this.host.validateHumanSession(sessionId, csrf);
    if (session.phase !== 'unlocked') throw new LocalVaultError('vault_locked', 423, 'Vault is locked');
    if (!backupPassword) throw new LocalVaultError('invalid_credentials', 400, 'Backup password is required');
    const keys = this.host.requireKeys();
    const generation = this.host.generation;
    const [user, items, recovery] = await Promise.all([
      this.host.userRepository.findById<VaultUserBackupRow>(keys.userId),
      this.host.itemRepository.listOwnedForBackup([keys.userId]),
      this.host.recoveryRepository.findForUser(keys.userId),
    ]);
    const envelope = (await this.host.localCryptoProvider.get()).backups.seal(
      { user: user.rows[0], items: items.rows, recovery: recovery.rows[0] ?? null }, backupPassword);
    this.host.requireGeneration(generation);
    await this.host.auditHumanAction(this.host.db, keys.userId, 'human_backup_exported');
    this.host.requireGeneration(generation);
    return envelope;
    });
  }

  async importHumanBackup(
    sessionId: string | undefined, csrf: string | undefined, backupPassword: string, backupEnvelope: HumanBackupEnvelope,
  ): Promise<void> {
    return this.host.runSecurityOperation(async() => {
    const session = this.host.validateHumanSession(sessionId, csrf);
    if (session.phase !== 'pre-unlock') throw new LocalVaultError('invalid_human_session', 409, 'Backup import requires a locked vault');
    if (!backupPassword || backupEnvelope?.version !== 1) throw new LocalVaultError('invalid_operation', 400, 'Backup input is invalid');
    const attemptGeneration = this.host.generation;
    const existing = await this.host.userRepository.exists();
    if (existing.rowCount) throw new LocalVaultError('policy_denied', 409, 'Backup import requires an empty local vault');
    const backups = (await this.host.localCryptoProvider.get()).backups;
    try {
      const payload = backups.open(backupEnvelope, backupPassword);
      const asBuffer = DesktopHumanBackup.bytea;
      // A failed ROLLBACK never masks the original error, and that client is destroyed (PgTransactionRunner).
      await this.host.runTransaction(async client => {
        await this.host.userRepository.importBackup(
          [payload.user.id, payload.user.email, asBuffer(payload.user.login_hash_salt), asBuffer(payload.user.login_hash_verifier),
            payload.user.public_key, payload.user.encrypted_private_key, payload.user.encrypted_user_key, payload.user.kdf],
          client,
        );
        for (const item of payload.items) {
          await this.host.itemRepository.insertBackupItem([item.id, payload.user.id, item.item_type, item.ciphertext, item.encrypted_item_key, item.agent_policy,
              item.integration_ref, item.revision, item.created_at, item.updated_at], client);
        }
        if (payload.recovery) {
          await this.host.recoveryRepository.insert(
            [payload.user.id, payload.recovery.recovery_salt, payload.recovery.recovery_verifier, payload.recovery.encrypted_user_key],
            client,
          );
        }
        this.host.requireStableGeneration(attemptGeneration);
        await this.host.auditHumanAction(client, payload.user.id, 'human_backup_imported');
      });
    } catch (error) {
      if (error instanceof LocalVaultError) throw error;
      throw new LocalVaultError('invalid_credentials', 400, 'Backup password or payload is invalid');
    }
    });
  }
}
