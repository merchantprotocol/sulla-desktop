// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { UpstreamHttpClient } from '../../../../../../services/sulla-vault/src/localAuthority/UpstreamHttpClient';

import type { LocalAuthorityHost } from '../../../../../../services/sulla-vault/src/localAuthority/LocalAuthorityHost';

const connector = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('node:https', () => ({ default: { request: connector.request }, request: connector.request }));

const address = { address: '93.184.216.34', family: 4 as const };

function fakeConnector(onFirstFailure: () => void, peerRequests: { count: number }) {
  connector.request.mockImplementation((_options: unknown, onResponse: (response: unknown) => void) => {
    const attempt = connector.request.mock.calls.length;
    const request = Object.assign(new EventEmitter(), {
      reusedSocket: false,
      destroyed: false,
      write: vi.fn(),
      end: vi.fn(() => {
        queueMicrotask(() => {
          if (attempt === 1) {
            onFirstFailure();
            request.emit('error', Object.assign(new Error('synthetic pre-TLS refusal'), {
              code: 'ECONNREFUSED', syscall: 'connect',
            }));
            return;
          }
          const socket = new EventEmitter();
          request.emit('socket', socket);
          socket.emit('secureConnect');
          peerRequests.count++;
          const response = new PassThrough() as PassThrough & { statusCode?: number; headers?: Record<string, string> };
          response.statusCode = 200;
          response.headers = {};
          onResponse(response);
          setImmediate(() => response.end('{"ok":true}'));
        });
      }),
      destroy: vi.fn((error?: Error) => {
        request.destroyed = true;
        if (error) queueMicrotask(() => request.emit('error', error));
        return request;
      }),
    });
    return request;
  });
}

function upstream() {
  const host = {
    generation: 1,
    inFlight: new Set(),
    requireGeneration: vi.fn(),
    brokerRedirectPolicy: { allowsGitHubLogRedirect: vi.fn(() => false) },
  } as unknown as LocalAuthorityHost;
  const resolver = { resolve: vi.fn(() => Promise.resolve([address])) };
  const client = new UpstreamHttpClient(host, resolver as never);
  const target = Object.assign(new URL('https://api.clerk.com/v1/users/user_fixture'), {
    pinnedAddress: address.address,
    pinnedFamily: address.family,
    pinnedAddresses: [address],
  });
  return { client, resolver, target };
}

afterEach(() => { vi.clearAllMocks(); vi.restoreAllMocks() });

describe('Clerk upstream connector retry admission', () => {
  it('does not reconnect a production write after policy revocation at the first pre-TLS failure', async() => {
    let allowed = true;
    let revision = 4;
    const peerRequests = { count: 0 };
    fakeConnector(() => { allowed = false; revision++ }, peerRequests);
    const { client, resolver, target } = upstream();

    await expect(client.send(
      target, 'PATCH', {}, { first_name: 'Synthetic' }, 'json', [], 1,
      true, undefined, undefined, 'clerk.backend', 'clerk', undefined, false,
    )).rejects.toMatchObject({ code: 'upstream_failed' });

    expect(allowed).toBe(false);
    expect(revision).toBe(5);
    expect(connector.request).toHaveBeenCalledTimes(1);
    expect(resolver.resolve).not.toHaveBeenCalled();
    expect(peerRequests.count).toBe(0);
  });

  it('keeps bounded pre-TLS reconnects for ordinary broker traffic', async() => {
    const peerRequests = { count: 0 };
    fakeConnector(() => {}, peerRequests);
    const { client, resolver, target } = upstream();

    const result = await client.send(
      target, 'GET', {}, undefined, 'json', [], 1,
      true, undefined, undefined, 'broker.request', 'github', undefined, true,
    );

    expect(result).toMatchObject({ status: 200, body: { ok: true } });
    expect(connector.request).toHaveBeenCalledTimes(2);
    expect(resolver.resolve).toHaveBeenCalledWith('api.clerk.com', { fresh: true });
    expect(peerRequests.count).toBe(1);
  });
});
