// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Sulla vault sync v3: wire types, canonical JSON and the shared error type.
//
// The envelope build/verify code itself lives in @sulla/domain (VaultSyncCodec,
// DefaultVaultRecordCodec), reached through DomainVaultSyncCodec. Shape checks
// use the domain DTO schemas (VaultBundleDtoSchema, VaultRecordDtoSchema,
// VaultHeadDtoSchema). The known-answer fixture lives in
// browserEnvelope/vault-sync-v3-kat.json and is shared with the Passwords
// crypto worker in www-sulladesktop.
//
// Formats (all binary values base64url, no padding; canonical bytes = RFC 8785 JCS):
//   bundle  sulla-vault-sync-bundle v1|v2   wrapped user key + KDF params, MAC'd
//   record  sulla-vault-sync-record v1      one item/folder (or tombstone), MAC binds generation
//   head    sulla-vault-sync-head   v1      per-scope seq + hash of every record, MAC'd

import { createRequire } from 'node:module';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Sodium = any;

export interface AeadEnvelope { version: 1; algorithm: 'xchacha20-poly1305'; nonce: string; ciphertext: string }
export interface SyncItem { version: 1; encryptedItemKey: AeadEnvelope; ciphertext: AeadEnvelope }
export interface SyncKdf { alg: 'argon2id13'; salt: string; memoryBytes: number; ops: number }
export interface RecoveryWrap { kdf: SyncKdf; encryptedUserKey: AeadEnvelope }
export interface BundleFields {
  vaultId: string; vaultUserId: string; epoch: number; bundleGeneration: number; kdf: SyncKdf;
  encryptedUserKey: AeadEnvelope; publicKey: string; encryptedPrivateKey: AeadEnvelope;
  recovery?: RecoveryWrap;
}
export interface SyncBundle extends BundleFields { format: 'sulla-vault-sync-bundle'; v: 1 | 2; mac: string }
export interface RecordFields {
  vaultId: string; scope: string; kind: 'item' | 'folder'; id: string; generation: number; deleted: boolean;
  item?: SyncItem; encryptedName?: AeadEnvelope;
}
export interface SyncRecord extends RecordFields { format: 'sulla-vault-sync-record'; v: 1; mac: string }
export interface SyncHead { format: 'sulla-vault-sync-head'; v: 1; vaultId: string; scope: string; seq: number; stateHash: string; prevHeadMac: string; mac: string }

/**
 * libsodium-wrappers-sumo, resolved next to @sulla/vault-crypto (its pinned
 * owner), so the vault service needs no second copy or version.
 */
export async function loadSodium(): Promise<Sodium> {
  let sodium: Sodium;
  try {
    sodium = createRequire(import.meta.resolve('@sulla/vault-crypto'))('libsodium-wrappers-sumo');
  } catch {
    // Test runners that inline @sulla/vault-crypto resolve libsodium directly.
    sodium = (await import('libsodium-wrappers-sumo' as string)).default;
  }
  await sodium.ready;
  return sodium;
}

export class EnvelopeError extends Error {
  constructor(public readonly code: string, message?: string) {
    super(message || code);
  }
}

// ── RFC 8785 canonical JSON ─────────────────────────────────────────────
// Our objects only hold strings, safe integers, booleans, null, arrays and
// plain objects, so the number rule reduces to "integers only".
export function jcs(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new EnvelopeError('non_integer', 'Canonical JSON only carries safe integers');
    return String(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(jcs).join(',')}]`;
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort(compareUtf16);
    return `{${keys.map((k) => `${JSON.stringify(k)}:${jcs(obj[k])}`).join(',')}}`;
  }
  throw new EnvelopeError('bad_type', `Canonical JSON cannot carry ${typeof value}`);
}

function compareUtf16(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
