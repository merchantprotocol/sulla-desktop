// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import crypto from 'node:crypto';
import http from 'node:http';

import jwt from 'jsonwebtoken';
import Redis from 'ioredis';
import WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { relayRequestFingerprint } from '../../../../../../packages/relay-protocol/src/relayProtocol';
import { RelayToolTunnel } from '../../../../runtime/relayTunnelClient';
import { RelayService } from '../../../../../../services/sulla-relay/src/relay';

import type { RelayConfig } from '../../../../../../services/sulla-relay/src/config';
import type { RelayToolExecutionContext, RelayToolResult } from '../../../../../../packages/relay-protocol/src/relayProtocol';

const redisUrl = process.env.SULLA_TEST_REDIS_URL;
const deviceSecret = 'relay-wire-fixture-device-secret';
const internalToken = 'relay-wire-fixture-internal-token';
const deviceId = `relay-wire-device-${ crypto.randomUUID() }`;
const userId = 'relay-wire-user';
const redis = redisUrl ? new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 }) : null;
const firstReplicaId = `relay-wire-a-${ crypto.randomUUID() }`;
const secondReplicaId = `relay-wire-b-${ crypto.randomUUID() }`;

function config(replicaId: string): RelayConfig {
  return {
    port: 0, replicaId, redisUrl: redisUrl ?? 'redis://127.0.0.1:1',
    deviceTokenSecret: deviceSecret, internalToken,
    maxInFlightPerDevice: 100, presenceTtlSeconds: 45, maxDeadlineMs: 1_800_000,
  };
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected an ephemeral TCP listener');
  return address.port;
}

function createReplica(replicaConfig: RelayConfig): { relay: RelayService; server: http.Server; port?: number } {
  const relay = new RelayService(replicaConfig);
  const server = http.createServer((request, response) => {
    relay.handleHttp(request, response).catch(error => {
      if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'application/json' });
      if (!response.writableEnded) response.end(JSON.stringify({ error: { code: 'INTERNAL', message: String(error) } }));
    });
  });
  server.on('upgrade', (request, socket, head) => relay.upgrade(request, socket, head));
  return { relay, server };
}

function context(requestId: string, owner = userId, targetDevice = deviceId): RelayToolExecutionContext {
  const now = Math.floor(Date.now() / 1_000);
  return {
    v: 1, iss: 'relay-wire-acceptance', aud: 'sulla-tools', sub: owner, device_id: targetDevice,
    scopes: ['meta:read'], iat: now, exp: now + 60,
    jti: `wire-${ requestId }`, request_id: requestId,
  };
}

function requestJson(url: string, options: { method: string; headers: Record<string, string>; body?: unknown }): Promise<{ status: number; body: any }> {
  const target = new URL(url);
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);
  return new Promise((resolve, reject) => {
    const request = http.request(target, {
      method: options.method,
      headers: { ...options.headers, ...(body ? { 'Content-Length': String(Buffer.byteLength(body)) } : {}) },
    }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        try {
          resolve({ status: response.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        } catch (error) { reject(error) }
      });
    });
    request.on('error', reject);
    if (body) request.write(body);
    request.end();
  });
}

