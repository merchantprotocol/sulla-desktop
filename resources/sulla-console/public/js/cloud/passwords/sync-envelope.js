// Sulla vault sync v3: envelope build/verify (VAULT-E2E-DESIGN.md §2–§3).
//
// Dependency-free ES module. The caller passes in an initialised
// libsodium-wrappers-sumo instance, so the same file runs in the Passwords
// crypto worker and in Node tests. The Desktop vault container has a
// TypeScript port at sulla-desktop services/sulla-vault/src/browserEnvelope/
// envelope.ts; both are pinned to the same known-answer fixture
// (tests/fixtures/vault-sync-v3-kat.json), so a change here needs the same
// change there.
//
// Formats (all binary values base64url, no padding; canonical bytes = RFC 8785 JCS):
//   bundle  sulla-vault-sync-bundle v1   wrapped user key + KDF params, MAC'd
//   record  sulla-vault-sync-record v1   one item/folder (or tombstone), MAC binds generation
//   head    sulla-vault-sync-head   v1   per-scope seq + hash of every record, MAC'd
//
// Every MAC uses a subkey derived from the scope key with crypto_kdf
// (context "SVsync01"), never the scope key itself. Every MAC input carries
// its format tag, so a record MAC can never verify as a head MAC.

export const FORMAT = Object.freeze({
  bundle: 'sulla-vault-sync-bundle',
  record: 'sulla-vault-sync-record',
  head: 'sulla-vault-sync-head',
});

export const SUPPORTED_VERSION = 1;

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
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

// ── RFC 8785 canonical JSON ─────────────────────────────────────────────
// Our objects only hold strings, safe integers, booleans, null, arrays and
// plain objects, so the number rule reduces to "integers only".
export function jcs(value) {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new EnvelopeError('non_integer', 'Canonical JSON only carries safe integers');
    return String(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(jcs).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort(compareUtf16);
    return `{${keys.map((k) => `${JSON.stringify(k)}:${jcs(value[k])}`).join(',')}}`;
  }
  throw new EnvelopeError('bad_type', `Canonical JSON cannot carry ${typeof value}`);
}

function compareUtf16(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ── Shape checks (strict allowlists: unknown fields are rejected) ───────
function exactKeys(obj, required, optional = []) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const allowed = new Set([...required, ...optional]);
  for (const k of Object.keys(obj)) if (!allowed.has(k)) return false;
  return required.every((k) => Object.prototype.hasOwnProperty.call(obj, k));
}

function isB64(value, min = 1, max = 1 << 20) {
  return typeof value === 'string' && value.length >= min && value.length <= max && B64.test(value);
}

export function isAeadEnvelope(env) {
  return exactKeys(env, ['version', 'algorithm', 'nonce', 'ciphertext'])
    && env.version === 1 && env.algorithm === 'xchacha20-poly1305'
    && isB64(env.nonce, 32, 32) && isB64(env.ciphertext, 22);
}

function isEncryptedItem(item) {
  return exactKeys(item, ['version', 'encryptedItemKey', 'ciphertext'])
    && item.version === 1 && isAeadEnvelope(item.encryptedItemKey) && isAeadEnvelope(item.ciphertext);
}

function isId(value) {
  return typeof value === 'string' && UUID.test(value);
}

function isScope(value) {
  return value === 'personal' || isId(value);
}

function isCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

