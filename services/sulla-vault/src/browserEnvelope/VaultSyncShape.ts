// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Strict allowlist shape checks for Passwords sync v3. @sulla/domain v0.2.0 has
// no equivalent: its codec trusts typed input and its KDF check differs (it
// decodes the salt and has no kdf_shape code). These checks run before any
// domain call, so every malformed body keeps its established error code.
// Replace with the domain's strict checks once it ships ones with the same
// acceptance and codes.

/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  EnvelopeError,
  type AeadEnvelope,
  type SyncBundle,
  type SyncHead,
  type SyncItem,
  type SyncKdf,
  type SyncRecord,
} from './VaultSyncContracts.js';

export class VaultSyncShape {
  static readonly FORMAT = Object.freeze({
    bundle: 'sulla-vault-sync-bundle',
    record: 'sulla-vault-sync-record',
    head: 'sulla-vault-sync-head',
  } as const);

  /** Record/head protocol remains v1; bundle parsing separately accepts v1 and v2. */
  static readonly SUPPORTED_VERSION = 1;

  static readonly KDF_BOUNDS = Object.freeze({
    minMemoryBytes: 64 * 1024 * 1024,
    maxMemoryBytes: 1024 * 1024 * 1024,
    minOps: 2,
    maxOps: 10,
  });

  private static readonly KEY_BYTES = 32;
  private static readonly B64 = /^[A-Za-z0-9_-]+$/;
  private static readonly UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  private static readonly BUNDLE_FIELDS = [
    'format',
    'v',
    'vaultId',
    'vaultUserId',
    'epoch',
    'bundleGeneration',
    'kdf',
    'encryptedUserKey',
    'publicKey',
    'encryptedPrivateKey',
    'mac',
  ];
  private static readonly RECORD_FIELDS = ['format', 'v', 'vaultId', 'scope', 'kind', 'id', 'generation', 'deleted', 'mac'];
  private static readonly HEAD_FIELDS = ['format', 'v', 'vaultId', 'scope', 'seq', 'stateHash', 'prevHeadMac', 'mac'];

  assertKey(key: unknown): asserts key is Uint8Array {
    if (!(key instanceof Uint8Array) || key.byteLength !== VaultSyncShape.KEY_BYTES)
      throw new EnvelopeError('bad_key', 'Key must be 32 bytes');
  }

  isAeadEnvelope(env: any): env is AeadEnvelope {
    return (
      this.exactKeys(env, ['version', 'algorithm', 'nonce', 'ciphertext']) &&
      env.version === 1 &&
      env.algorithm === 'xchacha20-poly1305' &&
      this.isB64(env.nonce, 32, 32) &&
      this.isB64(env.ciphertext, 22)
    );
  }

  isEncryptedItem(item: any): item is SyncItem {
    return (
      this.exactKeys(item, ['version', 'encryptedItemKey', 'ciphertext']) &&
      item.version === 1 &&
      this.isAeadEnvelope(item.encryptedItemKey) &&
      this.isAeadEnvelope(item.ciphertext)
    );
  }

  checkKdf(kdf: any): asserts kdf is SyncKdf {
    const bounds = VaultSyncShape.KDF_BOUNDS;
    if (!this.exactKeys(kdf, ['alg', 'salt', 'memoryBytes', 'ops'])) throw new EnvelopeError('kdf_shape', 'KDF parameters are malformed');
    if (kdf.alg !== 'argon2id13') throw new EnvelopeError('kdf_alg', 'Unsupported KDF');
    if (!this.isB64(kdf.salt, 22, 22)) throw new EnvelopeError('kdf_salt', 'KDF salt must be 16 bytes');
    if (!Number.isSafeInteger(kdf.memoryBytes) || kdf.memoryBytes < bounds.minMemoryBytes || kdf.memoryBytes > bounds.maxMemoryBytes) {
      throw new EnvelopeError('kdf_bounds', 'KDF memory cost is outside the allowed range');
    }
    if (!Number.isSafeInteger(kdf.ops) || kdf.ops < bounds.minOps || kdf.ops > bounds.maxOps) {
      throw new EnvelopeError('kdf_bounds', 'KDF time cost is outside the allowed range');
    }
  }

