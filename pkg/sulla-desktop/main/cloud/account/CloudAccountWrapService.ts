// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { AccountKdf } from '@sulla/domain';

import type { recoveryKeyStorageStatus } from '../../recoveryKeychain';
import type { LocalVaultApprovalClient } from '@pkg/vault-broker';
import type { CloudRecoveryKeyNotice, CloudRecoveryKeyNoticeStore } from '../session/CloudRecoveryKeyNoticeStore';
import type { CloudSessionKeyStore } from '../session/CloudSessionKeyStore';

type RecoveryKeyStorage = ReturnType<typeof recoveryKeyStorageStatus>;

export interface CloudAccountWrapPorts {
  usesContainerVault(): boolean;
  approvalClient(): LocalVaultApprovalClient | null;
  /** Publishes the unlocked vault to the rest of the app (sulla.ts onVaultUnlocked). */
  publishVaultUnlocked(): Promise<void>;
  recoveryKeyStorageStatus(): RecoveryKeyStorage;
  saveRecoveryKey(userId: string, recoveryKey: string): Promise<RecoveryKeyStorage>;
  /** Sends `sulla-cloud:recovery-key-created` to every open window. */
  announceRecoveryKey(notice: CloudRecoveryKeyNotice): void;
  /** True while first-run-state.json holds the expired-sign-in hold (`credentialsSaved === false`). */
  hasExpiredSignInHold(): boolean;
  clearExpiredSignInHold(): void;
  trace(message: string, details?: Record<string, unknown>): void;
  logger: { warn(message: string, detail?: unknown): void };
}

/**
 * The Cloud-password-derived vault key between sign-in and the vault: holds it
 * in memory, hands it to the vault to create or re-key ("account wrap"), and
 * publishes the recovery key the vault makes the first time.
 */
export class CloudAccountWrapService {
  constructor(
    private readonly keys: CloudSessionKeyStore,
    private readonly notices: CloudRecoveryKeyNoticeStore,
    private readonly ports: CloudAccountWrapPorts,
  ) {}

  retain(key: Uint8Array, kdf: AccountKdf, userId: string): void {
    this.ports.trace('vault key derived from the Cloud password and held in memory', { userId });
    // A fresh sign-in ends the hold that an expired first-run session left in
    // first-run-state.json. Nothing else clears it, and while it is set the
    // vault is never created, so the key would sit in memory until quit.
    if (this.ports.hasExpiredSignInHold()) {
      this.ports.clearExpiredSignInHold();
      this.ports.trace('cleared the expired-sign-in hold; a fresh Cloud key is here');
    }
    this.keys.retain(key, kdf, userId);
  }

  /**
   * D2 consumes this key when the vault is ready. Ownership transfers to the
   * caller, which must zero it after wrapping/flush. Nothing is persisted.
   */
  take(): Uint8Array | undefined {
    return this.keys.take();
  }

  clear(): void {
    this.keys.clear();
  }

  hasPendingKey(): boolean {
    return !!this.keys.context().key;
  }

  pendingKey(): Uint8Array | undefined {
    return this.keys.context().key;
  }

  pendingUserId(): string | undefined {
    return this.keys.context().userId;
  }

  async flush(userId = this.keys.context().userId): Promise<{ recoveryKey?: string }> {
    const { key, kdf } = this.keys.context();
    if (!key || !kdf || !userId || !this.ports.usesContainerVault()) {
      return {};
    }
    const attemptKey = Uint8Array.from(key);
    try {
      const client = this.ports.approvalClient();
      if (!client) throw new Error('Desktop vault account-wrap service is unavailable');
      this.ports.trace('creating or re-keying the vault with the Cloud key', { userId });
      const result = await client.rewrapForAccountPassword({ masterKey: Buffer.from(attemptKey).toString('base64url'), cloudUserId: userId, kdf });
      this.ports.trace('vault accepted the Cloud key', { recoveryKeyCreated: !!result.recoveryKey });
      // The vault is authoritative now. Publish before optional Keychain/UI work.
      await this.ports.publishVaultUnlocked();
      this.keys.clear();
      if (result.recoveryKey) {
        let storage = this.ports.recoveryKeyStorageStatus();
        try {
          storage = await this.ports.saveRecoveryKey(userId, result.recoveryKey);
        } catch (error) {
          this.ports.logger.warn('[SullaCloudAuth] Recovery key was created but Keychain save failed:', error instanceof Error ? error.message : String(error));
        }
        this.ports.announceRecoveryKey(this.notices.publish(result.recoveryKey, storage));
      }
      return { recoveryKey: result.recoveryKey };
    } finally {
      attemptKey.fill(0);
    }
  }

  /** Signed-in password flows re-wrap right away; a failure only means the migration is still pending. */
  async flushAfterSignIn(userId: string): Promise<void> {
    await this.flush(userId).catch((error) => {
      this.ports.logger.warn('[SullaCloudAuth] Account-password vault migration is pending:', error instanceof Error ? error.message : String(error));
    });
  }
}
