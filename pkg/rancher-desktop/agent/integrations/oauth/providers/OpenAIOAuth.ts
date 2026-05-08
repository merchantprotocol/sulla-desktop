// OpenAI Codex OAuth 2.0 provider — PKCE public client flow.
// Uses the official Codex CLI OAuth app (no client_secret needed).
// Grants unlimited API access via ChatGPT Plus/Pro subscription.

import { OAuthProvider, type OAuthProviderConfig, type OAuthTokenSet } from '../OAuthProvider';
import { registerOAuthProvider } from '../registry';

class OpenAIOAuthProvider extends OAuthProvider {
  readonly config: OAuthProviderConfig = {
    id:                   'openai',
    name:                 'OpenAI',
    authorizeUrl:         'https://auth.openai.com/oauth/authorize',
    tokenUrl:             'https://auth.openai.com/oauth/token',
    scopes:               ['openid', 'profile', 'email', 'offline_access'],
    scopeSeparator:       ' ',
    clientAuthMethod:     'none',
    usePKCE:              true,
    builtInClientId:      'app_EMoamEEZ73f0CkXaXp7hrann',
    fixedCallbackPort:    1455,
    fixedCallbackPath:    '/auth/callback',
    extraAuthorizeParams: {
      id_token_add_organizations:  'true',
      originator:                  'pi',
    },
    refreshBufferSeconds: 300,
  };

  override async onTokenReceived(tokens: OAuthTokenSet): Promise<void> {
    const idToken = tokens.id_token as string | undefined;
    if (!idToken) {
      console.warn('[OpenAIOAuth] No id_token in response — skipping API key exchange');
      return;
    }

    try {
      const body = new URLSearchParams({
        grant_type:         'urn:ietf:params:oauth:grant-type:token-exchange',
        client_id:          'app_EMoamEEZ73f0CkXaXp7hrann',
        requested_token:    'openai-api-key',
        subject_token:      idToken,
        subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
      });

      const res = await fetch('https://auth.openai.com/oauth/token', {
        method:  'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body:    body.toString(),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        console.error('[OpenAIOAuth] API key exchange failed:', res.status, text);
        return;
      }

      const data = await res.json() as Record<string, unknown>;
      const apiKey = (data.access_token as string) || '';
      if (!apiKey) {
        console.warn('[OpenAIOAuth] No access_token in key exchange response');
        return;
      }

      // Store API key in vault so OpenAIService.create() picks it up
      const { getIntegrationService } = await import('../../../services/IntegrationService');
      await getIntegrationService().setIntegrationValue({
        integration_id: 'openai',
        property:       'api_key',
        value:          apiKey,
      });

      // Bust the LLM cache so the next agent call re-reads the new key
      try {
        const { LLMRegistry } = await import('../../../languagemodels/index');
        LLMRegistry.invalidate('openai');
        const { resetOpenAIService } = await import('../../../languagemodels/OpenAIService');
        resetOpenAIService();
      } catch { /* non-critical */ }

      console.log('[OpenAIOAuth] OpenAI API key stored successfully');
    } catch (err) {
      console.error('[OpenAIOAuth] Failed to exchange id_token for API key:', err);
    }
  }
}

const instance = new OpenAIOAuthProvider();
registerOAuthProvider(instance);

export default instance;
