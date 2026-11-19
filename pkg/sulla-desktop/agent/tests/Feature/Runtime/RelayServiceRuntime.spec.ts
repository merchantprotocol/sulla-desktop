// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { RelayService } from '../../../../../../services/sulla-relay/src/relay';
import { relayRequestFingerprint } from '../../../../../../packages/relay-protocol/src/relayProtocol';

import type { RelayConfig } from '../../../../../../services/sulla-relay/src/config';
import type { RelayToolCallEnvelope, RelayToolExecutionContext } from '../../../../../../packages/relay-protocol/src/relayProtocol';

const redisUrl = process.env.SULLA_TEST_REDIS_URL;

class FakeSocket {
  readyState = 1;
  readonly sent: any[] = [];
  readonly pings: string[] = [];
  terminated = false;
  closeCode?: number;
  send(raw: string): void { this.sent.push(JSON.parse(raw)) }
  ping(payload: string, _mask: boolean, callback?: (error?: Error) => void): void { this.pings.push(payload); callback?.() }
  terminate(): void { this.terminated = true; this.readyState = 3 }
  close(code?: number): void { this.closeCode = code; this.readyState = 3 }
}

const config: RelayConfig = {
  port: 0, replicaId: `relay-test-${ crypto.randomUUID() }`, redisUrl: redisUrl ?? 'redis://127.0.0.1:1',
  deviceTokenSecret: 'test-device-secret', internalToken: 'test-internal-token',
  maxInFlightPerDevice: 100, presenceTtlSeconds: 45, maxDeadlineMs: 1_800_000,
};
const service = new RelayService(config);
const internals = service as any;

beforeAll(async() => { if (internals.redis.status === 'wait') await internals.redis.connect() });
afterAll(async() => {
  for (const connection of internals.devices.values()) clearInterval(connection.heartbeat);
  internals.subscriber.disconnect();
  if (internals.redis.status === 'ready') await internals.redis.quit(); else internals.redis.disconnect();
});

function callFixture(requestId = `relay-service-${ crypto.randomUUID() }`, deadlineMs = 2_000) {
  const deviceId = `device-${ crypto.randomUUID() }`;
  const ctx: RelayToolExecutionContext = {
    v: 1, iss: 'relay-service-test', aud: 'sulla-tools', sub: 'user-1', scopes: ['github:read'],
    iat: 1, exp: 9_999_999_999, jti: `jti-${ requestId }`, request_id: requestId, device_id: deviceId,
  };
  const category = 'github';
  const tool = 'github_list_prs';
  const args = { owner: 'o', repo: 'r' };
  const fingerprint = relayRequestFingerprint({ deviceId, userId: ctx.sub, ctx, category, tool, args });
  const envelope: RelayToolCallEnvelope = {
    type: 'tool-call', action: 'offer', requestId, deviceId, originReplicaId: config.replicaId,
    requestFingerprint: fingerprint, ctx, category, tool, args, operationTypes: ['read'],
  };
  return { requestId, deviceId, ctx, category, tool, args, fingerprint, envelope, deadlineMs };
}

