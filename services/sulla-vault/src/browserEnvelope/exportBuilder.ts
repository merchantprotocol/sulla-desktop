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
// Cloud session. Pure functions, so the allowlist is testable without a DB.

import type { AeadEnvelope, BundleFields, RecordFields, RecoveryWrap, SyncKdf } from './envelope.js';

/** Local columns that must never appear in an upload. Used by the allowlist test. */
export const NEVER_UPLOADED = [
  'login_hash_salt', 'login_hash_verifier', 'item_type', 'agent_policy', 'integration_ref', 'agent_wrapped_item_key',
  'agentWrappedItemKey', 'recovery', 'local_vault_recovery', 'email', 'display_name',
] as const;

export interface LocalAccountRow {
  id:                    string;
  public_key:            string;
  encrypted_private_key: unknown;
  encrypted_user_key:    unknown;
  kdf:                   unknown;
}

export interface LocalItemRow {
  id:                 string;
  ciphertext:         unknown;
  encrypted_item_key: unknown;
}

export interface LocalRecoveryRow { recovery_salt: string; encrypted_user_key: unknown }

export class ExportError extends Error {
  constructor(public readonly code: 'password_kdf_missing' | 'envelope_invalid', message: string) {
    super(message);
  }
}

/** Copy exactly the four envelope fields; anything else on the stored object is dropped. */
export function pickEnvelope(value: unknown): AeadEnvelope {
  const env = value as Record<string, unknown> | null;
  if (!env || env.version !== 1 || env.algorithm !== 'xchacha20-poly1305' || typeof env.nonce !== 'string' || typeof env.ciphertext !== 'string') {
    throw new ExportError('envelope_invalid', 'A stored envelope is not xchacha20-poly1305 v1');
  }
  return { version: 1, algorithm: 'xchacha20-poly1305', nonce: env.nonce, ciphertext: env.ciphertext };
}

/**
 * The password KDF the bundle is wrapped under. Migrated vaults that only
 * unlock through the OS-protected cache have none, so they can't be opened in
 * a browser until the owner sets a master password.
 */
export function passwordKdf(kdf: unknown): SyncKdf {
  const stored = kdf as { password?: { salt?: string; parameters?: { memoryBytes?: number; operations?: number } }; salt?: string; parameters?: { memoryBytes?: number; operations?: number } } | null;
  const source = stored?.password?.salt ? stored.password : stored?.salt ? stored : null;
  if (!source?.salt || !source.parameters?.memoryBytes || !source.parameters.operations) {
    throw new ExportError('password_kdf_missing', 'Set a master password in the Desktop vault before turning on Cloud sync');
  }
  return { alg: 'argon2id13', salt: source.salt, memoryBytes: source.parameters.memoryBytes, ops: source.parameters.operations };
}

export function bundleFields(
  account: LocalAccountRow,
  ids: { vaultId: string; epoch: number; bundleGeneration: number },
  recovery?: LocalRecoveryRow | null,
): BundleFields {
  return {
    vaultId:             ids.vaultId,
    vaultUserId:         account.id,
    epoch:               ids.epoch,
    bundleGeneration:    ids.bundleGeneration,
    kdf:                 passwordKdf(account.kdf),
    encryptedUserKey:    pickEnvelope(account.encrypted_user_key),
    publicKey:           account.public_key,
    encryptedPrivateKey: pickEnvelope(account.encrypted_private_key),
    ...(recovery ? { recovery: recoveryWrap(recovery) } : {}),
  };
}

export function recoveryWrap(row: LocalRecoveryRow): RecoveryWrap {
  let metadata: { kdf?: string; parameters?: { memoryBytes?: number; operations?: number } };
  try { metadata = JSON.parse(row.recovery_salt) } catch { throw new ExportError('password_kdf_missing', 'Recovery KDF metadata is malformed') }
  if (!metadata.kdf || !metadata.parameters?.memoryBytes || !metadata.parameters.operations) {
    throw new ExportError('password_kdf_missing', 'Recovery KDF metadata is missing');
  }
  return {
    kdf: { alg: 'argon2id13', salt: metadata.kdf, memoryBytes: metadata.parameters.memoryBytes, ops: metadata.parameters.operations },
    encryptedUserKey: pickEnvelope(row.encrypted_user_key),
  };
}

export function itemRecordFields(row: LocalItemRow, ids: { vaultId: string; generation: number }): RecordFields {
  return {
    vaultId:    ids.vaultId,
    scope:      'personal',
    kind:       'item',
    id:         row.id,
    generation: ids.generation,
    deleted:    false,
    item:       { version: 1, encryptedItemKey: pickEnvelope(row.encrypted_item_key), ciphertext: pickEnvelope(row.ciphertext) },
  };
}

export function tombstoneFields(id: string, ids: { vaultId: string; generation: number }): RecordFields {
  return { vaultId: ids.vaultId, scope: 'personal', kind: 'item', id, generation: ids.generation, deleted: true };
}
