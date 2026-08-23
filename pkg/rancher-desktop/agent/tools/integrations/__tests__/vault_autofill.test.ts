/**
 * @jest-environment node
 */
import vm from 'node:vm';

import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockGetIntegrationValue = jest.fn();
const mockResolveBridge = jest.fn<(assetId?: string) => Promise<unknown>>();

const mockService = {
  initialize:          jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  getAccounts:         jest.fn<() => Promise<unknown[]>>().mockResolvedValue([]),
  getIntegrationValue: mockGetIntegrationValue,
};

jest.unstable_mockModule('../../../services/IntegrationService', () => ({
  getIntegrationService: () => mockService,
}));

jest.unstable_mockModule('../../browser/resolve_bridge', () => ({
  resolveBridge:    mockResolveBridge,
  isBridgeResolved: (result: any) => Boolean(result?.bridge),
}));

async function loadModule() {
  return import('../vault_autofill');
}

function makeBridge(assetId: string, fillResult: Record<string, unknown>) {
  return {
    assetId,
    getPageUrl:       jest.fn<() => Promise<string>>().mockResolvedValue('https://github.com/login'),
    execInPageStrict: jest.fn<() => Promise<unknown>>().mockResolvedValue(fillResult),
  };
}

async function call(input: Record<string, unknown>) {
  const { VaultAutofillWorker } = await loadModule();
  const worker = new VaultAutofillWorker();

  return (worker as any)._validatedCall(input);
}

beforeEach(() => {
  mockResolveBridge.mockReset();
  mockGetIntegrationValue.mockReset();
  mockGetIntegrationValue.mockImplementation((_accountType, property) => Promise.resolve({
    value: {
      website_url: 'https://github.com/login',
      llm_access:   'autofill',
      username:     'saved-user',
      password:     'saved-password',
    }[property as string],
  }));
});

describe('VaultAutofillWorker', () => {
  it('targets the active tab when assetId is omitted and requires verified fields', async() => {
    const bridge = makeBridge('active-tab', {
      success: true, runtimeReady: true, usernameOk: true, passwordOk: true,
    });
    mockResolveBridge.mockResolvedValue({ bridge, assetId: 'active-tab' });

    const result = await call({ account_id: 'credential-1' });

    expect(mockResolveBridge).toHaveBeenCalledWith(undefined);
    expect(bridge.execInPageStrict).toHaveBeenCalledTimes(1);
    expect(result.successBoolean).toBe(true);
    expect(result.responseString).toContain('[active-tab]');
    expect(result.responseString).toContain('verified non-empty credential fields');
    expect(result.responseString).not.toContain('saved-password');
  });

  it('targets an explicitly requested background tab', async() => {
    const bridge = makeBridge('background-tab', {
      success: true, runtimeReady: true, usernameOk: true, passwordOk: true,
    });
    mockResolveBridge.mockResolvedValue({ bridge, assetId: 'background-tab' });

    const result = await call({ account_id: 'credential-1', assetId: 'background-tab' });

    expect(mockResolveBridge).toHaveBeenCalledWith('background-tab');
    expect(result.successBoolean).toBe(true);
    expect(result.responseString).toContain('[background-tab]');
  });

  it('returns a truthful target-specific failure when the browser runtime is not loaded', async() => {
    const bridge = makeBridge('partial-runtime-tab', {
      success:      false,
      runtimeReady: false,
      usernameOk:   false,
      passwordOk:   false,
      error:        'Browser runtime is not loaded',
    });
    mockResolveBridge.mockResolvedValue({ bridge, assetId: 'partial-runtime-tab' });

    const result = await call({ account_id: 'credential-1', assetId: 'partial-runtime-tab' });

    expect(result.successBoolean).toBe(false);
    expect(result.responseString).toContain('[partial-runtime-tab]');
    expect(result.responseString).toContain('Browser runtime is not loaded');
    expect(result.responseString).not.toContain('was filled');
  });

  it('fails when setValue does not leave every expected field non-empty', async() => {
    const bridge = makeBridge('active-tab', {
      success:      false,
      runtimeReady: true,
      usernameOk:   true,
      passwordOk:   false,
      error:        'The page did not retain non-empty password field values',
    });
    mockResolveBridge.mockResolvedValue({ bridge, assetId: 'active-tab' });

    const result = await call({ account_id: 'credential-1' });

    expect(result.successBoolean).toBe(false);
    expect(result.responseString).toContain('did not retain non-empty password');
    expect(result.responseString).not.toContain('was filled');
  });

  it('refuses to fill a target tab on a different origin', async() => {
    const bridge = makeBridge('wrong-origin-tab', {
      success: true, runtimeReady: true, usernameOk: true, passwordOk: true,
    });
    bridge.getPageUrl.mockResolvedValue('https://example.com/login');
    mockResolveBridge.mockResolvedValue({ bridge, assetId: 'wrong-origin-tab' });

    const result = await call({ account_id: 'credential-1', assetId: 'wrong-origin-tab' });

    expect(result.successBoolean).toBe(false);
    expect(result.responseString).toContain('[wrong-origin-tab]');
    expect(result.responseString).toContain('does not match credential origin');
    expect(bridge.execInPageStrict).not.toHaveBeenCalled();
  });
});

describe('buildAutofillScript', () => {
  it('fills and proves both expected fields without returning their values', async() => {
    const { buildAutofillScript } = await loadModule();
    const usernameField = { value: '' };
    const passwordField = { value: '', closest: () => null, parentElement: null };
    const form = {
      hasLoginForm:   true,
      usernameField,
      passwordField,
      usernameHandle: '@vault-username',
      passwordHandle: '@vault-password',
    };
    const window = {
      sullaBridge: {
        detectLoginForm: () => form,
        setValue:        (handle: string, value: string) => {
          if (handle === '@vault-username') usernameField.value = value;
          if (handle === '@vault-password') passwordField.value = value;
          return true;
        },
      },
    };

    const result = await vm.runInNewContext(
      buildAutofillScript('saved-user', 'saved-password'),
      { window, document: { body: {} }, setTimeout: jest.fn(), Promise, Boolean, String },
    );

    expect(result).toEqual({
      success: true, runtimeReady: true, usernameOk: true, passwordOk: true,
    });
    expect(usernameField.value).toBe('saved-user');
    expect(passwordField.value).toBe('saved-password');
    expect(JSON.stringify(result)).not.toContain('saved-password');
  });

  it('reports an uninitialized page runtime without touching credentials', async() => {
    const { buildAutofillScript } = await loadModule();
    const result = await vm.runInNewContext(
      buildAutofillScript('saved-user', 'saved-password'),
      { window: {}, document: { body: {} }, setTimeout: jest.fn(), Promise, Boolean, String },
    );

    expect(result).toEqual(expect.objectContaining({
      success: false, runtimeReady: false, error: 'Browser runtime is not loaded',
    }));
    expect(JSON.stringify(result)).not.toContain('saved-password');
  });
});
