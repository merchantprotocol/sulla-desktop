// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Builds the Passwords sync v3 upload from local vault rows
// (VAULT-E2E-DESIGN.md §4 "What is uploaded").
//
// Only an explicit allowlist leaves the container: the bundle's wrapped keys
// and KDF parameters, and each item's existing ciphertext envelopes,
// byte-for-byte. Never the login-hash verifier, recovery rows, item_type,
// agent_policy, integration_ref, agent_wrapped_item_key, audit rows or the
// Cloud session. No I/O, so the allowlist is testable without a DB.

import type { AeadEnvelope, BundleFields, RecordFields, RecoveryWrap, SyncKdf } from './VaultSyncContracts.js';

export interface LocalAccountRow {
  id: string;
  public_key: string;
  encrypted_private_key: unknown;
  encrypted_user_key: unknown;
  kdf: unknown;
}

export interface LocalItemRow {
  id: string;
  ciphertext: unknown;
  encrypted_item_key: unknown;
}

export interface LocalRecoveryRow {
  recovery_salt: string;
  encrypted_user_key: unknown;
}

export interface BundleIds {
  vaultId: string;
  epoch: number;
  bundleGeneration: number;
}
export interface RecordIds {
  vaultId: string;
  generation: number;
}

export class ExportError extends Error {
  constructor(
    public readonly code: 'password_kdf_missing' | 'envelope_invalid',
    message: string,
  ) {
    super(message);
  }
}

type StoredKdfSource = { salt?: string; parameters?: { memoryBytes?: number; operations?: number } };

export class VaultSyncExportMapper {
  bundleFields(account: LocalAccountRow, ids: BundleIds, recovery?: LocalRecoveryRow | null): BundleFields {
    return {
      vaultId: ids.vaultId,
      vaultUserId: account.id,
      epoch: ids.epoch,
      bundleGeneration: ids.bundleGeneration,
      kdf: this.passwordKdf(account.kdf),
      encryptedUserKey: this.pickEnvelope(account.encrypted_user_key),
      publicKey: account.public_key,
      encryptedPrivateKey: this.pickEnvelope(account.encrypted_private_key),
      ...(recovery ? { recovery: this.recoveryWrap(recovery) } : {}),
    };
  }

  itemRecordFields(row: LocalItemRow, ids: RecordIds): RecordFields {
    return {
      vaultId: ids.vaultId,
      scope: 'personal',
      kind: 'item',
      id: row.id,
      generation: ids.generation,
      deleted: false,
      item: { version: 1, encryptedItemKey: this.pickEnvelope(row.encrypted_item_key), ciphertext: this.pickEnvelope(row.ciphertext) },
    };
  }

  tombstoneFields(id: string, ids: RecordIds): RecordFields {
    return { vaultId: ids.vaultId, scope: 'personal', kind: 'item', id, generation: ids.generation, deleted: true };
  }

  /** Copy exactly the four envelope fields; anything else on the stored object is dropped. */
  private pickEnvelope(value: unknown): AeadEnvelope {
    const env = value as Record<string, unknown> | null;
    if (
      !env ||
      env.version !== 1 ||
      env.algorithm !== 'xchacha20-poly1305' ||
      typeof env.nonce !== 'string' ||
      typeof env.ciphertext !== 'string'
    ) {
      throw new ExportError('envelope_invalid', 'A stored envelope is not xchacha20-poly1305 v1');
    }
    return { version: 1, algorithm: 'xchacha20-poly1305', nonce: env.nonce, ciphertext: env.ciphertext };
  }

  /**
   * The password KDF the bundle is wrapped under. Migrated vaults that only
   * unlock through the OS-protected cache have none, so they can't be opened in
   * a browser until the owner sets a master password.
   */
  private passwordKdf(kdf: unknown): SyncKdf {
    const stored = kdf as (StoredKdfSource & { password?: StoredKdfSource }) | null;
    const source = stored?.password?.salt ? stored.password : stored?.salt ? stored : null;
    if (!source?.salt || !source.parameters?.memoryBytes || !source.parameters.operations) {
      throw new ExportError('password_kdf_missing', 'Set a master password in the Desktop vault before turning on Cloud sync');
    }
    return { alg: 'argon2id13', salt: source.salt, memoryBytes: source.parameters.memoryBytes, ops: source.parameters.operations };
  }

  private recoveryWrap(row: LocalRecoveryRow): RecoveryWrap {
    let metadata: { kdf?: string; parameters?: { memoryBytes?: number; operations?: number } };
    try {
      metadata = JSON.parse(row.recovery_salt);
    } catch {
      throw new ExportError('password_kdf_missing', 'Recovery KDF metadata is malformed');
    }
    if (!metadata.kdf || !metadata.parameters?.memoryBytes || !metadata.parameters.operations) {
      throw new ExportError('password_kdf_missing', 'Recovery KDF metadata is missing');
    }
    return {
      kdf: { alg: 'argon2id13', salt: metadata.kdf, memoryBytes: metadata.parameters.memoryBytes, ops: metadata.parameters.operations },
      encryptedUserKey: this.pickEnvelope(row.encrypted_user_key),
    };
  }
}
