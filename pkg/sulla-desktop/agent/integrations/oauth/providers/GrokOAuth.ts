// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// xAI Grok OAuth uses the public CLI client with a loopback PKCE callback.
// Google sign-in requires a system browser. The subscription proxy consumes
// the tokens through the vault, and the provider hook invalidates cached services.

import { OAuthProvider, type OAuthProviderConfig, type OAuthTokenSet } from '../OAuthProvider';
import { registerOAuthProvider } from '../registry';

class GrokOAuthProvider extends OAuthProvider {
  readonly config: OAuthProviderConfig = {
    id:                   'grok',
    name:                 'Grok',
    authorizeUrl:         'https://auth.x.ai/oauth2/authorize',
    tokenUrl:             'https://auth.x.ai/oauth2/token',
    revokeUrl:            'https://auth.x.ai/oauth2/revoke',
    scopes:               ['openid', 'profile', 'email', 'offline_access', 'grok-cli:access', 'api:access'],
    scopeSeparator:       ' ',
    clientAuthMethod:     'none',
    usePKCE:              true,
    builtInClientId:      'b1a00492-073a-47ea-816f-4c329264a828',
    fixedCallbackPort:    56121,
    fixedCallbackPath:    '/callback',
    useLocalhostHostname: false,
    openInEmbeddedWindow: false,
    extraAuthorizeParams: { referrer: 'grok-build' },
    refreshBufferSeconds: 300,
  };

  override async onTokenReceived(_tokens: OAuthTokenSet): Promise<void> {
    // Bust the LLM cache so the next agent call re-reads credentials and
    // picks up the fresh access token instead of a cached expired one.
    try {
      const { LLMRegistry } = await import('../../../languagemodels/index');
      LLMRegistry.invalidate('grok');
      const { resetGrokService } = await import('../../../languagemodels/GrokService');
      resetGrokService();
    } catch { /* non-critical */ }
  }

  override async onTokensRevoked(): Promise<void> {
    // Same cache bust on disconnect — a cached GrokService would otherwise
    // keep using the revoked token until the process restarts.
    try {
      const { LLMRegistry } = await import('../../../languagemodels/index');
      LLMRegistry.invalidate('grok');
      const { resetGrokService } = await import('../../../languagemodels/GrokService');
      resetGrokService();
    } catch { /* non-critical */ }
  }
}

const instance = new GrokOAuthProvider();
registerOAuthProvider(instance);

export default instance;
