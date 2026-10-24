// Sulla Server · Passwords: the vault state machine that runs inside the
// crypto Web Worker (VAULT-E2E-DESIGN.md §6).
//
// It holds ciphertext from before unlock, derives the master key with
// Argon2id, unwraps the user key, verifies the bundle MAC, the signed head
// and every record MAC, and decrypts items, all locally. Nothing here makes
// a network request. The main thread only ever receives list fields; secret
// values leave one at a time on reveal/copy/edit. wipe() zeroes every key
// buffer and drops every decrypted object.

import { createSyncEnvelope, EnvelopeError, SUPPORTED_VERSION } from './sync-envelope.js';
import { chunkId, openChunk, openEscrowWithKey, openManifest, verifyHead, sha256Hex, stateHash, escrowKey, FLAG_DEFLATE_RAW } from './files-sync-envelope.js';

const ITEM_TYPES = new Set(['login', 'note', 'card', 'identity', 'apiKey']);
const SECRET_CUSTOM_TYPES = new Set(['password', 'one-time']);
const DEFAULT_POLICY = { mode: 'only_me', level: 'metadata', agents: [], sites: [], expiresAt: null, askFirst: false, allowServerAgents: false };
const SCOPE = 'personal';

export class VaultError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

function hostOf(uri) {
  try {
    return new URL(uri).hostname;
  } catch {
    return '';
  }
}

function validateItem(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) throw new VaultError('item_invalid', 'Vault item is invalid');
  if (!ITEM_TYPES.has(item.type)) throw new VaultError('item_invalid', 'Unknown item type');
  if (typeof item.name !== 'string' || !item.name.trim() || item.name.length > 500) throw new VaultError('item_invalid', 'Give the item a name');
  const policy = item.agentPolicy;
  if (!policy || !['only_me', 'agents'].includes(policy.mode) || !['metadata', 'autofill', 'full'].includes(policy.level)
    || !Array.isArray(policy.sites) || !Array.isArray(policy.agents)) {
    throw new VaultError('item_invalid', 'Agent access policy is invalid');
  }
  return item;
}

