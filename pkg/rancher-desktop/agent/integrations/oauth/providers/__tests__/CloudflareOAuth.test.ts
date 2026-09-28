/** @jest-environment node */
import { jest } from '@jest/globals';

import mockModules from '@pkg/utils/testUtils/mockModules';

const getIntegrationValue = jest.fn<(...args: any[]) => Promise<any>>();
const setIntegrationValue = jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue({});
mockModules({
  '@pkg/agent/services/IntegrationService': { getIntegrationService: () => ({ getIntegrationValue, setIntegrationValue }) },
});

const { default: provider, fetchPrimaryAccountId, CLOUDFLARE_OAUTH_SCOPES } = await import('@pkg/agent/integrations/oauth/providers/CloudflareOAuth');
const { getOAuthProvider } = await import('@pkg/agent/integrations/oauth/registry');

const ACCOUNT = '44b9670fe26b5a11b117315215b8fed6';
const originalFetch = global.fetch;

function respond(status: number, body: unknown) {
  return jest.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(body), { status }));
}

afterEach(() => {
  global.fetch = originalFetch;
  jest.clearAllMocks();
});

test('registers a PKCE public client on Wrangler\'s fixed loopback callback', () => {
  expect(getOAuthProvider('cloudflare')).toBe(provider);
  expect(provider.config).toMatchObject({
    authorizeUrl:      'https://dash.cloudflare.com/oauth2/auth',
    tokenUrl:          'https://dash.cloudflare.com/oauth2/token',
    clientAuthMethod:  'none',
    usePKCE:           true,
    fixedCallbackPort: 8976,
    fixedCallbackPath: '/oauth/callback',
  });
  expect(provider.config.useLocalhostHostname).not.toBe(false); // redirect is registered on "localhost"
  expect(CLOUDFLARE_OAUTH_SCOPES).toEqual(expect.arrayContaining(['account:read', 'offline_access']));
});

test('fetchPrimaryAccountId reads the first account and rejects junk', async() => {
  const ok = respond(200, { result: [{ id: ACCOUNT }, { id: 'ffffffffffffffffffffffffffffffff' }] });
  await expect(fetchPrimaryAccountId('tok', ok)).resolves.toBe(ACCOUNT);
  expect(ok.mock.calls[0][1]).toMatchObject({ headers: { Authorization: 'Bearer tok' } });
  await expect(fetchPrimaryAccountId('tok', respond(403, {}))).resolves.toBeNull();
  await expect(fetchPrimaryAccountId('tok', respond(200, { result: [{ id: '../evil' }] }))).resolves.toBeNull();
});

test('first sign-in stores the account ID against the signed-in vault account', async() => {
  getIntegrationValue.mockResolvedValue(null);
  global.fetch = respond(200, { result: [{ id: ACCOUNT }] });
  await provider.onTokenReceived({ access_token: 'tok', token_type: 'bearer' }, { integrationId: 'cloudflare', accountId: 'default', providerId: 'cloudflare' });
  expect(setIntegrationValue).toHaveBeenCalledWith({ integration_id: 'cloudflare', account_id: 'default', property: 'account_id', value: ACCOUNT });
});

test('never overwrites an account ID the user already set, and refreshes skip the API call', async() => {
  getIntegrationValue.mockResolvedValue({ value: 'aaaabbbbccccddddeeeeffff00001111' });
  global.fetch = respond(200, { result: [{ id: ACCOUNT }] });
  await provider.onTokenReceived({ access_token: 'tok', token_type: 'bearer' }, { integrationId: 'cloudflare', accountId: 'default', providerId: 'cloudflare' });
  expect(global.fetch).not.toHaveBeenCalled();
  expect(setIntegrationValue).not.toHaveBeenCalled();
});

test('a failed account lookup does not break sign-in', async() => {
  getIntegrationValue.mockResolvedValue(null);
  global.fetch = jest.fn<typeof fetch>().mockRejectedValue(new Error('offline'));
  await expect(provider.onTokenReceived({ access_token: 'tok', token_type: 'bearer' })).resolves.toBeUndefined();
  expect(setIntegrationValue).not.toHaveBeenCalled();
});
