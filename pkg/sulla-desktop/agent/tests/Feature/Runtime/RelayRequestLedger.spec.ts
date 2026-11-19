// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import crypto from 'node:crypto';

import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { RelayRequestLedger } from '../../../../../../services/sulla-relay/src/RequestLedger';

import type { RelayToolExecutionContext, RelayToolResultEnvelope } from '../../../../../../packages/relay-protocol/src/relayProtocol';

const redisUrl = process.env.SULLA_TEST_REDIS_URL;
const redis = redisUrl ? new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 }) : null;
const ledger = redis ? new RelayRequestLedger(redis) : null;

beforeAll(async() => { if (redis && redis.status === 'wait') await redis.connect() });
afterAll(async() => { if (redis?.status === 'ready') await redis.quit(); else redis?.disconnect() });

function context(requestId: string, userId = 'user-1'): RelayToolExecutionContext {
  return {
    v: 1, iss: 'relay-ledger-test', aud: 'sulla-tools', sub: userId, scopes: ['github:read'],
    iat: 1, exp: 9_999_999_999, jti: `jti-${ requestId }`, request_id: requestId,
  };
}

function ledgerRequestKey(deviceId: string, requestId: string): string {
  const id = crypto.createHash('sha256').update(`${ deviceId }\0${ requestId }`, 'utf8').digest('hex');
  return `sulla:relay:request:${ id }`;
}

function registration(requestId: string, options: { args?: unknown; userId?: string; tool?: string; deviceId?: string } = {}) {
  const deviceId = options.deviceId ?? 'device-ledger-test';
  const userId = options.userId ?? 'user-1';
  const tool = options.tool ?? 'github_list_prs';
  const ctx = context(requestId, userId);
  return {
    requestId, deviceId, userId, originReplicaId: 'relay-test', deadlineMs: 2_000,
    identity: { ctx, category: 'github', tool, args: options.args ?? { owner: 'o', repo: 'r' } },
  };
}

