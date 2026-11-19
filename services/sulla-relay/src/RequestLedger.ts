// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { createHash } from 'node:crypto';

import { relayRequestFingerprint } from '../../../packages/relay-protocol/src/relayProtocol.js';

import type { RelayRequestIdentity, RelayToolResultEnvelope } from '../../../packages/relay-protocol/src/relayProtocol.js';

export interface RelayLedgerRedis {
  eval(script: string, numberOfKeys: number, ...args: string[]): Promise<unknown>;
  get(key: string): Promise<string | null>;
  pttl(key: string): Promise<number>;
}

export interface RelayRequestRecord {
  requestId: string;
  deviceId: string;
  userId: string;
  originReplicaId: string;
  category: string;
  tool: string;
  fingerprint: string;
  deadlineMs: number;
  executionGranted?: boolean;
  grantedBudgetMs?: number;
  result?: RelayToolResultEnvelope;
}

export type RelayRequestRegistration =
  | { kind: 'created'; record: RelayRequestRecord }
  | { kind: 'existing'; record: RelayRequestRecord }
  | { kind: 'conflict' };

export type RelayResultWrite = 'stored' | 'duplicate' | 'missing' | 'fingerprint-mismatch' | 'conflict';

export type RelayExecutionGrant =
  | { kind: 'granted'; remainingMs: number }
  | { kind: 'already-granted' }
  | { kind: 'expired' }
  | { kind: 'missing' }
  | { kind: 'fingerprint-mismatch' };

const CREATE_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if current then return {0, current} end
redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
redis.call('SET', KEYS[2], '1', 'PX', ARGV[3])
return {1, ARGV[1]}
`;

const STORE_RESULT_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return -1 end
local record = cjson.decode(raw)
if record.fingerprint ~= ARGV[1] then return -2 end
local incoming = cjson.decode(ARGV[2])
if record.result then
  local current = record.result
  local currentRevision = tonumber(current.resultRevision or 1)
  local incomingRevision = tonumber(incoming.resultRevision or 1)
  if incomingRevision < currentRevision then return 0 end
  if incomingRevision == currentRevision then
    if record.resultHash == ARGV[3] then return 1 end
    return -3
  end
  if not current.provisional then return -3 end
end
record.result = incoming
record.resultHash = ARGV[3]
-- A stored result never shortens retention: keep the record for the remaining
-- ORIGINAL lease plus result retention, or its current TTL if that is longer.
-- The lease key is only read here, never extended or re-created.
local keep = redis.call('PTTL', KEYS[2])
if keep < 0 then keep = 0 end
keep = keep + tonumber(ARGV[4])
local current = redis.call('PTTL', KEYS[1])
if current > keep then keep = current end
redis.call('SET', KEYS[1], cjson.encode(record), 'PX', keep)
return 2
`;