export function createVaultCore(sodium, { randomUUID = () => crypto.randomUUID() } = {}) {
  const env = createSyncEnvelope(sodium);
  let bundle = null;
  let head = null;
  let minSeq = 0;
  let records = new Map(); // id → verified (after unlock) or unverified (before) record
  let items = new Map(); // id → decrypted plaintext object (worker memory only)
  let userKey = null;
  let pending = new Map(); // token → { writes, head, plain: Map(id → item | null) }
  const keyBuffers = [];

  const requireUnlocked = () => {
    if (!userKey) throw new VaultError('locked', 'The vault is locked');
  };
  const requireItem = (id) => {
    const item = items.get(id);
    if (!item) throw new VaultError('not_found', 'That item is not in the vault');
    return item;
  };

  function listFields(id, item) {
    const record = records.get(id);
    return {
      id, name: item.name, type: item.type, username: item.username || '', host: hostOf(item.uris?.[0]?.uri || ''),
      favorite: !!item.favorite, folder: item.folder || '', agentMode: item.agentPolicy?.mode || 'only_me',
      agentLevel: item.agentPolicy?.level || 'metadata', generation: record?.generation || 0,
    };
  }

  function list() {
    requireUnlocked();
    return [...items].map(([id, item]) => listFields(id, item));
  }

  function decryptRecord(record) {
    const json = env.decryptItem(record.item, userKey, bundle.vaultUserId, record.id);
    try {
      return validateItem(JSON.parse(json));
    } catch {
      // A record that decrypts but doesn't parse is shown as unreadable, never guessed at.
      return null;
    }
  }

  /** Store ciphertext fetched before the password is typed. No keys, no network. */
  function load(input) {
    wipe();
    if (!input?.bundle || !Array.isArray(input.records) || !input.head) throw new VaultError('load_invalid', 'Vault data is incomplete');
    if (input.bundle.v > SUPPORTED_VERSION || input.head.v > SUPPORTED_VERSION || input.records.some((r) => r?.v > SUPPORTED_VERSION)) {
      throw new VaultError('unsupported_version', 'This vault was written by a newer Sulla. Update to open it here.');
    }
    bundle = input.bundle;
    head = input.head;
    minSeq = Number.isSafeInteger(input.minSeq) ? input.minSeq : 0;
    records = new Map(input.records.map((r) => [r.id, r]));
    return { count: records.size };
  }

  /**
   * Unlock with the master password: Argon2id → unwrap → bundle MAC → head
   * (seq ≥ highest seen, MAC, stateHash) → record MACs → decrypt. A wrong
   * password is decided here, locally.
   */
  function unlock(password) {
    if (!bundle) throw new VaultError('not_loaded', 'Vault data has not loaded yet');
    let key;
    try {
      key = env.unlockBundle(bundle, password);
    } catch (error) {
      if (error instanceof EnvelopeError) throw new VaultError(error.code, error.message);
      throw error;
    }
    try {
      const all = [...records.values()];
      env.verifyHead(head, key, { vaultId: bundle.vaultId, scope: SCOPE, records: all, minSeq });
      for (const record of all) env.verifyRecord(record, key, { vaultId: bundle.vaultId, scope: SCOPE });
    } catch (error) {
      key.fill(0);
      if (error instanceof EnvelopeError) throw new VaultError(error.code, error.message);
      throw error;
    }
    userKey = key;
    keyBuffers.push(key);
    let unreadable = 0;
    for (const record of records.values()) {
      if (record.deleted || record.kind !== 'item') continue;
      const item = decryptRecord(record);
      if (item) items.set(record.id, item);
      else unreadable++;
    }
    return { list: list(), seq: head.seq, unreadable };
  }

  // File-sync roots and verified manifests never leave this worker.
  const fileRoots = new Map(); // collectionId -> { root, keyVersion }
  const fileManifests = new Map(); // collectionId -> Map(fileId -> manifest)
  const requireFileRoot = (collectionId) => {
    requireUnlocked();
    const entry = fileRoots.get(collectionId);
    if (!entry) throw new VaultError('files_not_loaded', 'Encrypted backup collection is not loaded');
    return entry;
  };
  const integrityError = (code, message) => new VaultError(code, message || 'Encrypted backup integrity check failed');

  async function filesOpenEscrow(collectionId, env) {
    requireUnlocked();
    if (typeof collectionId !== 'string' || env?.collectionId !== collectionId) throw integrityError('files_escrow', 'Encrypted backup collection is invalid');
    const ek = await escrowKey(userKey, env.vaultId, env.vaultEpoch);
    let root;
    try { root = await openEscrowWithKey(ek, env); }
    catch { throw integrityError('files_escrow', 'Encrypted backup escrow failed integrity verification'); }
    finally { ek.fill(0); }
    const prior = fileRoots.get(collectionId);
    if (prior?.root) prior.root.fill(0);
    fileRoots.set(collectionId, { root, keyVersion: env.keyVersion });
    fileManifests.delete(collectionId);
    return { collectionId, keyVersion: env.keyVersion };
  }

  async function filesVerifyHead(collectionId, h, priorSeq = 0) {
    const { root } = requireFileRoot(collectionId);
    if (h.collectionId !== collectionId || h.keyVersion !== fileRoots.get(collectionId)?.keyVersion || !(await verifyHead(root, h))) throw integrityError('files_head_mac');
    if (!Number.isSafeInteger(priorSeq) || priorSeq < 0 || h.seq < priorSeq) throw integrityError('files_rollback', 'Encrypted backup rolled back');
    return { verified: true, seq: h.seq };
  }

  async function filesLoadCollection(collectionId, escrowEnvelope, versionsPages, h, priorSeq = 0) {
    await filesOpenEscrow(collectionId, escrowEnvelope);
    const { root, keyVersion } = requireFileRoot(collectionId);
    if (!Array.isArray(versionsPages) || !h) throw integrityError('files_load', 'Encrypted backup collection is incomplete');
    const verified = await filesVerifyHead(collectionId, h, priorSeq);
    const latest = new Map();
    for (const page of versionsPages) {
      for (const version of (page?.versions || [])) {
        if (!version?.fileId || !Number.isSafeInteger(version.seq)) throw integrityError('files_version');
        const prior = latest.get(version.fileId);
        if (!prior || version.seq > prior.seq) latest.set(version.fileId, version);
      }
    }
    const manifests = new Map();
    for (const version of latest.values()) {
      const envelope = version.manifest;
      if (envelope?.collectionId !== collectionId || envelope?.keyVersion !== keyVersion || envelope?.fileId !== version.fileId || envelope?.versionId !== version.versionId) throw integrityError('files_manifest');
      const manifest = await openManifest(root, envelope);
      if (!Array.isArray(manifest.chunks)) throw integrityError('files_manifest');
      const ids = manifest.chunks.map((chunk) => chunk?.[0]);
      if (!Array.isArray(version.chunkIds) || version.chunkIds.length !== ids.length || version.chunkIds.some((id, i) => id !== ids[i])) throw integrityError('files_manifest', 'Encrypted backup manifest chunk list changed');
      manifests.set(version.fileId, { ...manifest, keyVersion, seq: version.seq });
    }
    const entries = [...latest.values()].map((version) => ({ fileId: version.fileId, versionId: version.versionId, deleted: !!version.deleted }));
    if (await stateHash(entries) !== h.stateHash) throw integrityError('files_state_hash', 'Encrypted backup state changed');
    fileManifests.set(collectionId, manifests);
    return { collectionId, keyVersion, seq: verified.seq, files: [...manifests].filter(([, m]) => !m.deleted).map(([fileId, m]) => ({ fileId, path: m.path, name: String(m.path || '').split('/').pop(), mime: m.mime, size: m.size, mtime: m.mtime })) };
  }

  async function filesChunkIds(collectionId, fileId) {
    const manifest = fileManifests.get(collectionId)?.get(fileId);
    if (!manifest || manifest.deleted) throw new VaultError('not_found', 'Encrypted backup file is not available');
    return manifest.chunks.map((chunk) => chunk[0]);
  }

  async function filesDownload(collectionId, fileId, wires) {
    const { root } = requireFileRoot(collectionId);
    const manifest = fileManifests.get(collectionId)?.get(fileId);
    if (!manifest || manifest.deleted || !Array.isArray(wires) || wires.length !== manifest.chunks.length) throw integrityError('files_download');
    const parts = []; let total = 0;
    for (let i = 0; i < wires.length; i++) {
      const expected = manifest.chunks[i];
      const item = wires[i]?.wire === undefined ? { id: expected[0], wire: wires[i] } : wires[i];
      if (item.id !== expected[0]) throw integrityError('files_chunk');
      let opened;
      try { opened = await openChunk(root, collectionId, manifest.keyVersion, item.id, item.wire instanceof Uint8Array ? item.wire : new Uint8Array(item.wire)); }
      catch { throw integrityError('files_chunk'); }
      let plain = opened.body;
      if (opened.flags & FLAG_DEFLATE_RAW) {
        try { plain = new Uint8Array(await new Response(new Blob([plain]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer()); }
        catch { throw integrityError('files_chunk'); }
      }
      if (plain.byteLength > 4 * 1024 * 1024 || plain.byteLength !== expected[1] || await chunkId(root, collectionId, manifest.keyVersion, plain) !== item.id) throw integrityError('files_chunk');
      total += plain.byteLength; parts.push(plain);
    }
    if (total !== manifest.size) throw integrityError('files_size');
    const out = new Uint8Array(total); let offset = 0;
    for (const part of parts) { out.set(part, offset); offset += part.byteLength; }
    if (await sha256Hex(out) !== manifest.sha256) throw integrityError('files_sha256');
    return out;
  }

  function detail(id) {
    requireUnlocked();
    const item = requireItem(id);
    return {
      ...listFields(id, item),
      uris: (item.uris || []).map((u) => u.uri).filter((u) => typeof u === 'string'),
      notes: item.notes || '',
      hasPassword: !!item.password,
      hasTotp: !!item.totp,
      agentPolicy: { ...DEFAULT_POLICY, ...item.agentPolicy },
      card: item.card ? { holder: item.card.holder || '', brand: item.card.brand || '', expMonth: item.card.expMonth || '', expYear: item.card.expYear || '', hasNumber: !!item.card.number, hasCode: !!item.card.code } : null,
      identity: item.identity ? { ...item.identity } : null,
      customFields: (item.customFields || []).map((f, index) => {
        const secret = SECRET_CUSTOM_TYPES.has(f.type);
        return { index, label: f.label || '', type: f.type || 'text', secret, value: secret ? null : String(f.value ?? ''), hasValue: f.value !== undefined && f.value !== '' };
      }),
      legacyFields: (item.fields || []).map((f, index) => ({ index, name: f.name || '', hidden: !!f.hidden, value: f.hidden ? null : String(f.value ?? '') })),
    };
  }

  /** One secret value, on explicit reveal or copy. */
  function reveal(id, path) {
    requireUnlocked();
    const item = requireItem(id);
    if (path === 'password') return item.password || '';
    if (path === 'totp') return item.totp || '';
    if (path === 'card.number') return item.card?.number || '';
    if (path === 'card.code') return item.card?.code || '';
    if (path === 'username') return item.username || '';
    let m = /^custom:(\d+)$/.exec(path);
    if (m) return String(item.customFields?.[Number(m[1])]?.value ?? '');
    m = /^field:(\d+)$/.exec(path);
    if (m) return String(item.fields?.[Number(m[1])]?.value ?? '');
    throw new VaultError('bad_field', 'Unknown field');
  }

  /** Full plaintext for the editor (the owner asked to edit this item). */
  function editable(id) {
    requireUnlocked();
    return structuredClone(requireItem(id));
  }

  function stage(writes, plain) {
    const merged = new Map(records);
    for (const w of writes) merged.set(w.id, w.record);
    const nextHead = env.buildHead({ vaultId: bundle.vaultId, scope: SCOPE, seq: head.seq + 1, records: merged.values(), prevHeadMac: head.mac }, userKey);
    const token = randomUUID();
    pending.set(token, { writes, head: nextHead, plain });
    return { token, body: { scope: SCOPE, expectedHeadSeq: head.seq, writes, head: nextHead } };
  }

  /** Encrypt one item under a fresh item key and stage a commit. */
  function prepareSave({ id = null, item }) {
    requireUnlocked();
    const clean = validateItem(structuredClone(item));
    const itemId = id || randomUUID();
    const prior = records.get(itemId);
    if (id && !prior) throw new VaultError('not_found', 'That item is not in the vault');
    const base = prior ? prior.generation : 0;
    const sealed = env.encryptItem(JSON.stringify(clean), userKey, bundle.vaultUserId, itemId);
    const record = env.buildRecord({ vaultId: bundle.vaultId, scope: SCOPE, kind: 'item', id: itemId, generation: base + 1, deleted: false, item: sealed }, userKey);
    return { ...stage([{ id: itemId, baseGeneration: base, record }], new Map([[itemId, clean]])), id: itemId };
  }

  function prepareDelete(id) {
    requireUnlocked();
    const prior = records.get(id);
    if (!prior || prior.deleted) throw new VaultError('not_found', 'That item is not in the vault');
    const record = env.buildRecord({ vaultId: bundle.vaultId, scope: SCOPE, kind: 'item', id, generation: prior.generation + 1, deleted: true }, userKey);
    return stage([{ id, baseGeneration: prior.generation, record }], new Map([[id, null]]));
  }

  /** Cloud accepted a staged commit: make it the verified state. */
  function commitAccepted(token) {
    requireUnlocked();
    const p = pending.get(token);
    if (!p) throw new VaultError('unknown_commit', 'That change is no longer pending');
    pending.delete(token);
    for (const w of p.writes) records.set(w.id, w.record);
    for (const [id, item] of p.plain) {
      if (item) items.set(id, item);
      else items.delete(id);
    }
    head = p.head;
    return { list: list(), seq: head.seq };
  }

  function pendingItem(token, id) {
    const p = pending.get(token);
    return p?.plain.get(id) ? structuredClone(p.plain.get(id)) : null;
  }

  function discard(token) {
    pending.delete(token);
  }

  /**
   * Apply changes other writers committed (head_stale / record_conflict /
   * periodic refresh). Verifies every record and the new head over the merged
   * state before anything replaces what the user sees.
   */
  function merge({ records: delta, head: nextHead }) {
    requireUnlocked();
    const merged = new Map(records);
    for (const record of delta) {
      env.verifyRecord(record, userKey, { vaultId: bundle.vaultId, scope: SCOPE });
      const prior = records.get(record.id);
      if (prior && record.generation < prior.generation) throw new VaultError('rollback', 'Sulla Server served an older version of an item');
      merged.set(record.id, record);
    }
    try {
      env.verifyHead(nextHead, userKey, { vaultId: bundle.vaultId, scope: SCOPE, records: merged.values(), minSeq: head.seq, expectedPrevHeadMac: head.mac });
    } catch (error) {
      if (error instanceof EnvelopeError) throw new VaultError(error.code, error.message);
      throw error;
    }
    const changed = [];
    for (const record of delta) {
      if (records.get(record.id)?.generation === record.generation) continue;
      changed.push(record.id);
      if (record.deleted || record.kind !== 'item') {
        items.delete(record.id);
        continue;
      }
      const item = decryptRecord(record);
      if (item) items.set(record.id, item);
      else items.delete(record.id);
    }
    records = merged;
    head = nextHead;
    return { list: list(), seq: head.seq, changed };
  }

  /** Zero every key buffer and drop every decrypted object. */
  function wipe() {
    for (const key of keyBuffers) key.fill(0);
    for (const { root } of fileRoots.values()) root.fill(0);
    fileRoots.clear();
    fileManifests.clear();
    keyBuffers.length = 0;
    userKey = null;
    items = new Map();
    pending = new Map();
    records = new Map();
    bundle = null;
    head = null;
    return { wiped: true };
  }

  return {
    load, unlock, list, detail, reveal, editable, prepareSave, prepareDelete, commitAccepted, pendingItem, discard, merge, filesOpenEscrow, filesVerifyHead, filesLoadCollection, filesChunkIds, filesDownload, wipe,
    // State inspection for the wipe test; returns references, never copies of secrets.
    _state: () => ({ keyBuffers: [...keyBuffers], itemCount: items.size, fileRootCount: fileRoots.size, unlocked: !!userKey, seq: head?.seq ?? null }),
  };
}

export const WORKER_OPS = ['load', 'unlock', 'list', 'detail', 'reveal', 'editable', 'prepareSave', 'prepareDelete', 'commitAccepted', 'pendingItem', 'discard', 'merge', 'filesOpenEscrow', 'filesVerifyHead', 'filesLoadCollection', 'filesChunkIds', 'filesDownload', 'wipe'];
