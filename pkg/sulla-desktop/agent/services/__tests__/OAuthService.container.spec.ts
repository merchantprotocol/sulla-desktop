// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const brokerExecute = jest.fn<any>();
const prepareCodexAuthAfterExchange = jest.fn<any>();
const setConnectionStatus = jest.fn<any>();
const onTokenReceived = jest.fn<any>();
const shutdown = jest.fn<any>();

jest.unstable_mockModule('electron', () => ({
  BrowserWindow: class {},
  shell:          { openExternal: jest.fn(() => Promise.resolve()) },
}));

jest.unstable_mockModule('../IntegrationService', () => ({
  getIntegrationService: () => ({
    getMetadataValues:   jest.fn(() => Promise.resolve([])),
    setConnectionStatus,
  }),
}));

jest.unstable_mockModule('../OAuthCallbackServer', () => ({
  startOAuthCallbackServer: jest.fn(() => Promise.resolve({
    redirectUri: 'http://127.0.0.1:1455/auth/callback',
    codePromise: Promise.resolve({ code: 'synthetic-code' }),
    shutdown,
  })),
}));

jest.unstable_mockModule('../../integrations/oauth', () => ({
  getOAuthProvider: () => ({
    config: {
      id:                  'codex',
      name:                'ChatGPT',
      authorizeUrl:        'https://auth.example/authorize',
      tokenUrl:            'https://auth.example/token',
      scopes:              ['openid'],
      clientAuthMethod:    'none',
      builtInClientId:     'public-client',
      usePKCE:             true,
      extraAuthorizeParams: {},
      extraTokenParams:     {},
    },
    buildAuthorizeUrl: jest.fn(() => 'https://auth.example/authorize'),
    onTokenReceived,
  }),
}));

jest.unstable_mockModule('../../../vault-broker', () => ({
  usesContainerVaultAuthority: () => true,
  issueLocalBrokerContext:     jest.fn(() => Promise.resolve({ synthetic: true })),
  requireConfiguredCredentialBroker: () => ({
    requestFor: (_context: unknown, request: unknown) => request,
    execute:    brokerExecute,
  }),
}));

jest.unstable_mockModule('../../database/PostgresClient', () => ({
  postgresClient: { query: jest.fn() },
}));

jest.unstable_mockModule('../../../main/containedAuthWindow', () => ({
  createContainedAuthWindow: jest.fn(),
}));

jest.unstable_mockModule('../../../main/firstRun/firstRunTrace', () => ({
  firstRunTrace: jest.fn(),
}));

jest.unstable_mockModule('../../util/codexAuthFile', () => ({
  prepareCodexAuthAfterExchange,
}));

describe('OAuthService container-vault Codex lifecycle', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    brokerExecute.mockReset();
    prepareCodexAuthAfterExchange.mockReset();
    setConnectionStatus.mockReset();
    onTokenReceived.mockReset();
    shutdown.mockReset();
    prepareCodexAuthAfterExchange.mockResolvedValue({ custody: 'vault-bridge', written: false, linked: false });
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('completes metadata-only connect and refresh without raw credential file or provider hooks', async() => {
    const exchangeMetadata = { token_type: 'Bearer', expires_at: Date.now() + 60 * 60 * 1000 };
    const refreshMetadata = { token_type: 'Bearer', expires_at: Date.now() + 2 * 60 * 60 * 1000 };
    brokerExecute
      .mockResolvedValueOnce({ status: 200, body: exchangeMetadata })
      .mockResolvedValueOnce({ status: 200, body: refreshMetadata });

    const { OAuthService } = await import('../OAuthService');
    const service = new OAuthService();

    await expect(service.startFlow('codex', 'codex', '', '', 'oauth')).resolves.toEqual(exchangeMetadata);
    expect(prepareCodexAuthAfterExchange).toHaveBeenCalledWith(exchangeMetadata, true);
    expect(onTokenReceived).not.toHaveBeenCalled();
    expect(setConnectionStatus).not.toHaveBeenCalled();

    await expect(service.refreshAccessToken('codex', 'oauth', 'codex', 'public-client', ''))
      .resolves.toEqual(refreshMetadata);

    expect(brokerExecute.mock.calls.map(([request]) => (request as { operation: string }).operation))
      .toEqual(['oauth.exchange', 'oauth.refresh']);
    expect(prepareCodexAuthAfterExchange).toHaveBeenCalledTimes(1);
    expect(onTokenReceived).not.toHaveBeenCalled();
    expect(setConnectionStatus).not.toHaveBeenCalled();
  });
});