const GRANT_EXECUTION_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return {-1, 0} end
local record = cjson.decode(raw)
if record.fingerprint ~= ARGV[1] then return {-2, 0} end
if record.executionGranted then return {0, 0} end
local remaining = redis.call('PTTL', KEYS[2])
if remaining <= tonumber(ARGV[2]) then return {-3, remaining} end
local budget = remaining - tonumber(ARGV[2])
record.executionGranted = true
record.grantedBudgetMs = budget
-- Keep the record for the remaining original lease plus result retention.
-- Do not shorten that to retention alone, and do not touch the lease key.
local recordTtl = math.floor(remaining + tonumber(ARGV[3]))
redis.call('SET', KEYS[1], cjson.encode(record), 'PX', recordTtl)
return {1, budget}
`;

/** Redis-backed idempotency and late-result ledger shared by relay replicas. */
export class RelayRequestLedger {
  constructor(
    private readonly redis: RelayLedgerRedis,
    private readonly resultRetentionMs = 10 * 60_000,
  ) {}

  async register(input: {
    requestId: string;
    deviceId: string;
    userId: string;
    originReplicaId: string;
    deadlineMs: number;
    identity: Omit<RelayRequestIdentity, 'deviceId' | 'userId'>;
  }): Promise<RelayRequestRegistration> {
    const fingerprint = relayRequestFingerprint({ ...input.identity, deviceId: input.deviceId, userId: input.userId });
    const record: RelayRequestRecord = {
      requestId: input.requestId,
      deviceId: input.deviceId,
      userId: input.userId,
      originReplicaId: input.originReplicaId,
      category: input.identity.category,
      tool: input.identity.tool,
      fingerprint,
      deadlineMs: input.deadlineMs,
    };
    const raw = JSON.stringify(record);
    const [created, storedRaw] = await this.redis.eval(
      CREATE_SCRIPT, 2, this.requestKey(input.deviceId, input.requestId), this.leaseKey(input.deviceId, input.requestId),
      raw, String(this.resultRetentionMs + input.deadlineMs), String(input.deadlineMs),
    ) as [number, string];
    const stored = JSON.parse(storedRaw) as RelayRequestRecord;
    if (stored.fingerprint !== fingerprint) return { kind: 'conflict' };
    return { kind: created === 1 ? 'created' : 'existing', record: stored };
  }

  async get(deviceId: string, requestId: string): Promise<RelayRequestRecord | null> {
    const raw = await this.redis.get(this.requestKey(deviceId, requestId));
    if (!raw) return null;
    try { return JSON.parse(raw) as RelayRequestRecord } catch { return null }
  }

  async remainingMs(deviceId: string, requestId: string): Promise<number> {
    const remaining = await this.redis.pttl(this.leaseKey(deviceId, requestId));
    return remaining > 0 ? remaining : 0;
  }

  async grantExecution(deviceId: string, requestId: string, fingerprint: string, safetyMs: number): Promise<RelayExecutionGrant> {
    const [status, remainingMs] = await this.redis.eval(
      GRANT_EXECUTION_SCRIPT, 2, this.requestKey(deviceId, requestId), this.leaseKey(deviceId, requestId),
      fingerprint, String(safetyMs), String(this.resultRetentionMs),
    ) as [number, number];
    if (status === 1) return { kind: 'granted', remainingMs: Number(remainingMs) };
    if (status === 0) return { kind: 'already-granted' };
    if (status === -1) return { kind: 'missing' };
    if (status === -2) return { kind: 'fingerprint-mismatch' };
    return { kind: 'expired' };
  }

  async storeResult(envelope: RelayToolResultEnvelope): Promise<RelayResultWrite> {
    if (!envelope.requestFingerprint) return 'fingerprint-mismatch';
    const encoded = JSON.stringify(envelope);
    const resultHash = createHash('sha256').update(encoded, 'utf8').digest('hex');
    const stored = Number(await this.redis.eval(
      STORE_RESULT_SCRIPT, 2, this.requestKey(envelope.deviceId, envelope.requestId), this.leaseKey(envelope.deviceId, envelope.requestId),
      envelope.requestFingerprint, encoded, resultHash, String(this.resultRetentionMs),
    ));
    if (stored === 2) return 'stored';
    if (stored === 1) return 'duplicate';
    if (stored === -1) return 'missing';
    if (stored === -2) return 'fingerprint-mismatch';
    if (stored === 0) return 'duplicate';
    return 'conflict';
  }

  async getForIdentity(deviceId: string, requestId: string, fingerprint: string): Promise<RelayRequestRecord | null> {
    const record = await this.get(deviceId, requestId);
    return record?.fingerprint === fingerprint ? record : null;
  }

  private requestKey(deviceId: string, requestId: string): string {
    const id = createHash('sha256').update(`${ deviceId }\0${ requestId }`, 'utf8').digest('hex');
    return `sulla:relay:request:${ id }`;
  }

  private leaseKey(deviceId: string, requestId: string): string {
    return `${ this.requestKey(deviceId, requestId) }:lease`;
  }
}
