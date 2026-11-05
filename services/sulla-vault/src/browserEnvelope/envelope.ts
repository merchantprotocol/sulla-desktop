// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Sulla vault sync v3: envelope build/verify (VAULT-E2E-DESIGN.md §2–§3).
//
// TypeScript port of www-sulladesktop js/cloud/passwords/sync-envelope.js,
// which the Passwords crypto worker runs in the browser. Both are pinned to
// the same known-answer fixture (browserEnvelope/vault-sync-v3-kat.json), so
// a change here needs the same change there.
//
// Formats (all binary values base64url, no padding; canonical bytes = RFC 8785 JCS):
//   bundle  sulla-vault-sync-bundle v1   wrapped user key + KDF params, MAC'd
//   record  sulla-vault-sync-record v1   one item/folder (or tombstone), MAC binds generation
//   head    sulla-vault-sync-head   v1   per-scope seq + hash of every record, MAC'd
//
// TEMP until @sulla/domain v0.2.1 sealRecord/sealHead/code-unit stateHash; delete then.
// Every MAC uses a subkey derived from the scope key with crypto_kdf
// (context "SVsync01"), never the scope key itself. Every MAC input carries
// its format tag, so a record MAC can never verify as a head MAC.

import { createRequire } from 'node:module';
import { CanonicalJson, CryptoError, type VaultBundle, type VaultRecord } from '@sulla/domain';

import { VaultSyncRuntime } from './VaultSyncRuntime.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Sodium = any;

export const FORMAT = {
  bundle: 'sulla-vault-sync-bundle',
  record: 'sulla-vault-sync-record',
  head: 'sulla-vault-sync-head',
} as const;

/** Record/head protocol remains v1; bundle parsing separately accepts v1 and v2. */
export const SUPPORTED_VERSION = 1;

export interface AeadEnvelope { version: 1; algorithm: 'xchacha20-poly1305'; nonce: string; ciphertext: string }
export interface SyncItem { version: 1; encryptedItemKey: AeadEnvelope; ciphertext: AeadEnvelope }
export interface SyncKdf { alg: 'argon2id13'; salt: string; memoryBytes: number; ops: number }
export interface RecoveryWrap { kdf: SyncKdf; encryptedUserKey: AeadEnvelope }
export interface BundleFields {
  vaultId: string; vaultUserId: string; epoch: number; bundleGeneration: number; kdf: SyncKdf;
  encryptedUserKey: AeadEnvelope; publicKey: string; encryptedPrivateKey: AeadEnvelope;
  recovery?: RecoveryWrap;
}
export interface SyncBundle extends BundleFields { format: typeof FORMAT.bundle; v: 1 | 2; mac: string }
export interface RecordFields {
  vaultId: string; scope: string; kind: 'item' | 'folder'; id: string; generation: number; deleted: boolean;
  item?: SyncItem; encryptedName?: AeadEnvelope;
}
export interface SyncRecord extends RecordFields { format: typeof FORMAT.record; v: 1; mac: string }
export interface SyncHead { format: typeof FORMAT.head; v: 1; vaultId: string; scope: string; seq: number; stateHash: string; prevHeadMac: string; mac: string }

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

export type SyncEnvelope = ReturnType<typeof createSyncEnvelope>;

export const KDF_BOUNDS = Object.freeze({
  minMemoryBytes: 64 * 1024 * 1024,
  maxMemoryBytes: 1024 * 1024 * 1024,
  minOps: 2,
  maxOps: 10,
  saltBytes: 16,
});

export const LIMITS = Object.freeze({ recordBytes: 64 * 1024 });

const KDF_CONTEXT = 'SVsync01';
const MAC_SUBKEY_ID = 1;
const KEY_BYTES = 32;
const B64 = /^[A-Za-z0-9_-]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class EnvelopeError extends Error {
  constructor(public readonly code: string, message?: string) {
    super(message || code);
  }
}