describe.skipIf(!redis || !ledger)('relay request ledger against Redis', () => {
  it('binds a request id to exact owner, context, tool and payload, and grants execution once', async() => {
    const requestId = `relay-ledger-${ crypto.randomUUID() }`;
    const initial = registration(requestId);
    expect((await ledger!.register(initial)).kind).toBe('created');
    expect((await ledger!.register(initial)).kind).toBe('existing');
    expect((await ledger!.register(registration(requestId, { args: { owner: 'other', repo: 'r' } }))).kind).toBe('conflict');
    expect((await ledger!.register(registration(requestId, { userId: 'user-2' }))).kind).toBe('conflict');
    expect((await ledger!.register(registration(requestId, { tool: 'github_merge_pr' }))).kind).toBe('conflict');

    const record = await ledger!.get(initial.deviceId, requestId);
    const grant = await ledger!.grantExecution(initial.deviceId, requestId, record!.fingerprint, 100);
    expect(grant.kind).toBe('granted');
    expect((await ledger!.grantExecution(initial.deviceId, requestId, record!.fingerprint, 100)).kind).toBe('already-granted');
  });

  it('keeps a 20 minute request record for the remaining original lease plus retention and does not extend the lease', async() => {
    const requestId = `relay-long-lease-${ crypto.randomUUID() }`;
    const input = registration(requestId);
    const retentionMs = 10 * 60_000;
    input.deadlineMs = 20 * 60_000;
    expect((await ledger!.register(input)).kind).toBe('created');
    expect((await ledger!.register(registration(requestId, { args: { owner: 'other', repo: 'r' } }))).kind).toBe('conflict');
    expect((await ledger!.register(registration(requestId, { userId: 'user-2' }))).kind).toBe('conflict');

    const record = await ledger!.get(input.deviceId, requestId);
    const requestKey = ledgerRequestKey(input.deviceId, requestId);
    const leaseKey = `${ requestKey }:lease`;
    const leaseBefore = Number(await redis!.pttl(leaseKey));
    const recordBefore = Number(await redis!.pttl(requestKey));
    expect(leaseBefore).toBeGreaterThan(19 * 60_000);
    expect(recordBefore).toBeGreaterThan(leaseBefore + retentionMs - 2_000);

    const grant = await ledger!.grantExecution(input.deviceId, requestId, record!.fingerprint, 1_000);
    expect(grant.kind).toBe('granted');
    if (grant.kind === 'granted') {
      expect(grant.remainingMs).toBeGreaterThan(19 * 60_000);
      expect(grant.remainingMs).toBeLessThanOrEqual(leaseBefore);
    }
    const saved = await ledger!.get(input.deviceId, requestId);
    expect(saved?.executionGranted).toBe(true);

    const leaseAfter = Number(await redis!.pttl(leaseKey));
    const recordAfter = Number(await redis!.pttl(requestKey));
    expect(leaseAfter).toBeLessThanOrEqual(leaseBefore);
    expect(leaseAfter).toBeGreaterThan(leaseBefore - 2_000);
    expect(recordAfter).toBeGreaterThanOrEqual(leaseAfter + retentionMs - 2_000);
    expect(recordAfter).toBeLessThanOrEqual(recordBefore + 1_000);

    expect((await ledger!.grantExecution(input.deviceId, requestId, record!.fingerprint, 1_000)).kind).toBe('already-granted');
    const leaseAfterReplay = Number(await redis!.pttl(leaseKey));
    expect(leaseAfterReplay).toBeLessThanOrEqual(leaseAfter);
  });

  it('keeps a stored final or provisional result for the remaining original lease plus retention without touching the lease', async() => {
    const requestId = `relay-long-result-${ crypto.randomUUID() }`;
    const input = registration(requestId);
    const retentionMs = 10 * 60_000;
    const toleranceMs = 2_000;
    input.deadlineMs = 20 * 60_000;
    expect((await ledger!.register(input)).kind).toBe('created');
    const record = await ledger!.get(input.deviceId, requestId);
    const requestKey = ledgerRequestKey(input.deviceId, requestId);
    const leaseKey = `${ requestKey }:lease`;
    expect((await ledger!.grantExecution(input.deviceId, requestId, record!.fingerprint, 1_000)).kind).toBe('granted');
    const leaseAtGrant = Number(await redis!.pttl(leaseKey));
    const recordAtGrant = Number(await redis!.pttl(requestKey));
    const grantedAt = Date.now();

    // A provisional timeout stored early in a 20 minute lease must not cut the record to retention alone.
    const provisional: RelayToolResultEnvelope = {
      type: 'tool-result', requestId, deviceId: input.deviceId, requestFingerprint: record!.fingerprint,
      resultRevision: 1, provisional: true, error: { code: 'DEADLINE_EXCEEDED', message: 'timeout' },
    };
    expect(await ledger!.storeResult(provisional)).toBe('stored');
    const leaseAfterProvisional = Number(await redis!.pttl(leaseKey));
    const recordAfterProvisional = Number(await redis!.pttl(requestKey));
    expect(leaseAfterProvisional).toBeLessThanOrEqual(leaseAtGrant);
    expect(recordAfterProvisional).toBeGreaterThanOrEqual(leaseAfterProvisional + retentionMs - toleranceMs);
    expect(recordAfterProvisional).toBeGreaterThanOrEqual(recordAtGrant - (Date.now() - grantedAt) - toleranceMs);

    // The final result replaces the provisional one; retention still covers the remaining lease.
    const final = { ...provisional, resultRevision: 2, provisional: undefined, late: true, error: undefined, result: { success: true, result: 'original' } };
    expect(await ledger!.storeResult(final)).toBe('stored');
    const leaseAfterFinal = Number(await redis!.pttl(leaseKey));
    const recordAfterFinal = Number(await redis!.pttl(requestKey));
    expect(leaseAfterFinal).toBeLessThanOrEqual(leaseAfterProvisional);
    expect(leaseAfterFinal).toBeGreaterThan(19 * 60_000 - toleranceMs);
    expect(recordAfterFinal).toBeGreaterThanOrEqual(leaseAfterFinal + retentionMs - toleranceMs);
    expect(recordAfterFinal).toBeGreaterThanOrEqual(recordAfterProvisional - (Date.now() - grantedAt) - toleranceMs);

    // The same identity still sees the retained result; a different payload is still a conflict; no new grant.
    const again = await ledger!.register(input);
    expect(again.kind).toBe('existing');
    if (again.kind === 'existing') expect(again.record.result).toMatchObject({ resultRevision: 2, result: { result: 'original' } });
    expect((await ledger!.register(registration(requestId, { args: { owner: 'other', repo: 'r' } }))).kind).toBe('conflict');
    expect((await ledger!.grantExecution(input.deviceId, requestId, record!.fingerprint, 1_000)).kind).toBe('already-granted');
    expect(Number(await redis!.pttl(leaseKey))).toBeLessThanOrEqual(leaseAfterFinal);
  });

  it('never shortens a record whose current retention already exceeds lease plus retention', async() => {
    const requestId = `relay-short-lease-${ crypto.randomUUID() }`;
    const input = registration(requestId);
    input.deadlineMs = 2_000;
    await ledger!.register(input);
    const record = await ledger!.get(input.deviceId, requestId);
    const requestKey = ledgerRequestKey(input.deviceId, requestId);
    const before = Number(await redis!.pttl(requestKey));
    await new Promise(resolve => setTimeout(resolve, 2_100));
    // Lease is gone now; the record still holds its original retention from registration.
    expect(Number(await redis!.pttl(`${ requestKey }:lease`))).toBeLessThan(0);
    const startedAt = Date.now();
    expect(await ledger!.storeResult({
      type: 'tool-result', requestId, deviceId: input.deviceId, requestFingerprint: record!.fingerprint,
      resultRevision: 1, error: { code: 'DEADLINE_EXCEEDED', message: 'lease expired before execution' },
    })).toBe('stored');
    const after = Number(await redis!.pttl(requestKey));
    expect(after).toBeGreaterThanOrEqual(before - 2_100 - (Date.now() - startedAt) - 1_000);
  });

  it('refuses a delayed queued call after the original Redis lease expires', async() => {
    const requestId = `relay-expired-${ crypto.randomUUID() }`;
    const input = registration(requestId);
    input.deadlineMs = 100;
    await ledger!.register(input);
    await new Promise(resolve => setTimeout(resolve, 150));
    const record = await ledger!.get(input.deviceId, requestId);
    let mutationCount = 0;
    const grant = await ledger!.grantExecution(input.deviceId, requestId, record!.fingerprint, 25);
    if (grant.kind === 'granted') mutationCount++;
    expect(grant.kind).toBe('expired');
    expect(mutationCount).toBe(0);
  });

  it('retains the first result, accepts an identical duplicate, and lets a late revision supersede a provisional timeout', async() => {
    const requestId = `relay-result-${ crypto.randomUUID() }`;
    const input = registration(requestId);
    await ledger!.register(input);
    const record = await ledger!.get(input.deviceId, requestId);
    const provisional: RelayToolResultEnvelope = {
      type: 'tool-result' as const, requestId, deviceId: input.deviceId,
      requestFingerprint: record!.fingerprint, resultRevision: 1, provisional: true,
      error: { code: 'DEADLINE_EXCEEDED', message: 'timeout' },
    };
    expect(await ledger!.storeResult(provisional)).toBe('stored');
    expect(await ledger!.storeResult(provisional)).toBe('duplicate');
    const late = { ...provisional, resultRevision: 2, provisional: undefined, late: true, error: undefined, result: { success: true, result: 'original' } };
    expect(await ledger!.storeResult(late)).toBe('stored');
    const saved = await ledger!.get(input.deviceId, requestId);
    expect(saved?.result).toMatchObject({ resultRevision: 2, late: true, result: { result: 'original' } });
    expect(await ledger!.storeResult({ ...late, result: { success: true, result: 'changed' } })).toBe('conflict');
  });
});
