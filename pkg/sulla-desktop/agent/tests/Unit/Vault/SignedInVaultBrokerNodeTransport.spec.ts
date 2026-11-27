// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { EventEmitter } from 'node:events';
import { X509Certificate } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from 'undici';

import { SignedInVaultBrokerConfigurator } from '@pkg/main/configureSignedInVaultBroker';
import { VAULT_HTTPS_ORIGIN, VaultTlsPinService } from '@pkg/main/vaultTls';
import { VaultBrokerServiceProvider, type BrokerExecuteRequest } from '@pkg/vault-broker';
import { DesktopVaultTransport } from '@pkg/vault-broker/desktopTransport';

vi.mock('electron', () => {
  const app = { on: vi.fn(), isPackaged: false, getPath: vi.fn(() => '/tmp') };
  const safeStorage = { isEncryptionAvailable: vi.fn(() => true), decryptString: vi.fn(), encryptString: vi.fn() };
  const session = { fromPartition: vi.fn() };

  return { default: { app, safeStorage, session }, app, safeStorage, session };
});
vi.mock('@pkg/agent/services/VaultKeyService', () => ({ getVaultKeyService: vi.fn() }));
vi.mock('@pkg/main/firstRun/firstRunState', () => ({ getFirstRunState: vi.fn() }));

const request: BrokerExecuteRequest = {
  claims: { sub: 'fixture-principal', agent_id: 'fixture-agent', pod_id: 'fixture-pod' },
  operation: 'item.http',
  ref: {},
  url: 'https://provider.example/resource',
  method: 'GET',
  injections: [],
};

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

  getPeerCertificate(): { raw: Buffer } { return { raw: this.certificate } }
}

describe('signed-in vault broker Node transports', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('uses separate pinned Node Agents for configured ordinary and stream requests', async() => {
    // risk: availability — 300 streams and short credential/control calls must not queue behind one six-socket pool.
    vi.stubEnv('SULLA_VAULT_CONTROL_TRANSPORT', 'node-pinned');
    vi.stubEnv('SULLA_VAULT_STREAM_TRANSPORT', 'node-pinned');
    const agentOptions: Array<{ connections?: number | null; connect?: unknown }> = [];
    const agents: Agent[] = [];
    const dispatcherFactory = vi.fn((options: { connections?: number | null; connect?: unknown }) => {
      agentOptions.push(options);
      const agent = { close: vi.fn() } as unknown as Agent;
      agents.push(agent);
      return agent;
    });
    const dispatchedRequests: Array<{ input: string; init?: RequestInit & { dispatcher?: unknown } }> = [];
    const nodeFetch = vi.fn(async(input: string, init?: RequestInit & { dispatcher?: unknown }) => {
      dispatchedRequests.push({ input, init });
      if (input.endsWith('/v1/broker/execute')) {
        return Response.json({ status: 200, headers: {}, body: { ok: true } });
      }
      return new Response('provider stream');
    });
    const electronFetch = vi.fn(async(input: string) => input.endsWith('/v1/broker/execute')
      ? Response.json({ status: 200, headers: {}, body: { ok: true } })
      : new Response('provider stream'));
    const sessionFactory = vi.fn(() => ({ fetch: electronFetch }) as never);
    const transport = new DesktopVaultTransport(
      {} as never,
      sessionFactory,
      async() => {},
      nodeFetch as never,
      dispatcherFactory as never,
    );
    const provider = new VaultBrokerServiceProvider({}, () => false);
    new SignedInVaultBrokerConfigurator({
      provider,
      identity: async() => ({ serviceId: 'sulla-tools', serviceToken: 'fixture-token' }),
      transport: transport.fetch,
      streamTransport: transport.fetchStream,
      endpoint: VAULT_HTTPS_ORIGIN,
      restoreVaultSession: async() => true,
    }).configure();
    const broker = provider.requireConfiguredCredentialBroker();

    expect(await broker.execute(request)).toEqual({ status: 200, headers: {}, body: { ok: true } });
    expect(await (await broker.executeStream(request)).text()).toBe('provider stream');

    expect(nodeFetch).toHaveBeenCalledTimes(2);
    expect(dispatchedRequests.map(({ init }) => init?.headers)).toEqual([
      { authorization: 'Bearer fixture-token', 'x-sulla-service-id': 'sulla-tools', 'content-type': 'application/json' },
      { authorization: 'Bearer fixture-token', 'x-sulla-service-id': 'sulla-tools', 'content-type': 'application/json' },
    ]);
    expect(agentOptions.map(({ connections }) => connections)).toEqual([128, 512]);
    expect(agents[0]).not.toBe(agents[1]);
    expect(dispatchedRequests[0]?.init?.dispatcher).toBe(agents[0]);
    expect(dispatchedRequests[1]?.init?.dispatcher).toBe(agents[1]);
    expect(sessionFactory).not.toHaveBeenCalled();
    expect(electronFetch).not.toHaveBeenCalled();
  });

  it('rejects a wrong certificate pin on the ordinary Node transport', async() => {
    // risk: authentication — a local process with a different certificate must not impersonate the vault.
    vi.stubEnv('SULLA_VAULT_CONTROL_TRANSPORT', 'node-pinned');
    const agentOptions: Array<{ connect?: unknown }> = [];
    const dispatcherFactory = vi.fn((options: { connect?: unknown }) => {
      agentOptions.push(options);
      return { close: vi.fn() } as never;
    });
    const nodeFetch = vi.fn(async() => new Response('{}'));
    const socket = new SyntheticTlsSocket(new X509Certificate(PIN_TEST_CERTIFICATE).raw);
    const tlsConnect = vi.fn(() => {
      queueMicrotask(() => socket.emit('secureConnect'));
      return socket as never;
    });
    const certificateFingerprint = new X509Certificate(PIN_TEST_CERTIFICATE).fingerprint256.replaceAll(':', '').toLowerCase();
    const mismatchedPin = `${certificateFingerprint[0] === '0' ? '1' : '0'}${certificateFingerprint.slice(1)}`;
    const pinService = new VaultTlsPinService(async() => mismatchedPin);
    const peerVerifier = vi.fn((hostname: string, pem: string) => pinService.verifyPeer(hostname, pem));
    const transport = new DesktopVaultTransport(
      {} as never,
      () => ({ fetch: vi.fn() }) as never,
      async() => {},
      nodeFetch as never,
      dispatcherFactory as never,
      tlsConnect as never,
      peerVerifier,
    );

    await transport.fetch(`${VAULT_HTTPS_ORIGIN}/v1/broker/items`);
    const connector = agentOptions[0]?.connect as (
      options: { hostname: string; port: string; servername?: string },
      callback: (error: Error | null, socket: unknown) => void,
    ) => void;
    const connectionError = await new Promise<Error | null>((resolve) => {
      connector({ hostname: '127.0.0.1', port: '30135' }, (error) => resolve(error));
    });

    expect(connectionError?.message).toBe('Vault TLS certificate pin verification failed');
    expect(peerVerifier).toHaveBeenCalledTimes(1);
    expect(socket.destroy).toHaveBeenCalledTimes(1);
  });
});