// ── RFC 8785 canonical JSON ─────────────────────────────────────────────
// Our objects only hold strings, safe integers, booleans, null, arrays and
// plain objects, so the number rule reduces to "integers only".
export function jcs(value: unknown): string {
  try {
    return new CanonicalJson().stringify(value);
  } catch (error) {
    if (error instanceof CryptoError) throw new EnvelopeError(error.code);
    throw error;
  }
}

function compareUtf16(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ── Shape checks (strict allowlists: unknown fields are rejected) ───────
function exactKeys(obj: any, required: string[], optional: string[] = []): boolean {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const allowed = new Set([...required, ...optional]);
  for (const k of Object.keys(obj)) if (!allowed.has(k)) return false;
  return required.every((k) => Object.prototype.hasOwnProperty.call(obj, k));
}

function isB64(value: unknown, min = 1, max = 1 << 20): value is string {
  return typeof value === 'string' && value.length >= min && value.length <= max && B64.test(value);
}

export function isAeadEnvelope(env: any): env is AeadEnvelope {
  return exactKeys(env, ['version', 'algorithm', 'nonce', 'ciphertext'])
    && env.version === 1 && env.algorithm === 'xchacha20-poly1305'
    && isB64(env.nonce, 32, 32) && isB64(env.ciphertext, 22);
}

function isEncryptedItem(item: any): item is SyncItem {
  return exactKeys(item, ['version', 'encryptedItemKey', 'ciphertext'])
    && item.version === 1 && isAeadEnvelope(item.encryptedItemKey) && isAeadEnvelope(item.ciphertext);
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

function isScope(value: unknown): value is string {
  return value === 'personal' || isId(value);
}

export function checkKdf(kdf: any): asserts kdf is SyncKdf {
  if (!exactKeys(kdf, ['alg', 'salt', 'memoryBytes', 'ops'])) throw new EnvelopeError('kdf_shape', 'KDF parameters are malformed');
  if (kdf.alg !== 'argon2id13') throw new EnvelopeError('kdf_alg', 'Unsupported KDF');
  if (!isB64(kdf.salt, 22, 22)) throw new EnvelopeError('kdf_salt', 'KDF salt must be 16 bytes');
  if (!Number.isSafeInteger(kdf.memoryBytes) || kdf.memoryBytes < KDF_BOUNDS.minMemoryBytes || kdf.memoryBytes > KDF_BOUNDS.maxMemoryBytes) {
    throw new EnvelopeError('kdf_bounds', 'KDF memory cost is outside the allowed range');
  }
  if (!Number.isSafeInteger(kdf.ops) || kdf.ops < KDF_BOUNDS.minOps || kdf.ops > KDF_BOUNDS.maxOps) {
    throw new EnvelopeError('kdf_bounds', 'KDF time cost is outside the allowed range');
  }
}

const BUNDLE_FIELDS = ['format', 'v', 'vaultId', 'vaultUserId', 'epoch', 'bundleGeneration', 'kdf', 'encryptedUserKey', 'publicKey', 'encryptedPrivateKey', 'mac'];

export function checkBundleShape(bundle: any): asserts bundle is SyncBundle {
  if (!exactKeys(bundle, BUNDLE_FIELDS, bundle?.v === 2 ? ['recovery'] : [])) throw new EnvelopeError('bundle_shape', 'Vault bundle has unexpected fields');
  if (bundle.format !== FORMAT.bundle) throw new EnvelopeError('bundle_shape', 'Not a vault sync bundle');
  if (bundle.v !== 1 && bundle.v !== 2) throw new EnvelopeError('unsupported_version', 'Vault bundle version is newer than this app');
  if (!isId(bundle.vaultId) || !isId(bundle.vaultUserId)) throw new EnvelopeError('bundle_shape', 'Vault ids are malformed');
  if (!Number.isSafeInteger(bundle.epoch) || bundle.epoch < 1 || !Number.isSafeInteger(bundle.bundleGeneration) || bundle.bundleGeneration < 1) {
    throw new EnvelopeError('bundle_shape', 'Vault bundle counters are malformed');
  }
  checkKdf(bundle.kdf);
  if (!isAeadEnvelope(bundle.encryptedUserKey) || !isAeadEnvelope(bundle.encryptedPrivateKey) || !isB64(bundle.publicKey, 43, 43) || !isB64(bundle.mac, 43, 43)) {
    throw new EnvelopeError('bundle_shape', 'Vault bundle key material is malformed');
  }
  if (bundle.v === 1 && bundle.recovery !== undefined) throw new EnvelopeError('bundle_shape', 'Bundle v1 cannot carry a recovery wrap');
  if (bundle.v === 2) {
    if (!exactKeys(bundle.recovery, ['kdf', 'encryptedUserKey'])) throw new EnvelopeError('bundle_shape', 'Recovery wrap is malformed');
    checkKdf(bundle.recovery.kdf);
    if (!isAeadEnvelope(bundle.recovery.encryptedUserKey)) throw new EnvelopeError('bundle_shape', 'Recovery wrap is malformed');
  }
}

const RECORD_FIELDS = ['format', 'v', 'vaultId', 'scope', 'kind', 'id', 'generation', 'deleted', 'mac'];

export function checkRecordShape(record: any): asserts record is SyncRecord {
  if (!record || typeof record !== 'object') throw new EnvelopeError('record_shape', 'Record is malformed');
  if (record.v !== undefined && record.v > SUPPORTED_VERSION) throw new EnvelopeError('unsupported_version', 'Record version is newer than this app');
  const optional = record.deleted ? [] : record.kind === 'item' ? ['item'] : ['encryptedName'];
  if (!exactKeys(record, [...RECORD_FIELDS, ...optional])) throw new EnvelopeError('record_shape', 'Record has unexpected fields');
  if (record.format !== FORMAT.record || record.v !== SUPPORTED_VERSION) throw new EnvelopeError('record_shape', 'Not a vault sync record');
  if (!isId(record.vaultId) || !isScope(record.scope) || !isId(record.id)) throw new EnvelopeError('record_shape', 'Record ids are malformed');
  if (record.kind !== 'item' && record.kind !== 'folder') throw new EnvelopeError('record_shape', 'Record kind is unknown');
  if (!Number.isSafeInteger(record.generation) || record.generation < 1 || typeof record.deleted !== 'boolean') {
    throw new EnvelopeError('record_shape', 'Record generation is malformed');
  }
  if (!record.deleted && record.kind === 'item' && !isEncryptedItem(record.item)) throw new EnvelopeError('record_shape', 'Record item envelope is malformed');
  if (!record.deleted && record.kind === 'folder' && !isAeadEnvelope(record.encryptedName)) throw new EnvelopeError('record_shape', 'Record folder name is malformed');
  if (!isB64(record.mac, 43, 43)) throw new EnvelopeError('record_shape', 'Record MAC is malformed');
}

const HEAD_FIELDS = ['format', 'v', 'vaultId', 'scope', 'seq', 'stateHash', 'prevHeadMac', 'mac'];

export function checkHeadShape(head: any): asserts head is SyncHead {
  if (!exactKeys(head, HEAD_FIELDS)) throw new EnvelopeError('head_shape', 'Manifest head has unexpected fields');
  if (head.format !== FORMAT.head) throw new EnvelopeError('head_shape', 'Not a manifest head');
  if (head.v !== SUPPORTED_VERSION) throw new EnvelopeError('unsupported_version', 'Manifest head version is newer than this app');
  if (!isId(head.vaultId) || !isScope(head.scope) || !Number.isSafeInteger(head.seq) || head.seq < 1) throw new EnvelopeError('head_shape', 'Manifest head is malformed');
  if (!isB64(head.stateHash, 43, 43) || !isB64(head.mac, 43, 43)) throw new EnvelopeError('head_shape', 'Manifest head hashes are malformed');
  if (head.prevHeadMac !== '' && !isB64(head.prevHeadMac, 43, 43)) throw new EnvelopeError('head_shape', 'Manifest head chain is malformed');
}

// ── Crypto (sodium injected) ────────────────────────────────────────────
function throwDomainError(error: unknown): never {
  if (error instanceof CryptoError) {
    const code = error.code === 'recovery_unavailable' ? 'recovery_missing'
      : error.code === 'wrong_recovery_code' ? 'wrong_recovery_key'
        : error.code;
    throw new EnvelopeError(code);
  }
  throw error;
}

export function createSyncEnvelope(sodium: Sodium) {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const b64 = (bytes: Uint8Array): string => sodium.to_base64(bytes, sodium.base64_variants.URLSAFE_NO_PADDING);
  const unb64 = (value: string): Uint8Array => sodium.from_base64(value, sodium.base64_variants.URLSAFE_NO_PADDING);
  const runtime = new VaultSyncRuntime((length) => sodium.randombytes_buf(length));

  function assertKey(key: unknown): asserts key is Uint8Array {
    if (!(key instanceof Uint8Array) || key.byteLength !== KEY_BYTES) throw new EnvelopeError('bad_key', 'Key must be 32 bytes');
  }

  /** MAC subkey for one scope (personal: the user key; collection: its collection key). */
  function deriveMacKey(scopeKey: Uint8Array): Uint8Array {
    assertKey(scopeKey);
    return sodium.crypto_kdf_derive_from_key(KEY_BYTES, MAC_SUBKEY_ID, KDF_CONTEXT, scopeKey);
  }

  function mac(macKey: Uint8Array, fields: object): string {
    assertKey(macKey);
    return b64(sodium.crypto_generichash(KEY_BYTES, enc.encode(jcs(fields)), macKey));
  }

  function macEquals(expected: unknown, actual: unknown): boolean {
    if (typeof expected !== 'string' || typeof actual !== 'string' || expected.length !== actual.length) return false;
    try {
      return sodium.memcmp(unb64(expected), unb64(actual));
    } catch {
      return false;
    }
  }

  function sha256(value: unknown): string {
    return b64(sodium.crypto_hash_sha256(enc.encode(jcs(value))));
  }

  // vault-crypto compatible primitives (packages/vault-crypto/src/index.ts).
  function itemAad(purpose: 'key' | 'ciphertext', ownerId: string, itemId: string): string {
    return `sulla:item:${purpose}:v1:${JSON.stringify([ownerId, itemId])}`;
  }

  function seal(plaintext: Uint8Array, key: Uint8Array, aad: string): AeadEnvelope {
    assertKey(key);
    const nonce = sodium.randombytes_buf(24);
    const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(plaintext, enc.encode(aad), null, nonce, key);
    return { version: 1, algorithm: 'xchacha20-poly1305', nonce: b64(nonce), ciphertext: b64(ciphertext) };
  }

  function open(envelope: unknown, key: Uint8Array, aad: string): Uint8Array {
    assertKey(key);
    if (!isAeadEnvelope(envelope)) throw new EnvelopeError('envelope_shape', 'Encrypted envelope is malformed');
    try {
      return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, unb64(envelope.ciphertext), enc.encode(aad), unb64(envelope.nonce), key);
    } catch {
      throw new EnvelopeError('decrypt_failed', 'Decryption failed');
    }
  }

  /** Argon2id over the bundle's own parameters, after the bounds check. */
  function deriveMasterKey(password: string, kdf: unknown): Uint8Array {
    checkKdf(kdf);
    if (typeof password !== 'string' || !password) throw new EnvelopeError('password_required', 'Master password is required');
    return sodium.crypto_pwhash(KEY_BYTES, password, unb64(kdf.salt), kdf.ops, kdf.memoryBytes, sodium.crypto_pwhash_ALG_ARGON2ID13);
  }

  function bundleMacFields(bundle: SyncBundle): Omit<SyncBundle, 'mac'> {
    const { mac: _ignored, ...fields } = bundle;
    void _ignored;
    return fields;
  }

  function buildBundle(fields: BundleFields, userKey: Uint8Array): SyncBundle {
    assertKey(userKey);
    const body = { format: FORMAT.bundle, v: fields.recovery ? 2 as const : 1 as const, ...fields };
    const bundle = runtime.codec.sealBundle(body as Omit<VaultBundle, 'mac'>, userKey) as SyncBundle;
    checkBundleShape(bundle);
    return bundle;
  }

  function verifyBundle(bundle: unknown, userKey: Uint8Array): void {
    checkBundleShape(bundle);
    assertKey(userKey);
    try {
      runtime.codec.verifyBundle(bundle as VaultBundle, userKey);
    } catch (error) {
      throwDomainError(error);
    }
  }

  /**
   * Unlock a bundle with the master password. Throws `wrong_password` when the
   * AEAD rejects the wrap (decided locally, nothing is sent anywhere).
   * Returns the user key; the caller owns it and must zero it.
   */
  function unlockBundle(bundle: unknown, password: string): Uint8Array {
    checkBundleShape(bundle);
    try {
      return runtime.codec.unlockBundle(bundle as VaultBundle, password);
    } catch (error) {
      throwDomainError(error);
    }
  }

  /** Open the bundle-v2 recovery wrap. The recovery key and user key never leave the caller. */
  function unlockRecovery(bundle: unknown, recoveryKey: string): Uint8Array {
    checkBundleShape(bundle);
    try {
      return runtime.codec.unlockBundleWithRecovery(bundle as VaultBundle, recoveryKey);
    } catch (error) {
      throwDomainError(error);
    }
  }

  function contentHash(record: Pick<SyncRecord, 'deleted' | 'kind' | 'item' | 'encryptedName'>): string {
    if (record.deleted) return '';
    return sha256(record.kind === 'item' ? record.item : record.encryptedName);
  }

  function recordMacFields(record: Omit<SyncRecord, 'mac'>): object {
    return {
      format: FORMAT.record, v: SUPPORTED_VERSION, vaultId: record.vaultId, scope: record.scope, kind: record.kind,
      id: record.id, generation: record.generation, deleted: record.deleted, contentHash: contentHash(record),
    };
  }

  function buildRecord(fields: RecordFields, scopeKey: Uint8Array): SyncRecord {
    const record: any = {
      format: FORMAT.record, v: SUPPORTED_VERSION,
      vaultId: fields.vaultId, scope: fields.scope, kind: fields.kind, id: fields.id,
      generation: fields.generation, deleted: Boolean(fields.deleted),
    };
    if (!record.deleted && record.kind === 'item') record.item = { version: 1, encryptedItemKey: fields.item!.encryptedItemKey, ciphertext: fields.item!.ciphertext };
    if (!record.deleted && record.kind === 'folder') record.encryptedName = fields.encryptedName;
    const macKey = deriveMacKey(scopeKey);
    try {
      record.mac = mac(macKey, recordMacFields(record));
    } finally {
      macKey.fill(0);
    }
    checkRecordShape(record);
    return record;
  }

  /** Verify one record against the expected vault/scope. Throws on any mismatch. */
  function verifyRecord(record: unknown, scopeKey: Uint8Array, expect: { vaultId: string; scope: string; id?: string }): void {
    checkRecordShape(record);
    assertKey(scopeKey);
    try {
      runtime.codec.verifyRecord(record as VaultRecord, scopeKey, expect);
    } catch (error) {
      throwDomainError(error);
    }
  }

  function stateHash(records: Iterable<Pick<SyncRecord, 'id' | 'generation' | 'deleted' | 'mac'>>): string {
    const rows = [...records]
      .map((r) => [r.id, r.generation, r.deleted, r.mac] as [string, number, boolean, string])
      .sort((a, b) => compareUtf16(a[0], b[0]));
    for (let i = 1; i < rows.length; i++) if (rows[i][0] === rows[i - 1][0]) throw new EnvelopeError('duplicate_record', 'Two records share one id');
    return sha256(rows);
  }

  function headMacFields(head: Omit<SyncHead, 'mac'>): object {
    return { format: FORMAT.head, v: SUPPORTED_VERSION, vaultId: head.vaultId, scope: head.scope, seq: head.seq, stateHash: head.stateHash, prevHeadMac: head.prevHeadMac };
  }

  function buildHead(
    { vaultId, scope, seq, records, prevHeadMac = '' }: { vaultId: string; scope: string; seq: number; records: Iterable<SyncRecord>; prevHeadMac?: string },
    scopeKey: Uint8Array,
  ): SyncHead {
    const head: any = { format: FORMAT.head, v: SUPPORTED_VERSION, vaultId, scope, seq, stateHash: stateHash(records), prevHeadMac };
    const macKey = deriveMacKey(scopeKey);
    try {
      head.mac = mac(macKey, headMacFields(head));
    } finally {
      macKey.fill(0);
    }
    checkHeadShape(head);
    return head;
  }

  /**
   * Verify a head against the full record set the client holds for that
   * scope. `minSeq` is the highest seq this client verified before: a lower
   * seq is a rollback. A stateHash mismatch means a record was omitted,
   * added, or replayed at an older generation.
   */
  function verifyHead(
    head: unknown, scopeKey: Uint8Array,
    { vaultId, scope, records, minSeq = 0, expectedPrevHeadMac }: { vaultId: string; scope: string; records: Iterable<SyncRecord>; minSeq?: number; expectedPrevHeadMac?: string },
  ): void {
    checkHeadShape(head);
    if (head.vaultId !== vaultId || head.scope !== scope) throw new EnvelopeError('head_moved', 'Manifest head belongs to another vault or scope');
    const macKey = deriveMacKey(scopeKey);
    try {
      if (!macEquals(mac(macKey, headMacFields(head)), head.mac)) throw new EnvelopeError('head_mac', 'Manifest head failed its integrity check');
    } finally {
      macKey.fill(0);
    }
    if (head.seq < minSeq) throw new EnvelopeError('rollback', 'Sulla Cloud served an older copy than this browser has seen');
    if (expectedPrevHeadMac !== undefined && head.seq > minSeq && head.prevHeadMac !== expectedPrevHeadMac) {
      throw new EnvelopeError('head_chain', 'Manifest head does not extend the previously verified head');
    }
    if (stateHash(records) !== head.stateHash) throw new EnvelopeError('state_mismatch', 'Records do not match the signed manifest');
  }

  function encryptItem(plaintextJson: string, ownerKey: Uint8Array, ownerId: string, itemId: string): SyncItem {
    const itemKey = sodium.randombytes_buf(KEY_BYTES);
    try {
      return {
        version: 1,
        encryptedItemKey: seal(itemKey, ownerKey, itemAad('key', ownerId, itemId)),
        ciphertext: seal(enc.encode(plaintextJson), itemKey, itemAad('ciphertext', ownerId, itemId)),
      };
    } finally {
      itemKey.fill(0);
    }
  }

  function decryptItem(item: unknown, ownerKey: Uint8Array, ownerId: string, itemId: string): string {
    if (!isEncryptedItem(item)) throw new EnvelopeError('envelope_shape', 'Item envelope is malformed');
    assertKey(ownerKey);
    try {
      return runtime.codec.decryptItem(item, ownerKey, ownerId, itemId);
    } catch (error) {
      throwDomainError(error);
    }
  }

  function folderAad(ownerId: string, folderId: string): string {
    return `sulla:folder-name:v1:${JSON.stringify([ownerId, folderId])}`;
  }

  return {
    deriveMacKey, mac, macEquals, sha256, deriveMasterKey, unlockBundle, unlockRecovery,
    buildBundle, verifyBundle, buildRecord, verifyRecord, stateHash, buildHead, verifyHead,
    encryptItem, decryptItem,
    encryptFolderName: (name: string, ownerKey: Uint8Array, ownerId: string, folderId: string) => seal(enc.encode(name), ownerKey, folderAad(ownerId, folderId)),
    decryptFolderName: (env: unknown, ownerKey: Uint8Array, ownerId: string, folderId: string) => dec.decode(open(env, ownerKey, folderAad(ownerId, folderId))),
  };
}
