// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { performance } from 'node:perf_hooks';

import { describe, expect, it, vi } from 'vitest';

vi.mock('undici', () => ({ Agent: class {}, fetch: vi.fn() }));
vi.mock('../../../database/models/SullaSettingsModel', () => ({ SullaSettingsModel: { getServicePassword: vi.fn() } }));

import { FilesContainerClient } from '../../../files/containerClient';
import { DesktopFilesTransportRegistry, SullaFilesUnreachableError } from '../../../files/desktopFilesTransport';

const testApi = ():URL => new URL('https://127.0.0.1:30124/');
const servicePassword = async():Promise<string> => 'synthetic-files-service-secret';
const context = { sub: 'untrusted-caller' };

function identityResponse(principalId = 'principal-1'):Response {
  return Response.json({ principalId });
}

describe('FilesContainerClient local-principal transport', () => {
  it('single-flights a principal within the TTL and refreshes it at expiry', async() => {
    // risk: availability — files/open and publish must not make an identity round-trip for every call.
    let now = 1_000;
    let identityCalls = 0;
    const client = new FilesContainerClient({
      resolveApi: () => ({
        api: testApi(),
        request: async(input) => {
          if (new URL(input).pathname === '/v1/local/identity') {
            identityCalls += 1;
            return identityResponse();
          }
          return Response.json({ ok: true });
        },
      }),
      getServicePassword: servicePassword,
      subscribeTransportReset: () => () => undefined,
      now: () => now,
    });

    try {
      await Promise.all([client.request('/v1/files', context), client.request('/v1/files', context)]);
      now += 59_999;
      await client.request('/v1/files', context);
      expect(identityCalls).toBe(1);

      now += 1;
      await client.request('/v1/files', context);
      expect(identityCalls).toBe(2);
    } finally {
      client.dispose();
    }
  });

  it('invalidates the cached principal after an API 401 and after a transport reset', async() => {
    // risk: authorization — stale caller identity must not survive a rejected token or a reset session.
    let identityCalls = 0;
    let apiCalls = 0;
    const registry = new DesktopFilesTransportRegistry();
    const client = new FilesContainerClient({
      resolveApi: () => ({
        api: testApi(),
        request: async(input) => {
          if (new URL(input).pathname === '/v1/local/identity') {
            identityCalls += 1;
            return identityResponse(`principal-${ identityCalls }`);
          }
          apiCalls += 1;
          return apiCalls === 1 ? Response.json({ error: 'unauthorized' }, { status: 401 }) : Response.json({ ok: true });
        },
      }),
      getServicePassword: servicePassword,
      subscribeTransportReset: listener => registry.onReset(listener),
    });

    try {
      await expect(client.request('/v1/files', context)).rejects.toThrow('unauthorized');
      await client.request('/v1/files', context);
      expect(identityCalls).toBe(2);

      registry.notifyReset();
      await client.request('/v1/files', context);
      expect(identityCalls).toBe(3);
    } finally {
      client.dispose();
    }
  });

  it('returns a typed, actionable error quickly when identity cannot be reached', async() => {
    // risk: availability — callers must get a bounded actionable failure instead of a bare five-second timeout.
    const client = new FilesContainerClient({
      resolveApi: () => ({
        api: testApi(),
        request: (_input, init) => new Promise((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) return reject(new Error('identity request had no timeout'));
          if (signal.aborted) return reject(signal.reason);
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
      }),
      getServicePassword: servicePassword,
      subscribeTransportReset: () => () => undefined,
      identityTimeoutMs: 75,
    });
    const startedAt = performance.now();

    try {
      await expect(client.request('/v1/files', context)).rejects.toBeInstanceOf(SullaFilesUnreachableError);
      expect(performance.now() - startedAt).toBeLessThan(500);
      await expect(client.request('/v1/files', context)).rejects.toThrow('Sulla Files is not reachable from Desktop (request timed out); retry or restart Files');
    } finally {
      client.dispose();
    }
  });
});