export function checkKdf(kdf) {
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

export function checkBundleShape(bundle) {
  if (!exactKeys(bundle, BUNDLE_FIELDS)) throw new EnvelopeError('bundle_shape', 'Vault bundle has unexpected fields');
  if (bundle.format !== FORMAT.bundle) throw new EnvelopeError('bundle_shape', 'Not a vault sync bundle');
  if (bundle.v !== SUPPORTED_VERSION) throw new EnvelopeError('unsupported_version', 'Vault bundle version is newer than this app');
  if (!isId(bundle.vaultId) || !isId(bundle.vaultUserId)) throw new EnvelopeError('bundle_shape', 'Vault ids are malformed');
  if (!Number.isSafeInteger(bundle.epoch) || bundle.epoch < 1 || !Number.isSafeInteger(bundle.bundleGeneration) || bundle.bundleGeneration < 1) {
    throw new EnvelopeError('bundle_shape', 'Vault bundle counters are malformed');
  }
  checkKdf(bundle.kdf);
  if (!isAeadEnvelope(bundle.encryptedUserKey) || !isAeadEnvelope(bundle.encryptedPrivateKey) || !isB64(bundle.publicKey, 43, 43) || !isB64(bundle.mac, 43, 43)) {
    throw new EnvelopeError('bundle_shape', 'Vault bundle key material is malformed');
  }
}

const RECORD_FIELDS = ['format', 'v', 'vaultId', 'scope', 'kind', 'id', 'generation', 'deleted', 'mac'];

export function checkRecordShape(record) {
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

export function checkHeadShape(head) {
  if (!exactKeys(head, HEAD_FIELDS)) throw new EnvelopeError('head_shape', 'Manifest head has unexpected fields');
  if (head.format !== FORMAT.head) throw new EnvelopeError('head_shape', 'Not a manifest head');
  if (head.v !== SUPPORTED_VERSION) throw new EnvelopeError('unsupported_version', 'Manifest head version is newer than this app');
  if (!isId(head.vaultId) || !isScope(head.scope) || !Number.isSafeInteger(head.seq) || head.seq < 1) throw new EnvelopeError('head_shape', 'Manifest head is malformed');
  if (!isB64(head.stateHash, 43, 43) || !isB64(head.mac, 43, 43)) throw new EnvelopeError('head_shape', 'Manifest head hashes are malformed');
  if (head.prevHeadMac !== '' && !isB64(head.prevHeadMac, 43, 43)) throw new EnvelopeError('head_shape', 'Manifest head chain is malformed');
}

// ── Crypto (sodium injected) ────────────────────────────────────────────
export function createSyncEnvelope(sodium) {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const b64 = (bytes) => sodium.to_base64(bytes, sodium.base64_variants.URLSAFE_NO_PADDING);
  const unb64 = (value) => sodium.from_base64(value, sodium.base64_variants.URLSAFE_NO_PADDING);

  function assertKey(key) {
    if (!(key instanceof Uint8Array) || key.byteLength !== KEY_BYTES) throw new EnvelopeError('bad_key', 'Key must be 32 bytes');
  }

  /** MAC subkey for one scope (personal: the user key; collection: its collection key). */
  function deriveMacKey(scopeKey) {
    assertKey(scopeKey);
    return sodium.crypto_kdf_derive_from_key(KEY_BYTES, MAC_SUBKEY_ID, KDF_CONTEXT, scopeKey);
  }

  function mac(macKey, fields) {
    assertKey(macKey);
    return b64(sodium.crypto_generichash(KEY_BYTES, enc.encode(jcs(fields)), macKey));
  }

  function macEquals(expected, actual) {
    if (typeof expected !== 'string' || typeof actual !== 'string' || expected.length !== actual.length) return false;
    try {
      return sodium.memcmp(unb64(expected), unb64(actual));
    } catch {
      return false;
    }
  }

  function sha256(value) {
    return b64(sodium.crypto_hash_sha256(enc.encode(jcs(value))));
  }

  // vault-crypto compatible primitives (packages/vault-crypto/src/index.ts).
  function itemAad(purpose, ownerId, itemId) {
    return `sulla:item:${purpose}:v1:${JSON.stringify([ownerId, itemId])}`;
  }

  function seal(plaintext, key, aad) {
    assertKey(key);
    const nonce = sodium.randombytes_buf(24);
    const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(plaintext, enc.encode(aad), null, nonce, key);
    return { version: 1, algorithm: 'xchacha20-poly1305', nonce: b64(nonce), ciphertext: b64(ciphertext) };
  }

  function open(envelope, key, aad) {
    assertKey(key);
    if (!isAeadEnvelope(envelope)) throw new EnvelopeError('envelope_shape', 'Encrypted envelope is malformed');
    try {
      return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, unb64(envelope.ciphertext), enc.encode(aad), unb64(envelope.nonce), key);
    } catch {
      throw new EnvelopeError('decrypt_failed', 'Decryption failed');
    }
  }

  /** Argon2id over the bundle's own parameters, after the bounds check. */
  function deriveMasterKey(password, kdf) {
    checkKdf(kdf);
    if (typeof password !== 'string' || !password) throw new EnvelopeError('password_required', 'Master password is required');
    return sodium.crypto_pwhash(KEY_BYTES, password, unb64(kdf.salt), kdf.ops, kdf.memoryBytes, sodium.crypto_pwhash_ALG_ARGON2ID13);
  }

  function bundleMacFields(bundle) {
    const { mac: _ignored, ...fields } = bundle;
    return fields;
  }

  function buildBundle(fields, userKey) {
    const macKey = deriveMacKey(userKey);
    try {
      const body = { format: FORMAT.bundle, v: SUPPORTED_VERSION, ...fields };
      const bundle = { ...body, mac: mac(macKey, body) };
      checkBundleShape(bundle);
      return bundle;
    } finally {
      macKey.fill(0);
    }
  }

  function verifyBundle(bundle, userKey) {
    checkBundleShape(bundle);
    const macKey = deriveMacKey(userKey);
    try {
      if (!macEquals(mac(macKey, bundleMacFields(bundle)), bundle.mac)) throw new EnvelopeError('bundle_mac', 'Vault bundle failed its integrity check');
    } finally {
      macKey.fill(0);
    }
  }

  /**
   * Unlock a bundle with the master password. Throws `wrong_password` when the
   * AEAD rejects the wrap (decided locally, nothing is sent anywhere).
   * Returns the user key; the caller owns it and must zero it.
   */
  function unlockBundle(bundle, password) {
    checkBundleShape(bundle);
    const masterKey = deriveMasterKey(password, bundle.kdf);
    let userKey;
    try {
      userKey = open(bundle.encryptedUserKey, masterKey, 'sulla:user-key:v1');
    } catch {
      throw new EnvelopeError('wrong_password', 'Wrong master password');
    } finally {
      masterKey.fill(0);
    }
    try {
      verifyBundle(bundle, userKey);
    } catch (error) {
      userKey.fill(0);
      throw error;
    }
    return userKey;
  }

  /**
   * First unlock on a Sulla Server (or after a password change): open the
   * account's wrapped user key with the master password, before any bundle
   * exists. Throws `wrong_password` locally. The caller zeroes the key.
   */
  function unwrapUserKey(fields, password) {
    const masterKey = deriveMasterKey(password, fields?.kdf);
    try {
      return open(fields.encryptedUserKey, masterKey, 'sulla:user-key:v1');
    } catch {
      throw new EnvelopeError('wrong_password', 'Wrong master password');
    } finally {
      masterKey.fill(0);
    }
  }

  /**
   * Sulla Server shared collections. The member's org key is sealed to their
   * key pair; it opens each collection key and name. Returns a Map of
   * collectionId → { key, name }; a collection whose key doesn't open is left
   * out. The caller owns the keys and must zero them.
   */
  function openCollectionKeys({ bundle, wrappedOrgKey, collections }, userKey) {
    if (wrappedOrgKey?.version !== 1 || wrappedOrgKey?.algorithm !== 'x25519-sealed-box' || typeof wrappedOrgKey?.ciphertext !== 'string') {
      throw new EnvelopeError('envelope_shape', 'Organization key envelope is malformed');
    }
    const privateKey = open(bundle.encryptedPrivateKey, userKey, 'sulla:user-private-key:v1');
    let orgKey;
    try {
      orgKey = sodium.crypto_box_seal_open(unb64(wrappedOrgKey.ciphertext), unb64(bundle.publicKey), privateKey);
    } catch {
      throw new EnvelopeError('decrypt_failed', 'The organization key could not be opened');
    } finally {
      privateKey.fill(0);
    }
    const out = new Map();
    try {
      for (const c of collections) {
        let key;
        try {
          key = open(c.wrappedCollectionKey, orgKey, 'sulla:collection-key:v1');
        } catch {
          continue;
        }
        let name = 'Shared collection';
        try {
          name = dec.decode(open(c.encryptedName, orgKey, 'sulla:collection-name:v1'));
        } catch {
          // keep the generic name
        }
        out.set(c.collectionId, { key, name });
      }
    } finally {
      orgKey.fill(0);
    }
    return out;
  }

  function contentHash(record) {
    if (record.deleted) return '';
    return sha256(record.kind === 'item' ? record.item : record.encryptedName);
  }

  function recordMacFields(record) {
    return {
      format: FORMAT.record, v: SUPPORTED_VERSION, vaultId: record.vaultId, scope: record.scope, kind: record.kind,
      id: record.id, generation: record.generation, deleted: record.deleted, contentHash: contentHash(record),
    };
  }

  function buildRecord(fields, scopeKey) {
    const record = {
      format: FORMAT.record, v: SUPPORTED_VERSION,
      vaultId: fields.vaultId, scope: fields.scope, kind: fields.kind, id: fields.id,
      generation: fields.generation, deleted: Boolean(fields.deleted),
    };
    if (!record.deleted && record.kind === 'item') record.item = { version: 1, encryptedItemKey: fields.item.encryptedItemKey, ciphertext: fields.item.ciphertext };
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
  function verifyRecord(record, scopeKey, expect) {
    checkRecordShape(record);
    if (record.vaultId !== expect.vaultId || record.scope !== expect.scope) throw new EnvelopeError('record_moved', 'Record belongs to another vault or scope');
    if (expect.id !== undefined && record.id !== expect.id) throw new EnvelopeError('record_moved', 'Record id does not match');
    const macKey = deriveMacKey(scopeKey);
    try {
      if (!macEquals(mac(macKey, recordMacFields(record)), record.mac)) throw new EnvelopeError('record_mac', 'Record failed its integrity check');
    } finally {
      macKey.fill(0);
    }
  }

  function stateHash(records) {
    const rows = [...records]
      .map((r) => [r.id, r.generation, r.deleted, r.mac])
      .sort((a, b) => compareUtf16(a[0], b[0]));
    for (let i = 1; i < rows.length; i++) if (rows[i][0] === rows[i - 1][0]) throw new EnvelopeError('duplicate_record', 'Two records share one id');
    return sha256(rows);
  }

  function headMacFields(head) {
    return { format: FORMAT.head, v: SUPPORTED_VERSION, vaultId: head.vaultId, scope: head.scope, seq: head.seq, stateHash: head.stateHash, prevHeadMac: head.prevHeadMac };
  }

  function buildHead({ vaultId, scope, seq, records, prevHeadMac = '' }, scopeKey) {
    const head = { format: FORMAT.head, v: SUPPORTED_VERSION, vaultId, scope, seq, stateHash: stateHash(records), prevHeadMac };
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
  function verifyHead(head, scopeKey, { vaultId, scope, records, minSeq = 0, expectedPrevHeadMac }) {
    checkHeadShape(head);
    if (head.vaultId !== vaultId || head.scope !== scope) throw new EnvelopeError('head_moved', 'Manifest head belongs to another vault or scope');
    const macKey = deriveMacKey(scopeKey);
    try {
      if (!macEquals(mac(macKey, headMacFields(head)), head.mac)) throw new EnvelopeError('head_mac', 'Manifest head failed its integrity check');
    } finally {
      macKey.fill(0);
    }
    if (head.seq < minSeq) throw new EnvelopeError('rollback', 'Sulla Server served an older copy than this browser has seen');
    if (expectedPrevHeadMac !== undefined && head.seq > minSeq && head.prevHeadMac !== expectedPrevHeadMac) {
      throw new EnvelopeError('head_chain', 'Manifest head does not extend the previously verified head');
    }
    if (stateHash(records) !== head.stateHash) throw new EnvelopeError('state_mismatch', 'Records do not match the signed manifest');
  }

  function encryptItem(plaintextJson, ownerKey, ownerId, itemId) {
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

  function decryptItem(item, ownerKey, ownerId, itemId) {
    if (!isEncryptedItem(item)) throw new EnvelopeError('envelope_shape', 'Item envelope is malformed');
    const itemKey = open(item.encryptedItemKey, ownerKey, itemAad('key', ownerId, itemId));
    try {
      return dec.decode(open(item.ciphertext, itemKey, itemAad('ciphertext', ownerId, itemId)));
    } finally {
      itemKey.fill(0);
    }
  }

  function folderAad(ownerId, folderId) {
    return `sulla:folder-name:v1:${JSON.stringify([ownerId, folderId])}`;
  }

  return {
    deriveMacKey, mac, macEquals, sha256, deriveMasterKey, unlockBundle, unwrapUserKey, openCollectionKeys,
    buildBundle, verifyBundle, buildRecord, verifyRecord, stateHash, buildHead, verifyHead,
    encryptItem, decryptItem,
    encryptFolderName: (name, ownerKey, ownerId, folderId) => seal(enc.encode(name), ownerKey, folderAad(ownerId, folderId)),
    decryptFolderName: (env, ownerKey, ownerId, folderId) => dec.decode(open(env, ownerKey, folderAad(ownerId, folderId))),
  };
}