async function waitUntil(predicate: () => boolean, description: string, timeoutMs = 5_000): Promise<void> {
  const expiresAt = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= expiresAt) throw new Error(`Timed out waiting for ${ description }`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

describe.skipIf(!redisUrl)('authenticated relay HTTP/WebSocket wire path', () => {
  const replicaA = createReplica(config(firstReplicaId));
  const replicaB = createReplica(config(secondReplicaId));
  let relayAUrl = '';
  let relayBUrl = '';
  let tunnel: RelayToolTunnel | null = null;
  let replicaAStopped = false;
  let executions = 0;
  const sockets: WebSocket[] = [];
  let finishReconnectCall: ((result: RelayToolResult) => void) | null = null;
  let reconnectCallEntered: (() => void) | null = null;
  const reconnectCallReady = new Promise<void>(resolve => { reconnectCallEntered = resolve });

  beforeAll(async() => {
    if (redis?.status === 'wait') await redis.connect();
    await Promise.all([replicaA.relay.start(), replicaB.relay.start()]);
    const [portA, portB] = await Promise.all([listen(replicaA.server), listen(replicaB.server)]);
    relayAUrl = `http://127.0.0.1:${ portA }`;
    relayBUrl = `http://127.0.0.1:${ portB }`;
    const token = jwt.sign({ sub: userId, device_id: deviceId, aud: 'sulla-relay-device' }, deviceSecret, {
      algorithm: 'HS256', expiresIn: '5m',
    });
    tunnel = new RelayToolTunnel({
      relayUrl: relayAUrl,
      deviceToken: token,
      deviceId: async() => deviceId,
      currentUserId: async() => userId,
      createSocket: (url, deviceToken) => {
        const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${ deviceToken }` } });
        sockets.push(socket);
        return socket;
      },
      execute: async(ctx, _category, tool, args) => {
        executions++;
        if (tool === 'reconnect-read') {
          reconnectCallEntered?.();
          return await new Promise<RelayToolResult>(resolve => { finishReconnectCall = resolve });
        }
        return { success: true, result: { args, subject: ctx.sub } };
      },
    });
    tunnel.start();
    await waitUntil(() => sockets.some(socket => socket.readyState === WebSocket.OPEN), 'authenticated Desktop tunnel connection');
    await waitUntil(() => (replicaA.relay as any).devices.size === 1, 'relay-owned device presence');
  }, 10_000);

  afterAll(async() => {
    tunnel?.stop();
    for (const socket of sockets) if (socket.readyState === WebSocket.OPEN) socket.close();
    await Promise.all([replicaA.server, replicaB.server].map(server => new Promise<void>(resolve => {
      if (!server.listening) { resolve(); return }
      server.close(() => resolve());
    })));
    await Promise.all([replicaAStopped ? Promise.resolve() : replicaA.relay.stop(), replicaB.relay.stop()]);
    if (redis?.status === 'ready') await redis.quit(); else redis?.disconnect();
  }, 10_000);

  it('routes once across replicas, rejects request-id payload changes, and retrieves the saved result', async() => {
    const ctx = context(`wire-duplicate-${ crypto.randomUUID() }`);
    const args = { value: 'original' };
    const endpoint = `${ relayBUrl }/v1/devices/${ deviceId }/tools/meta/echo`;
    const request = () => requestJson(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ internalToken }`, 'Content-Type': 'application/json' },
      body: { ctx, args, deadlineMs: 10_000, operationTypes: ['read'] },
    });

    const first = await request();
    expect(first).toMatchObject({ status: 200, body: { result: { success: true, result: { args, subject: userId } } } });
    expect(executions).toBe(1);

    const duplicate = await request();
    expect(duplicate).toEqual(first);
    expect(executions).toBe(1);

    const changed = await requestJson(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ internalToken }`, 'Content-Type': 'application/json' },
      body: { ctx, args: { value: 'changed' }, deadlineMs: 10_000, operationTypes: ['read'] },
    });
    expect(changed).toMatchObject({ status: 409, body: { error: { code: 'REQUEST_ID_REUSE' } } });
    expect(executions).toBe(1);

    const fingerprint = relayRequestFingerprint({ deviceId, userId, ctx, category: 'meta', tool: 'echo', args });
    const retrieved = await requestJson(`${ relayBUrl }/v1/devices/${ deviceId }/tools/results/${ encodeURIComponent(ctx.request_id) }`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${ internalToken }`, 'X-Sulla-Request-Fingerprint': fingerprint },
    });
    expect(retrieved).toEqual(first);
  });

  it('retains an original completed result through tunnel reconnect without rerunning the tool', async() => {
    const ctx = context(`wire-reconnect-${ crypto.randomUUID() }`);
    const args = { value: 'survives reconnect' };
    const endpoint = `${ relayBUrl }/v1/devices/${ deviceId }/tools/meta/reconnect-read`;
    const call = requestJson(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ internalToken }`, 'Content-Type': 'application/json' },
      body: { ctx, args, deadlineMs: 10_000, operationTypes: ['read'] },
    });
    await reconnectCallReady;
    expect(executions).toBe(2);

    const originalSocket = sockets[0];
    originalSocket.terminate();
    await waitUntil(() => (tunnel as any).socket === null, 'Desktop tunnel disconnect');
    finishReconnectCall?.({ success: true, result: { args, subject: userId } });
    await waitUntil(() => (tunnel as any).outbox.size === 1, 'bounded result outbox capture');
    expect((tunnel as any).outbox.size).toBe(1);

    await waitUntil(() => sockets.length >= 2 && sockets[1].readyState === WebSocket.OPEN, 'Desktop tunnel reconnect');
    const firstResponse = await call;
    expect(firstResponse).toMatchObject({ status: 200, body: { result: { success: true, result: { args, subject: userId } } } });
    await waitUntil(() => (tunnel as any).outbox.size === 0, 'relay acknowledgement of stored result');
    expect(executions).toBe(2);

    const duplicate = await requestJson(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ internalToken }`, 'Content-Type': 'application/json' },
      body: { ctx, args, deadlineMs: 10_000, operationTypes: ['read'] },
    });
    expect(duplicate).toEqual(firstResponse);
    expect(executions).toBe(2);
  });

  it('keeps offline and cross-user checks on the authenticated HTTP path', async() => {
    const offlineDevice = `relay-wire-offline-${ crypto.randomUUID() }`;
    const offline = await requestJson(`${ relayBUrl }/v1/devices/${ offlineDevice }/tools/meta/echo`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ internalToken }`, 'Content-Type': 'application/json' },
      body: { ctx: context(`wire-offline-${ crypto.randomUUID() }`, userId, offlineDevice), args: {}, deadlineMs: 1_000 },
    });
    expect(offline).toMatchObject({ status: 503, body: { error: { code: 'DEVICE_OFFLINE' } } });

    const crossUser = await requestJson(`${ relayBUrl }/v1/devices/${ deviceId }/tools/meta/echo`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ internalToken }`, 'Content-Type': 'application/json' },
      body: { ctx: context(`wire-cross-user-${ crypto.randomUUID() }`, 'different-user'), args: {}, deadlineMs: 1_000 },
    });
    expect(crossUser).toMatchObject({ status: 403, body: { error: { code: 'FORBIDDEN' } } });
  });

  it('deletes presence before Redis closes and completes socket cleanup without errors', async() => {
    const presenceKey = `sulla:relay:device:${ deviceId }`;
    expect(await redis!.get(presenceKey)).not.toBeNull();
    const commandRedis = (replicaA.relay as any).redis;
    const originalQuit = commandRedis.quit;
    let presenceAtQuit: string | null | undefined;
    commandRedis.quit = async(...args: unknown[]) => {
      presenceAtQuit = await redis!.get(presenceKey);
      return await originalQuit.apply(commandRedis, args);
    };
    const errorSpy = vi.spyOn(console, 'error');
    const unhandledRejection = vi.fn();
    process.on('unhandledRejection', unhandledRejection);
    try {
      await replicaA.relay.stop();
      replicaAStopped = true;
      expect(presenceAtQuit).toBeNull();
      expect(await redis!.get(presenceKey)).toBeNull();
      tunnel?.stop();
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(errorSpy).not.toHaveBeenCalled();
      expect(unhandledRejection).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandledRejection);
      commandRedis.quit = originalQuit;
      errorSpy.mockRestore();
      tunnel?.stop();
    }
  });
});
