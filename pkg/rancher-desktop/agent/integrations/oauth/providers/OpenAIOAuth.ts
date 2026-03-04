// OpenAI Codex OAuth 2.0 provider — PKCE public client flow.
// Uses the official Codex CLI OAuth app (no client_secret needed).
// Grants unlimited API access via ChatGPT Plus/Pro subscription.

import { OAuthProvider, type OAuthProviderConfig } from '../OAuthProvider';
import { registerOAuthProvider } from '../registry';

class OpenAIOAuthProvider extends OAuthProvider {
  readonly config: OAuthProviderConfig = {
    id:               'openai',
    name:             'OpenAI',
    authorizeUrl:     'https://auth.openai.com/oauth/authorize',
    tokenUrl:         'https://auth.openai.com/oauth/token',
    scopes:           ['openid', 'profile', 'email', 'offline_access'],
    scopeSeparator:   ' ',
    clientAuthMethod: 'none',
    usePKCE:          true,
    builtInClientId:  'app_EMoamEEZ73f0CkXaXp7hrann',
    fixedCallbackPort: 1455,
    fixedCallbackPath: '/auth/callback',
    extraAuthorizeParams: {
      id_token_add_organizations:  'true',
      codex_cli_simplified_flow:   'true',
      originator:                  'codex_cli_rs',
    },
    refreshBufferSeconds: 300,
  };
}

const instance = new OpenAIOAuthProvider();
registerOAuthProvider(instance);

export default instance;