describe.skipIf(!redisUrl)('relay service Redis lease and liveness boundary', () => {
  it('refreshes presence only on a matching pong and closes a peer that misses the heartbeat window', async() => {
    const fixture = callFixture();
    const socket = new FakeSocket();
    const connection: any = {
      socket, deviceId: fixture.deviceId, userId: fixture.ctx.sub, connectionId: 'connection-live',
      inflight: new Set(), heartbeat: setInterval(() => undefined, 60_000), heartbeatNonce: null,
      heartbeatSentAt: 0, heartbeatRtts: [], lastHeartbeatRttMs: 0,
    };
    internals.devices.set(fixture.deviceId, connection);
    const key = `sulla:relay:device:${ fixture.deviceId }`;
    await internals.redis.set(key, JSON.stringify({ replicaId: config.replicaId, userId: fixture.ctx.sub, connectionId: connection.connectionId }), 'EX', 2);
    const initialTtl = await internals.redis.pttl(key);

    internals.pingDevice(connection);
    expect(socket.pings).toHaveLength(1);
    expect(await internals.redis.pttl(key)).toBeLessThanOrEqual(initialTtl);
    await internals.onHeartbeatPong(connection, Buffer.from('wrong-nonce'));
    expect(await internals.redis.pttl(key)).toBeLessThanOrEqual(initialTtl);
    await internals.onHeartbeatPong(connection, Buffer.from(socket.pings[0]));
    expect(await internals.redis.pttl(key)).toBeGreaterThan(2_000);

    connection.heartbeatNonce = 'unanswered-ping';
    connection.heartbeatSentAt = performance.now() - 31_000;
    internals.pingDevice(connection);
    expect(socket.terminated).toBe(true);
    expect(await internals.redis.pttl(key)).toBeGreaterThan(0);
    clearInterval(connection.heartbeat);
    internals.devices.delete(fixture.deviceId);
    await internals.redis.del(key);
  });

  it('grants a request once and never sends an execute after its original Redis lease expires', async() => {
    const fast = callFixture();
    const registered = await internals.ledger.register({
      requestId: fast.requestId, deviceId: fast.deviceId, userId: fast.ctx.sub,
      originReplicaId: config.replicaId, deadlineMs: fast.deadlineMs,
      identity: { ctx: fast.ctx, category: fast.category, tool: fast.tool, args: fast.args },
    });
    expect(registered.kind).toBe('created');
    const socket = new FakeSocket();
    const connection: any = {
      socket, deviceId: fast.deviceId, userId: fast.ctx.sub, connectionId: 'connection-grant', inflight: new Set(),
      heartbeat: setInterval(() => undefined, 60_000), heartbeatNonce: null, heartbeatSentAt: 0, heartbeatRtts: [], lastHeartbeatRttMs: 0,
    };
    internals.devices.set(fast.deviceId, connection);
    const key = `${ fast.deviceId }\0${ fast.requestId }`;
    const route: any = {
      originReplicaId: config.replicaId, deviceId: fast.deviceId, timer: setTimeout(() => undefined, 60_000),
      envelope: fast.envelope, connectionId: connection.connectionId, connection,
    };
    internals.localRoutes.set(key, route);
    const claim = { type: 'tool-call-claim', requestId: fast.requestId, deviceId: fast.deviceId, requestFingerprint: fast.fingerprint };
    await internals.claimLocal(connection, claim);
    await internals.claimLocal(connection, claim);
    const executeMessages = socket.sent.filter(message => message.type === 'tool-call' && message.action === 'execute');
    expect(executeMessages).toHaveLength(1);
    expect(executeMessages[0].remainingMs).toBeLessThan(fast.deadlineMs);
    expect(executeMessages[0].remainingMs).toBeGreaterThan(0);
    internals.removeLocalRoute(key, route);
    internals.devices.delete(fast.deviceId);
    clearInterval(connection.heartbeat);

    const delayed = callFixture(`relay-delayed-${ crypto.randomUUID() }`, 100);
    const delayedRegistration = await internals.ledger.register({
      requestId: delayed.requestId, deviceId: delayed.deviceId, userId: delayed.ctx.sub,
      originReplicaId: config.replicaId, deadlineMs: delayed.deadlineMs,
      identity: { ctx: delayed.ctx, category: delayed.category, tool: delayed.tool, args: delayed.args },
    });
    expect(delayedRegistration.kind).toBe('created');
    const delayedSocket = new FakeSocket();
    const delayedConnection: any = {
      socket: delayedSocket, deviceId: delayed.deviceId, userId: delayed.ctx.sub, connectionId: 'connection-expired', inflight: new Set(),
      heartbeat: setInterval(() => undefined, 60_000), heartbeatNonce: null, heartbeatSentAt: 0, heartbeatRtts: [], lastHeartbeatRttMs: 0,
    };
    internals.devices.set(delayed.deviceId, delayedConnection);
    const delayedKey = `${ delayed.deviceId }\0${ delayed.requestId }`;
    const delayedRoute: any = {
      originReplicaId: config.replicaId, deviceId: delayed.deviceId, timer: setTimeout(() => undefined, 60_000),
      envelope: delayed.envelope, connectionId: delayedConnection.connectionId, connection: delayedConnection,
    };
    internals.localRoutes.set(delayedKey, delayedRoute);
    await new Promise(resolve => setTimeout(resolve, 150));
    await internals.claimLocal(delayedConnection, { ...claim, requestId: delayed.requestId, deviceId: delayed.deviceId, requestFingerprint: delayed.fingerprint });
    expect(delayedSocket.sent.some(message => message.type === 'tool-call' && message.action === 'execute')).toBe(false);
    expect((await internals.ledger.get(delayed.deviceId, delayed.requestId))?.result?.error?.code).toBe('DEADLINE_EXCEEDED');
    clearInterval(delayedConnection.heartbeat);
    internals.devices.delete(delayed.deviceId);
  });
});
