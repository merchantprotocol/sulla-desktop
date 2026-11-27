// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { EventEmitter } from 'node:events';
import { X509Certificate } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from 'undici';

import { PinnedNodeAgentFactory } from '@pkg/vault-broker/PinnedNodeAgentFactory';

import { FILES_HTTPS_ORIGIN, SullaFilesTlsService } from '../../../../main/sullaFilesTls';

vi.mock('electron', () => {
  const session = { fromPartition: vi.fn() };
  return { default: { session }, session };
});

const PIN_TEST_CERTIFICATE = `-----BEGIN CERTIFICATE-----
MIIDGjCCAgKgAwIBAgIUD6YDu1RJo+gA1WhjJHwva6AnNUUwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJMTI3LjAuMC4xMB4XDTI2MTEyNzAyMzM0OVoXDTM2MTEy
NDAyMzM0OVowFDESMBAGA1UEAwwJMTI3LjAuMC4xMIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEA6lrtKY766XGwbOrg8HHqBkZyhr2coiA/0TgWSIu0h9uw
vBscg/NuN3ti/db51MBKMjy0lSJSon+r4lwhMMlw+g5sqR/C/a4Kl6E3cy7sf/A8
0LGxviXnEW0fU2iR6IxbgJQcvt5plVIIEBpuQGqMntPNuGk9Ec6fSDkYOz5613v2
hBL4bKGRwslOZiEwhw1g91Fh1WvpS668+8WOyrSVymGIQob5k2X1601PsZusZDMS
Yo4Xp9FwLTOhqCQ4X6Wv+LPWIxDG/2i94AG8bAjGC+I47CzTCZUXfLulha2SohSr
MQpTGcwavRTQukG1Z8NvkZWKYDGVZHSo13qaqE3TawIDAQABo2QwYjAdBgNVHQ4E
FgQU3RqkER2ZOWQzlbhmwE3kYvejO/QwHwYDVR0jBBgwFoAU3RqkER2ZOWQzlbhm
wE3kYvejO/QwDwYDVR0TAQH/BAUwAwEB/zAPBgNVHREECDAGhwR/AAABMA0GCSqG
SIb3DQEBCwUAA4IBAQCS/LQ0e1BROgo0pNCoNFyEn41OK50h24pPrZ6qpjhTkedM
gE6IJNQxgwjk3rQEQG2uVjJDWsccmMegCM6H4guE24fJ+KiOInJONlS+FzqU+SP/
4AzXGlZy5oixgZx57mPgqTF6ZAMO8Slnm2vcrwWH2xvsvql/aOjepr4A7WmnDsnH
R5j3g2cGDYBXh2K20FHay8EeKGPx5eUa7FtoNFH9ulAV1YqIOtXHT4FSir9ld4no
PX4/GK5uAlPWc4kysqOfptsa93yBO8aEaHww0QSw7yez+ock/yNXICre07EhWeUX
1mLPjgunuSuoFl3j9QJX76l5goVyX3B/oTCfVSaV
-----END CERTIFICATE-----`;

class SyntheticTlsSocket extends EventEmitter {
  readonly destroy = vi.fn();

  constructor(private readonly certificate: Buffer) { super() }

  getPeerCertificate():{ raw:Buffer } { return { raw: this.certificate } }
}

function transportHarness(expectedPin:string) {
  const agentOptions:Array<Agent.Options> = [];
  const socket = new SyntheticTlsSocket(new X509Certificate(PIN_TEST_CERTIFICATE).raw);
  const tlsConnect = vi.fn(() => {
    queueMicrotask(() => socket.emit('secureConnect'));
    return socket as never;
  });
  const dispatcherFactory = vi.fn((options:Agent.Options) => {
    agentOptions.push(options);
    return { destroy: vi.fn(async() => undefined) } as unknown as Agent;
  });
  const nodeAgentFactory = new PinnedNodeAgentFactory(dispatcherFactory, tlsConnect as never);
  const electronFetch = vi.fn(async() => new Response('electron'));
  const nodeFetch = vi.fn(async() => new Response('node'));
  const service = new SullaFilesTlsService({
    createSession: async() => ({ fetch: electronFetch, closeAllConnections: vi.fn() }),
    readFingerprintFile: async() => expectedPin,
    nodeFetch: nodeFetch as never,
    nodeAgentFactory,
    logConcurrency: () => undefined,
  });
  return { service, agentOptions, tlsConnect, socket, electronFetch, nodeFetch };
}

const matchingPin = new X509Certificate(PIN_TEST_CERTIFICATE).fingerprint256.replaceAll(':', '').toLowerCase();
const differentPin = `${matchingPin[0] === '0' ? '1' : '0'}${matchingPin.slice(1)}`;

function deferred<T = void>():{ promise:Promise<T>; resolve:(value:T) => void } {
  let resolve!:(value:T) => void;
  const promise = new Promise<T>((done) => { resolve = done });
  return { promise, resolve };
}

async function connectWith(options:Agent.Options | undefined, hostname:string):Promise<Error | null> {
  const connector = options?.connect as unknown as (
    options:{ hostname:string; port:string; servername?:string },
    callback:(error:Error | null, socket?:unknown) => void,
  ) => unknown;
  return new Promise(resolve => connector({ hostname, port:'30124' }, error => resolve(error)));
}

