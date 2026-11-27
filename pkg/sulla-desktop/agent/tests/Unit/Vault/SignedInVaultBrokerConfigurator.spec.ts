// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const transports = vi.hoisted(() => ({
  desktopFetch: vi.fn(),
  streamFetch: vi.fn(),
  loadIdentity: vi.fn(),
  initializeVault: vi.fn(),
  getFirstRunState: vi.fn(),
}));

vi.mock('@pkg/vault-broker/desktopTransport', () => ({
  desktopVaultFetch: transports.desktopFetch,
  desktopVaultTransport: { fetchStream: transports.streamFetch },
  loadDesktopBrokerIdentity: transports.loadIdentity,
}));
vi.mock('@pkg/agent/services/VaultKeyService', () => ({
  getVaultKeyService: () => ({ initialize: transports.initializeVault }),
}));
vi.mock('@pkg/main/firstRun/firstRunState', () => ({ getFirstRunState: transports.getFirstRunState }));
vi.mock('@pkg/main/vaultTls', () => ({ VAULT_HTTPS_ORIGIN: 'https://127.0.0.1:30135' }));

import { configureSignedInVaultBroker } from '@pkg/main/configureSignedInVaultBroker';
import { configuredVaultBrokerProvider, type BrokerExecuteRequest } from '@pkg/vault-broker';

const request: BrokerExecuteRequest = {
  claims: { sub: 'fixture-principal', agent_id: 'fixture-agent', pod_id: 'fixture-pod' },
  operation: 'item.http',
  ref: {},
  url: 'https://provider.example/resource',
  method: 'GET',
  injections: [],
};

describe('signed-in vault broker transports', () => {
  beforeEach(() => {
    configuredVaultBrokerProvider.configureCredentialBroker(null);
    vi.resetAllMocks();
    transports.loadIdentity.mockResolvedValue({ serviceId: 'sulla-tools', serviceToken: 'fixture-token' });
    transports.getFirstRunState.mockReturnValue({ onboardingComplete: true });
  });

  it('routes configured executeStream requests through fetchStream, not desktopVaultFetch', async() => {
    // risk: availability — provider streams must bypass Chromium's six-connection HTTP/1.1 pool.
    transports.desktopFetch.mockResolvedValue(new Response('control response'));
    transports.streamFetch.mockResolvedValue(new Response('provider stream'));
    configureSignedInVaultBroker();

    const response = await configuredVaultBrokerProvider.requireConfiguredCredentialBroker().executeStream(request);

    expect(await response.text()).toBe('provider stream');
    expect(transports.streamFetch).toHaveBeenCalledTimes(1);
    expect(transports.streamFetch.mock.calls[0]?.[0]).toBe('https://127.0.0.1:30135/v1/broker/execute-stream');
    expect(transports.desktopFetch).not.toHaveBeenCalled();
  });

  it('shares one restore for concurrent stream and ordinary 423s, then retries each transport', async() => {
    // risk: availability — concurrent locked requests on both transports must restore once and recover without queuing.
    const ordinaryResponses = [
      new Response('locked', { status: 423 }),
      Response.json({ status: 200, headers: {}, body: { ok: true } }),
    ];
    const streamResponses = [new Response('locked', { status: 423 }), new Response('stream body')];
    transports.desktopFetch.mockImplementation(async() => ordinaryResponses.shift()!);
    transports.streamFetch.mockImplementation(async() => streamResponses.shift()!);

    let finishRestore: (restored: boolean) => void = () => undefined;
    transports.initializeVault.mockImplementation(() => new Promise<boolean>((resolve) => { finishRestore = resolve }));
    configureSignedInVaultBroker();
    const broker = configuredVaultBrokerProvider.requireConfiguredCredentialBroker();

    const ordinaryRequest = broker.execute(request);
    const streamRequest = broker.executeStream(request);
    await vi.waitFor(() => expect(transports.initializeVault).toHaveBeenCalledTimes(1));
    finishRestore(true);

    const [ordinaryResponse, streamResponse] = await Promise.all([ordinaryRequest, streamRequest]);

    expect(ordinaryResponse).toEqual({ status: 200, headers: {}, body: { ok: true } });
    expect(await streamResponse.text()).toBe('stream body');
    expect(transports.initializeVault).toHaveBeenCalledTimes(1);
    expect(transports.desktopFetch).toHaveBeenCalledTimes(2);
    expect(transports.streamFetch).toHaveBeenCalledTimes(2);
  });
});
