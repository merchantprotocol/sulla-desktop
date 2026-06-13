// OpenAI Codex OAuth 2.0 provider — PKCE public client flow.
//
// Same official Codex CLI OAuth app as OpenAIOAuth, but with a different
// purpose: instead of exchanging the id_token for a metered platform API key,
// the full token set is written to ~/.codex/auth.json so the `codex` CLI in
// the Lima VM runs against the user's ChatGPT Plus/Pro subscription — no API
// billing. onTokenReceived also fires on every scheduled refresh, which keeps
// the auth file current from the host side.

import { OAuthProvider, type OAuthProviderConfig, type OAuthTokenSet } from '../OAuthProvider';
import { registerOAuthProvider } from '../registry';
import { writeCodexAuthFile } from '../../../util/codexAuthFile';

class CodexOAuthProvider extends OAuthProvider {
  readonly config: OAuthProviderConfig = {
    id:                   'codex',
    name:                 'OpenAI Codex',
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
      id_token_add_organizations: 'true',
      originator:                 'codex_cli_rs',
    },
    refreshBufferSeconds: 300,
  };

  override async onTokenReceived(tokens: OAuthTokenSet): Promise<void> {
    if (writeCodexAuthFile(tokens)) {
      console.log('[CodexOAuth] ~/.codex/auth.json updated');
    }

    // Bust the LLM cache so the next agent call sees the new credentials
    try {
      const { LLMRegistry } = await import('../../../languagemodels/index');
      LLMRegistry.invalidate('codex');
      const { resetCodexService } = await import('../../../languagemodels/CodexService');
      resetCodexService();
    } catch { /* non-critical */ }
  }
}

const instance = new CodexOAuthProvider();
registerOAuthProvider(instance);

export default instance;
