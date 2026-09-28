// Cloudflare OAuth 2.0 provider — PKCE public client flow.
//
// Uses Cloudflare's public Wrangler CLI OAuth app (the same one `wrangler
// login` uses) so the user signs in with their Cloudflare account instead of
// hand-minting an API token. The access token is a standard Bearer credential
// against https://api.cloudflare.com/client/v4; the `cloudflare` proxy picks
// it up from the oauth_tokens table when no pasted token is stored.
//
// Caveats (verified against wrangler 4.97 source, 2026-09):
// - redirect_uri is registered as http://localhost:8976/oauth/callback, so the
//   callback port/path are fixed. A concurrent `wrangler login` on the same
//   Mac would hold the port.
// - Scopes are a subset of Wrangler's defaults. None of them grant Cloudflare
//   Tunnel or DNS-record edit, so named-tunnel provisioning still needs a
//   separately scoped credential.
// - Access tokens are short-lived; offline_access returns a refresh token and
//   OAuthService refreshes ahead of expiry.

import { OAuthProvider, type OAuthProviderConfig, type OAuthProviderHookContext, type OAuthTokenSet } from '../OAuthProvider';
import { registerOAuthProvider } from '../registry';

const API_BASE = 'https://api.cloudflare.com/client/v4';

export const CLOUDFLARE_OAUTH_SCOPES = [
  'account:read',
  'user:read',
  'workers:write',
  'workers_kv:write',
  'workers_routes:write',
  'workers_scripts:write',
  'workers_tail:read',
  'd1:write',
  'pages:write',
  'zone:read',
  'ssl_certs:write',
  'ai:write',
  'queues:write',
  'secrets_store:write',
  'connectivity:admin',
  'offline_access',
];

class CloudflareOAuthProvider extends OAuthProvider {
  readonly config: OAuthProviderConfig = {
    id:                   'cloudflare',
    name:                 'Cloudflare',
    authorizeUrl:         'https://dash.cloudflare.com/oauth2/auth',
    tokenUrl:             'https://dash.cloudflare.com/oauth2/token',
    revokeUrl:            'https://dash.cloudflare.com/oauth2/revoke',
    scopes:               CLOUDFLARE_OAUTH_SCOPES,
    scopeSeparator:       ' ',
    clientAuthMethod:     'none',
    usePKCE:              true,
    builtInClientId:      '54d11594-84e4-41aa-b438-e81b8fa78ee7',
    fixedCallbackPort:    8976,
    fixedCallbackPath:    '/oauth/callback',
    openInEmbeddedWindow: true,
    refreshBufferSeconds: 300,
  };

  /**
   * On first sign-in, record the Cloudflare account ID in the vault so callers
   * can build `/accounts/{account_id}/…` paths without asking the user. Never
   * overwrites an account ID the user already set. Also fires on refresh, where
   * it's a cheap no-op once the value exists.
   */
  override async onTokenReceived(tokens: OAuthTokenSet, context?: OAuthProviderHookContext): Promise<void> {
    try {
      const { getIntegrationService } = await import('../../../services/IntegrationService');
      const svc = getIntegrationService();
      const existing = await svc.getIntegrationValue('cloudflare', 'account_id', context?.accountId);
      if (existing?.value) return;

      const accountId = await fetchPrimaryAccountId(tokens.access_token);
      if (!accountId) return;
      await svc.setIntegrationValue({
        integration_id: 'cloudflare',
        account_id:     context?.accountId,
        property:       'account_id',
        value:          accountId,
      });
      console.log('[CloudflareOAuth] Stored Cloudflare account ID');
    } catch (err) {
      console.warn('[CloudflareOAuth] Could not record account ID:', err instanceof Error ? err.message : err);
    }
  }
}

/** First account the token can see, or null (the user may belong to several). */
export async function fetchPrimaryAccountId(accessToken: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const res = await fetchImpl(`${ API_BASE }/accounts?per_page=50`, {
    headers: { Authorization: `Bearer ${ accessToken }`, Accept: 'application/json' },
  });
  if (!res.ok) return null;
  const body = await res.json() as { result?: { id?: string }[] };
  const id = body.result?.[0]?.id;

  return typeof id === 'string' && /^[0-9a-f]{32}$/i.test(id) ? id : null;
}

const instance = new CloudflareOAuthProvider();
registerOAuthProvider(instance);

export default instance;
