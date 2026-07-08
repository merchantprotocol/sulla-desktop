// xAI Grok OAuth 2.0 provider — PKCE public client flow.
//
// Uses the public Grok CLI OAuth app on auth.x.ai so Sulla runs Grok models
// on the user's SuperGrok / X Premium+ subscription instead of a metered
// xAI API key. The access token is a standard Bearer credential against
// https://api.x.ai/v1; GrokService picks it up straight from the oauth_tokens
// table (no auth file materialized — the consumer is in-process HTTP, not an
// in-VM CLI). onTokenReceived also fires on every scheduled refresh, which
// keeps the cached GrokService instance from holding an expired token.
//
// Caveats (verified against live auth.x.ai OIDC discovery + the open-source
// grok-cli/opencode/pi client implementations, 2026-07):
// - redirect_uri is registered as the literal loopback IP on a fixed port:
//   http://127.0.0.1:56121/callback — hence useLocalhostHostname: false.
// - referrer=hermes-agent is required on the authorize URL for this client.
// - xAI enforces a server-side subscription allowlist: some subscribers get
//   HTTP 403 on the OAuth API surface even after a successful sign-in.

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
    openInEmbeddedWindow: true,
    extraAuthorizeParams: { referrer: 'hermes-agent' },
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
