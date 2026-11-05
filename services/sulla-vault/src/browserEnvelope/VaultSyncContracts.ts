// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Passwords sync v3 wire shapes (VAULT-E2E-DESIGN.md §2–§3) and the one error
// type the vault container reports for them. All binary values are base64url
// without padding; canonical bytes are RFC 8785 JCS (@sulla/domain CanonicalJson).
//
//   bundle  sulla-vault-sync-bundle v1|v2  wrapped user key + KDF params, MAC'd
//   record  sulla-vault-sync-record v1     one item/folder (or tombstone), MAC binds generation
//   head    sulla-vault-sync-head   v1     per-scope seq + hash of every record, MAC'd

import { CryptoError } from '@sulla/domain';

export interface AeadEnvelope {
  version: 1;
  algorithm: 'xchacha20-poly1305';
  nonce: string;
  ciphertext: string;
}
export interface SyncItem {
  version: 1;
  encryptedItemKey: AeadEnvelope;
  ciphertext: AeadEnvelope;
}
export interface SyncKdf {
  alg: 'argon2id13';
  salt: string;
  memoryBytes: number;
  ops: number;
}
export interface RecoveryWrap {
  kdf: SyncKdf;
  encryptedUserKey: AeadEnvelope;
}
export interface BundleFields {
  vaultId: string;
  vaultUserId: string;
  epoch: number;
  bundleGeneration: number;
  kdf: SyncKdf;
  encryptedUserKey: AeadEnvelope;
  publicKey: string;
  encryptedPrivateKey: AeadEnvelope;
  recovery?: RecoveryWrap;
}
export interface SyncBundle extends BundleFields {
  format: 'sulla-vault-sync-bundle';
  v: 1 | 2;
  mac: string;
}
export interface RecordFields {
  vaultId: string;
  scope: string;
  kind: 'item' | 'folder';
  id: string;
  generation: number;
  deleted: boolean;
  item?: SyncItem;
  encryptedName?: AeadEnvelope;
}
export interface SyncRecord extends RecordFields {
  format: 'sulla-vault-sync-record';
  v: 1;
  mac: string;
}
export interface SyncHead {
  format: 'sulla-vault-sync-head';
  v: 1;
  vaultId: string;
  scope: string;
  seq: number;
  stateHash: string;
  prevHeadMac: string;
  mac: string;
}
export type StateRecord = Pick<SyncRecord, 'id' | 'generation' | 'deleted' | 'mac'>;
export interface HeadInput {
  vaultId: string;
  scope: string;
  seq: number;
  records: Iterable<SyncRecord>;
  prevHeadMac?: string;
}
export interface HeadExpectation {
  vaultId: string;
  scope: string;
  records: Iterable<SyncRecord>;
  minSeq?: number;
  expectedPrevHeadMac?: string;
}
export interface RecordExpectation {
  vaultId: string;
  scope: string;
  id?: string;
}

/** The established, observable sync failure: `code` is the stable contract, `message` is shown to the owner. */
export class EnvelopeError extends Error {
  private static readonly DOMAIN_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
    bundle_mac: 'Vault bundle failed its integrity check',
    record_moved: 'Record belongs to another vault or scope',
    record_mac: 'Record failed its integrity check',
    decrypt_failed: 'Decryption failed',
    wrong_password: 'Wrong master password',
    non_integer: 'Canonical JSON only carries safe integers',
    bad_type: 'Canonical JSON cannot carry this value',
  });

  constructor(
    public readonly code: string,
    message?: string,
  ) {
    super(message || code);
  }

  /**
   * Translate a failure raised inside @sulla/domain. A `TypeError` there comes from
   * base64url decoding of a MAC that passed the shape check but is non-canonical;
   * libsodium treated that as a MAC mismatch, so it maps to `macFailureCode`.
   */
  static fromDomain(error: unknown, macFailureCode?: string): EnvelopeError | unknown {
    if (error instanceof CryptoError) return new EnvelopeError(error.code, EnvelopeError.DOMAIN_MESSAGES[error.code]);
    if (macFailureCode && error instanceof TypeError)
      return new EnvelopeError(macFailureCode, EnvelopeError.DOMAIN_MESSAGES[macFailureCode]);
    return error;
  }
}
