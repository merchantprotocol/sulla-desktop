// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const getPendingCredentialMock: any = jest.fn();
const ensureCodexAuthFileMock: any = jest.fn();
const createGuestCodexBrokerLeaseMock: any = jest.fn();
const createCodexPendingMemoryBridgeMock: any = jest.fn();
let containerAuthority = false;

jest.unstable_mockModule('../../../main/firstRun/pendingCredentials', () => ({
  getPendingCredential: getPendingCredentialMock,
}));

jest.unstable_mockModule('../../../vault-broker', () => ({
  usesContainerVaultAuthority: () => containerAuthority,
}));

jest.unstable_mockModule('../util/codexAuthFile', () => ({
  ensureCodexAuthFile:    ensureCodexAuthFileMock,
  extractChatgptAccountId: (idToken: string | undefined) => {
    if (!idToken) return null;
    try { return JSON.parse(idToken).chatgpt_account_id ?? null } catch { return null }
  },
}));

jest.unstable_mockModule('../codexGuestBrokerLease', () => ({
  createGuestCodexBrokerLease: createGuestCodexBrokerLeaseMock,
}));

jest.unstable_mockModule('../codexPendingMemoryBridge', () => ({
  createCodexPendingMemoryBridge: createCodexPendingMemoryBridgeMock,
}));

function fakeLease(config: { environment?: Record<string, string>; codexConfigOverrides?: string[] } = {}) {
  return {
    config:  { opaqueConfigRef: 'ref', baseUrl: 'http://127.0.0.1:1/v1', environment: config.environment ?? {}, codexConfigOverrides: config.codexConfigOverrides ?? [] },
    signal:  new AbortController().signal,
    revoke:  jest.fn(),
    close:   jest.fn(() => Promise.resolve()),
  };
}

describe('resolveCodexExecutionAuth', () => {
  beforeEach(() => {
    containerAuthority = false;
    getPendingCredentialMock.mockReset().mockReturnValue(undefined);
    ensureCodexAuthFileMock.mockReset();
    createGuestCodexBrokerLeaseMock.mockReset();
    createCodexPendingMemoryBridgeMock.mockReset();
  });

  afterEach(() => jest.resetModules());

  it('picks GuestAuthFile when there is no pending sign-in and the vault authority is off', async() => {
    ensureCodexAuthFileMock.mockResolvedValue(true);
    const { resolveCodexExecutionAuth } = await import('../codexExecutionAuth');

    const auth = await resolveCodexExecutionAuth({ conversationId: 'c1' });

    expect(auth.kind).toBe('guest-auth-file');
    expect(auth.environment).toEqual({});
    expect(auth.codexConfigOverrides).toEqual([]);
    expect(createGuestCodexBrokerLeaseMock).not.toHaveBeenCalled();
    expect(createCodexPendingMemoryBridgeMock).not.toHaveBeenCalled();
  });

  it('throws a typed AuthExpired instead of spawning when GuestAuthFile has no usable credential', async() => {
    ensureCodexAuthFileMock.mockResolvedValue(false);
    const { resolveCodexExecutionAuth } = await import('../codexExecutionAuth');
    const { AuthExpired } = await import('../failures');

    await expect(resolveCodexExecutionAuth({ conversationId: 'c1' })).rejects.toBeInstanceOf(AuthExpired);
  });

  it('picks ContainerBrokerLease when the vault authority owns the token', async() => {
    containerAuthority = true;
    const lease = fakeLease({ environment: { SULLA_PROVIDER_BRIDGE_TOKEN: 'cap' }, codexConfigOverrides: ['model_provider="sulla"'] });
    createGuestCodexBrokerLeaseMock.mockResolvedValue(lease);
    const { resolveCodexExecutionAuth } = await import('../codexExecutionAuth');

    const auth = await resolveCodexExecutionAuth({ conversationId: 'c1' });

    expect(auth.kind).toBe('container-broker-lease');
    expect(auth.environment).toEqual({ SULLA_PROVIDER_BRIDGE_TOKEN: 'cap' });
    auth.dispose();
    expect(lease.revoke).toHaveBeenCalled();
  });

  it('throws a typed RoutingUnavailable when the vault account is missing its ChatGPT routing claim', async() => {
    containerAuthority = true;
    createGuestCodexBrokerLeaseMock.mockRejectedValue(new Error('Codex account is missing its ChatGPT account routing claim'));
    const { resolveCodexExecutionAuth } = await import('../codexExecutionAuth');
    const { RoutingUnavailable } = await import('../failures');

    await expect(resolveCodexExecutionAuth({ conversationId: 'c1' })).rejects.toBeInstanceOf(RoutingUnavailable);
  });

  it('picks PendingMemoryBridge during first run without ever calling ensureCodexAuthFile', async() => {
    getPendingCredentialMock.mockReturnValue({
      integrationId: 'codex',
      accountId:     'oauth',
      values:        { access_token: 'tok', id_token: JSON.stringify({ chatgpt_account_id: 'acct-1' }) },
    });
    const lease = fakeLease({ environment: { SULLA_PROVIDER_BRIDGE_TOKEN: 'first-run-cap' } });
    createCodexPendingMemoryBridgeMock.mockResolvedValue(lease);
    const { resolveCodexExecutionAuth } = await import('../codexExecutionAuth');

    const auth = await resolveCodexExecutionAuth({ conversationId: 'c1' });

    expect(auth.kind).toBe('pending-memory-bridge');
    expect(createCodexPendingMemoryBridgeMock).toHaveBeenCalledWith({ accessToken: 'tok', chatgptAccountId: 'acct-1' }, { conversationId: 'c1' });
    expect(ensureCodexAuthFileMock).not.toHaveBeenCalled();
  });

  it('throws a typed RoutingUnavailable when the first-run sign-in has no ChatGPT account claim', async() => {
    getPendingCredentialMock.mockReturnValue({
      integrationId: 'codex',
      accountId:     'oauth',
      values:        { access_token: 'tok' },
    });
    const { resolveCodexExecutionAuth } = await import('../codexExecutionAuth');
    const { RoutingUnavailable } = await import('../failures');

    await expect(resolveCodexExecutionAuth({ conversationId: 'c1' })).rejects.toBeInstanceOf(RoutingUnavailable);
    expect(createCodexPendingMemoryBridgeMock).not.toHaveBeenCalled();
  });
});
