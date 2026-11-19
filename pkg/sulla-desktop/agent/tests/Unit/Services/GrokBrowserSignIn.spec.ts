// SPDX-License-Identifier: GPL-2.0-or-later
import { expect, it, vi } from 'vitest';

import provider from '../../../integrations/oauth/providers/GrokOAuth';
import { OAuthFlowSession } from '../../../services/oauth/flow/OAuthFlowSession';

const { openExternal, shutdown } = vi.hoisted(() => ({ openExternal: vi.fn(), shutdown: vi.fn() }));

vi.mock('electron', () => ({ shell: { openExternal }, BrowserWindow: vi.fn() }));
vi.mock('@pkg/main/containedAuthWindow', () => ({
  createContainedAuthWindow: () => { throw new Error('Google sign-in cannot use an embedded window') },
}));
vi.mock('@pkg/main/firstRun/firstRunTrace', () => ({ firstRunTrace: vi.fn() }));
vi.mock('../../../services/OAuthCallbackServer', () => ({
  OAuthCallbackPortInUseError: class extends Error {},
  startOAuthCallbackServer:    vi.fn().mockResolvedValue({
    redirectUri: 'http://127.0.0.1:56121/callback',
    codePromise: Promise.resolve({ code: 'fixture' }),
    shutdown,
  }),
}));

it('opens Grok authorization in the system browser and completes the PKCE callback', async() => {
  const session = new OAuthFlowSession({
    requesterId:       'oauth',
    integrationId:     'grok',
    providerId:        'grok',
    config:            provider.config,
    buildAuthorizeUrl: ({ redirectUri, state, codeChallenge }) =>
      provider.buildAuthorizeUrl(provider.config.builtInClientId!, redirectUri, state, [], codeChallenge),
  });
  const result = await session.authorize();

  expect(result).toMatchObject({ ok: true, code: 'fixture', redirectUri: 'http://127.0.0.1:56121/callback' });
  expect(openExternal).toHaveBeenCalledOnce();
  const url = new URL(openExternal.mock.calls[0][0]);
  expect(url.origin).toBe('https://auth.x.ai');
  expect(url.searchParams.get('referrer')).toBe('grok-build');
  expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  expect(url.searchParams.get('code_challenge')).toBeTruthy();
  expect(shutdown).toHaveBeenCalledOnce();
});