describe('Desktop Files pinned undici transport', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('rejects a certificate whose fingerprint differs from the Files pin', async() => {
    // risk: authentication — an untrusted local process must not impersonate Sulla Files.
    const harness = transportHarness(differentPin);
    const response = await harness.service.desktopFilesFetch(`${FILES_HTTPS_ORIGIN}/v1/local/identity`);
    await response.text();
    const error = await connectWith(harness.agentOptions[0], '127.0.0.1');

    expect(error?.message).toBe('Files TLS certificate pin verification failed');
    expect(harness.tlsConnect).toHaveBeenCalledWith(expect.objectContaining({ host:'127.0.0.1', rejectUnauthorized:false }));
    expect(harness.socket.destroy).toHaveBeenCalledTimes(1);
  });

  it('rejects a matching pin presented by any host other than the loopback IP', async() => {
    // risk: authentication — a matching certificate must not authorize a non-loopback endpoint.
    const harness = transportHarness(matchingPin);
    const response = await harness.service.desktopFilesFetch(`${FILES_HTTPS_ORIGIN}/v1/local/identity`);
    await response.text();
    const error = await connectWith(harness.agentOptions[0], 'localhost');

    expect(error?.message).toBe('Files TLS certificate pin verification failed');
    expect(harness.socket.destroy).toHaveBeenCalledTimes(1);
  });

  it('accepts the current Files certificate only for 127.0.0.1', async() => {
    // risk: availability — the pinned local Files certificate must remain usable after migration.
    const harness = transportHarness(matchingPin);
    const response = await harness.service.desktopFilesFetch(`${FILES_HTTPS_ORIGIN}/v1/local/identity`);
    await response.text();

    await expect(connectWith(harness.agentOptions[0], '127.0.0.1')).resolves.toBeNull();
    expect(harness.socket.destroy).not.toHaveBeenCalled();
  });

  it('keeps the exact HTTPS loopback origin guard ahead of either transport', async() => {
    // risk: permissions — Files credentials and identity must never reach a different host or port.
    const harness = transportHarness(matchingPin);

    await expect(harness.service.desktopFilesFetch('https://localhost:30124/v1/local/identity')).rejects.toThrow('Pinned Files transport rejected a nonlocal destination');
    await expect(harness.service.desktopFilesFetch('https://127.0.0.1:30125/v1/local/identity')).rejects.toThrow('Pinned Files transport rejected a nonlocal destination');
    expect(harness.nodeFetch).not.toHaveBeenCalled();
    expect(harness.electronFetch).not.toHaveBeenCalled();
  });

  it('uses the Electron session when the rollback environment switch is set', async() => {
    // risk: availability — operators must be able to restore the previous transport without changing origin policy.
    vi.stubEnv('SULLA_FILES_TRANSPORT', 'electron');
    const harness = transportHarness(matchingPin);
    const response = await harness.service.desktopFilesFetch(`${FILES_HTTPS_ORIGIN}/v1/local/identity`);

    await expect(response.text()).resolves.toBe('electron');
    expect(harness.electronFetch).toHaveBeenCalledTimes(1);
    expect(harness.nodeFetch).not.toHaveBeenCalled();
    expect(harness.service.getConcurrencyMetrics()['electron GET /v1/local']).toMatchObject({ active:0, bodyOpen:0, maxActive:1, count:1 });
  });

  it('uses the bounded pinned Node Agent by default and records its configured capacity', async() => {
    // risk: availability — Desktop Files must move off Chromium while remaining bounded.
    const harness = transportHarness(matchingPin);
    const response = await harness.service.desktopFilesFetch(`${FILES_HTTPS_ORIGIN}/v1/local/identity`);

    await expect(response.text()).resolves.toBe('node');
    expect(harness.nodeFetch).toHaveBeenCalledTimes(1);
    expect(harness.agentOptions[0]?.connections).toBe(64);
    expect(harness.service.getConcurrencyMetrics()['node GET /v1/local']).toMatchObject({ active:0, bodyOpen:0, maxActive:1, count:1 });
  });

  it('dispatches 20 concurrent mixed Desktop requests to the Node fetch stub at once', async() => {
    // risk: availability — concurrent UI and agent work must escape the old six-connection session ceiling.
    const harness = transportHarness(matchingPin);
    const releaseRequests = deferred();
    let active = 0;
    let maxActive = 0;
    harness.nodeFetch.mockImplementation(async() => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await releaseRequests.promise;
      active -= 1;
      return new Response(null, { status:204 });
    });
    const responses = Promise.all(Array.from({ length: 20 }, (_, index) => harness.service.desktopFilesFetch(
      `${FILES_HTTPS_ORIGIN}/v1/files/${index}`, { method:index % 2 ? 'PUT' : 'GET' },
    )));

    await new Promise(resolve => setImmediate(resolve));
    const measuredMaxActive = maxActive;
    const metricsBeforeRelease = harness.service.getConcurrencyMetrics();
    const stubCallsBeforeRelease = harness.nodeFetch.mock.calls.length;
    try {
      expect(measuredMaxActive).toBe(20);
      expect(stubCallsBeforeRelease).toBe(20);
    } finally {
      releaseRequests.resolve();
    }
    const completed = await responses;

    expect(metricsBeforeRelease).toMatchObject({
      'node GET /v1/files': { active:10, bodyOpen:0, maxActive:10, count:0 },
      'node PUT /v1/files': { active:10, bodyOpen:0, maxActive:10, count:0 },
    });
    expect(completed).toHaveLength(20);
    expect(Object.keys(harness.service.getConcurrencyMetrics()).sort()).toEqual(['node GET /v1/files', 'node PUT /v1/files']);
  });
});