  checkBundle(bundle: any): asserts bundle is SyncBundle {
    const optional = bundle?.v === 2 ? ['recovery'] : [];
    if (!this.exactKeys(bundle, VaultSyncShape.BUNDLE_FIELDS, optional))
      throw new EnvelopeError('bundle_shape', 'Vault bundle has unexpected fields');
    if (bundle.format !== VaultSyncShape.FORMAT.bundle) throw new EnvelopeError('bundle_shape', 'Not a vault sync bundle');
    if (bundle.v !== 1 && bundle.v !== 2) throw new EnvelopeError('unsupported_version', 'Vault bundle version is newer than this app');
    if (!this.isId(bundle.vaultId) || !this.isId(bundle.vaultUserId)) throw new EnvelopeError('bundle_shape', 'Vault ids are malformed');
    if (!this.isCounter(bundle.epoch) || !this.isCounter(bundle.bundleGeneration)) {
      throw new EnvelopeError('bundle_shape', 'Vault bundle counters are malformed');
    }
    this.checkKdf(bundle.kdf);
    if (
      !this.isAeadEnvelope(bundle.encryptedUserKey) ||
      !this.isAeadEnvelope(bundle.encryptedPrivateKey) ||
      !this.isB64(bundle.publicKey, 43, 43) ||
      !this.isB64(bundle.mac, 43, 43)
    ) {
      throw new EnvelopeError('bundle_shape', 'Vault bundle key material is malformed');
    }
    if (bundle.v === 1 && bundle.recovery !== undefined) throw new EnvelopeError('bundle_shape', 'Bundle v1 cannot carry a recovery wrap');
    if (bundle.v === 2) {
      if (!this.exactKeys(bundle.recovery, ['kdf', 'encryptedUserKey']))
        throw new EnvelopeError('bundle_shape', 'Recovery wrap is malformed');
      this.checkKdf(bundle.recovery.kdf);
      if (!this.isAeadEnvelope(bundle.recovery.encryptedUserKey)) throw new EnvelopeError('bundle_shape', 'Recovery wrap is malformed');
    }
  }

  checkRecord(record: any): asserts record is SyncRecord {
    if (!record || typeof record !== 'object') throw new EnvelopeError('record_shape', 'Record is malformed');
    if (record.v !== undefined && record.v > VaultSyncShape.SUPPORTED_VERSION) {
      throw new EnvelopeError('unsupported_version', 'Record version is newer than this app');
    }
    const optional = record.deleted ? [] : record.kind === 'item' ? ['item'] : ['encryptedName'];
    if (!this.exactKeys(record, [...VaultSyncShape.RECORD_FIELDS, ...optional]))
      throw new EnvelopeError('record_shape', 'Record has unexpected fields');
    if (record.format !== VaultSyncShape.FORMAT.record || record.v !== VaultSyncShape.SUPPORTED_VERSION) {
      throw new EnvelopeError('record_shape', 'Not a vault sync record');
    }
    if (!this.isId(record.vaultId) || !this.isScope(record.scope) || !this.isId(record.id))
      throw new EnvelopeError('record_shape', 'Record ids are malformed');
    if (record.kind !== 'item' && record.kind !== 'folder') throw new EnvelopeError('record_shape', 'Record kind is unknown');
    if (!this.isCounter(record.generation) || typeof record.deleted !== 'boolean') {
      throw new EnvelopeError('record_shape', 'Record generation is malformed');
    }
    if (!record.deleted && record.kind === 'item' && !this.isEncryptedItem(record.item)) {
      throw new EnvelopeError('record_shape', 'Record item envelope is malformed');
    }
    if (!record.deleted && record.kind === 'folder' && !this.isAeadEnvelope(record.encryptedName)) {
      throw new EnvelopeError('record_shape', 'Record folder name is malformed');
    }
    if (!this.isB64(record.mac, 43, 43)) throw new EnvelopeError('record_shape', 'Record MAC is malformed');
  }

  checkHead(head: any): asserts head is SyncHead {
    if (!this.exactKeys(head, VaultSyncShape.HEAD_FIELDS)) throw new EnvelopeError('head_shape', 'Manifest head has unexpected fields');
    if (head.format !== VaultSyncShape.FORMAT.head) throw new EnvelopeError('head_shape', 'Not a manifest head');
    if (head.v !== VaultSyncShape.SUPPORTED_VERSION)
      throw new EnvelopeError('unsupported_version', 'Manifest head version is newer than this app');
    if (!this.isId(head.vaultId) || !this.isScope(head.scope) || !this.isCounter(head.seq))
      throw new EnvelopeError('head_shape', 'Manifest head is malformed');
    if (!this.isB64(head.stateHash, 43, 43) || !this.isB64(head.mac, 43, 43))
      throw new EnvelopeError('head_shape', 'Manifest head hashes are malformed');
    if (head.prevHeadMac !== '' && !this.isB64(head.prevHeadMac, 43, 43))
      throw new EnvelopeError('head_shape', 'Manifest head chain is malformed');
  }

  private exactKeys(obj: any, required: string[], optional: string[] = []): boolean {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
    const allowed = new Set([...required, ...optional]);
    for (const key of Object.keys(obj)) if (!allowed.has(key)) return false;
    return required.every((key) => Object.prototype.hasOwnProperty.call(obj, key));
  }

  private isB64(value: unknown, min = 1, max = 1 << 20): value is string {
    return typeof value === 'string' && value.length >= min && value.length <= max && VaultSyncShape.B64.test(value);
  }

  private isCounter(value: unknown): boolean {
    return Number.isSafeInteger(value) && (value as number) >= 1;
  }

  private isId(value: unknown): value is string {
    return typeof value === 'string' && VaultSyncShape.UUID.test(value);
  }

  private isScope(value: unknown): value is string {
    return value === 'personal' || this.isId(value);
  }
}
