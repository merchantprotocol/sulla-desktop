// Copyright © 2026 Merchant Protocol, LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

// Strict request checks for the vault-origin API. The server holds no key, so
// it can't check a MAC; it checks shape instead. The field allowlists come from
// browserEnvelope/envelope.ts (the TypeScript twin of the browser's
// sync-envelope.js), so a body the browser couldn't verify is never stored.
// On top of that: the record must belong to this vault and scope, counters must
// line up, sizes are capped, and any key that only ever appears in decrypted
// items is refused at any depth, so a buggy client can't park a password here.

import {
  checkBundleShape,
  checkHeadShape,
  checkRecordShape,
  EnvelopeError,
  type SyncBundle,
  type SyncHead,
  type SyncRecord,
} from '../browserEnvelope/envelope.js';

export const LIMITS = Object.freeze({
  recordBytes:     64 * 1024,
  recordsPerScope: 20_000,
  writesPerCommit: 256,
  createRecords:   2_000,
  bundleBytes:     16 * 1024,
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Keys that only ever appear in decrypted vault items or local-only columns. */
const PLAINTEXT_KEYS = new Set([
  'name', 'password', 'username', 'uri', 'uris', 'url', 'notes', 'totp', 'value', 'fields', 'customFields',
  'card', 'number', 'code', 'identity', 'passwordHistory', 'folder', 'favorite', 'type', 'proxy', 'integration',
  'agentPolicy', 'agent_policy', 'item_type', 'itemType', 'integration_ref', 'integrationRef',
  'agentWrappedItemKey', 'agent_wrapped_item_key', 'login_hash_verifier', 'loginHashVerifier', 'login_hash_salt',
  'loginHash', 'recoveryCode', 'recovery', 'masterKey', 'userKey', 'privateKey', 'secret', 'plaintext',
]);

export class InvalidBody extends Error {
  constructor(public readonly reason: string, public readonly status = 422) {
    super(reason);
  }
}

export const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);

export const isScope = (value: unknown): value is string => value === 'personal' || isUuid(value);

const isNonNegativeInteger = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(value, key));
}

export function findPlaintextKey(value: unknown): string | null {
  // JSON input is acyclic, so scan the whole tree; a depth cap would hide plaintext below it.
  const pending: unknown[] = [value];
  while (pending.length) {
    const current = pending.pop();
    if (current === null || typeof current !== 'object') continue;
    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }
    for (const [key, entry] of Object.entries(current)) {
      if (PLAINTEXT_KEYS.has(key)) return key;
      pending.push(entry);
    }
  }
  return null;
}

function refusePlaintext(value: unknown): void {
  const key = findPlaintextKey(value);
  if (key) throw new InvalidBody(`plaintext_key:${ key }`);
}

function shape<T>(check: (value: unknown) => void, value: unknown, reason: string): T {
  try {
    check(value);
  } catch (error) {
    if (error instanceof EnvelopeError) throw new InvalidBody(`${ reason }:${ error.code }`);
    throw error;
  }
  return value as T;
}

export function validateBundle(value: unknown, vaultId: string, vaultUserId: string): SyncBundle {
  refusePlaintext(value);
  const bundle = shape<SyncBundle>(checkBundleShape, value, 'bundle');
  if (bundle.vaultId !== vaultId || bundle.vaultUserId !== vaultUserId) throw new InvalidBody('bundle_ids');
  if (JSON.stringify(bundle).length > LIMITS.bundleBytes) throw new InvalidBody('bundle_size', 413);
  return bundle;
}

export function validateRecord(value: unknown, vaultId: string, scope: string): SyncRecord {
  refusePlaintext(value);
  const record = shape<SyncRecord>(checkRecordShape, value, 'record');
  if (record.vaultId !== vaultId || record.scope !== scope) throw new InvalidBody('record_ids');
  if (JSON.stringify(record).length > LIMITS.recordBytes) throw new InvalidBody('record_size', 413);
  return record;
}

export function validateHead(value: unknown, vaultId: string, scope: string): SyncHead {
  const head = shape<SyncHead>(checkHeadShape, value, 'head');
  if (head.vaultId !== vaultId || head.scope !== scope) throw new InvalidBody('head_ids');
  return head;
}

export interface CreateBody { bundle: SyncBundle; records: SyncRecord[]; head: SyncHead }

/**
 * PUT op=create: the member's bundle plus the personal scope's first state.
 * The head must start a chain (prevHeadMac ''); its seq is the client's choice.
 */
export function validateCreateBody(body: unknown, vaultId: string, vaultUserId: string): CreateBody {
  if (!exactKeys(body, ['bundle', 'scope', 'records', 'head']) || body.scope !== 'personal') {
    throw new InvalidBody('create_fields');
  }
  const bundle = validateBundle(body.bundle, vaultId, vaultUserId);
  if (!Array.isArray(body.records) || body.records.length > LIMITS.createRecords) {
    throw new InvalidBody('create_records', 413);
  }
  const ids = new Set<string>();
  const records: SyncRecord[] = [];
  for (const value of body.records) {
    const record = validateRecord(value, vaultId, 'personal');
    if (ids.has(record.id)) throw new InvalidBody('duplicate_record');
    ids.add(record.id);
    records.push(record);
  }
  const head = validateHead(body.head, vaultId, 'personal');
  if (head.prevHeadMac !== '') throw new InvalidBody('create_head_chain');
  return { bundle, records, head };
}

export interface RewrapBody { bundle: SyncBundle; expectedBundleGeneration: number }

/** PUT op=rewrap: a new bundle after a password or KDF change, CAS on bundleGeneration. */
export function validateRewrapBody(body: unknown, vaultId: string, vaultUserId: string): RewrapBody {
  if (!exactKeys(body, ['bundle', 'expectedBundleGeneration']) || !isNonNegativeInteger(body.expectedBundleGeneration)) {
    throw new InvalidBody('rewrap_fields');
  }
  const bundle = validateBundle(body.bundle, vaultId, vaultUserId);
  if (bundle.bundleGeneration !== body.expectedBundleGeneration + 1) throw new InvalidBody('rewrap_generation');
  return { bundle, expectedBundleGeneration: body.expectedBundleGeneration };
}

export interface CommitWrite { id: string; baseGeneration: number; record: SyncRecord }
export interface CommitBody { scope: string; expectedHeadSeq: number; writes: CommitWrite[]; head: SyncHead }

/** POST commit: CAS writes for one scope plus the client's recomputed, MAC'd head. */
export function validateCommitBody(body: unknown, vaultId: string): CommitBody {
  if (!exactKeys(body, ['scope', 'expectedHeadSeq', 'writes', 'head'])) throw new InvalidBody('commit_fields');
  if (!isScope(body.scope)) throw new InvalidBody('commit_scope');
  if (!isNonNegativeInteger(body.expectedHeadSeq)) throw new InvalidBody('commit_seq');
  if (!Array.isArray(body.writes) || body.writes.length < 1 || body.writes.length > LIMITS.writesPerCommit) {
    throw new InvalidBody('commit_writes', 413);
  }
  const scope = body.scope;
  const ids = new Set<string>();
  const writes: CommitWrite[] = [];
  for (const write of body.writes) {
    if (!exactKeys(write, ['id', 'baseGeneration', 'record'])) {
      refusePlaintext(write);
      throw new InvalidBody('commit_write');
    }
    const { id, baseGeneration } = write;
    if (!isUuid(id) || !isNonNegativeInteger(baseGeneration)) throw new InvalidBody('commit_write');
    const record = validateRecord(write.record, vaultId, scope);
    if (record.id !== id || record.generation !== baseGeneration + 1) throw new InvalidBody('commit_generation');
    if (ids.has(id)) throw new InvalidBody('duplicate_record');
    ids.add(id);
    writes.push({ id, baseGeneration, record });
  }
  const head = validateHead(body.head, vaultId, scope);
  if (head.seq !== body.expectedHeadSeq + 1) throw new InvalidBody('commit_head_seq');
  if (body.expectedHeadSeq === 0 && head.prevHeadMac !== '') throw new InvalidBody('commit_head_chain');
  return { scope, expectedHeadSeq: body.expectedHeadSeq, writes, head };
}
