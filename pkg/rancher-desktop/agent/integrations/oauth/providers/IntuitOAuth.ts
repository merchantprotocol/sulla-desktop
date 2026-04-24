/**
 * Intuit OAuth 2.0 provider — covers QuickBooks Online and any other
 * Intuit app that rides the shared OAuth 2.0 endpoints.
 *
 * Reference:
 *   https://developer.intuit.com/app/developer/qbo/docs/develop/authentication-and-authorization
 *
 * Notes:
 *   - The authorize URL is `appcenter.intuit.com/connect/oauth2` (discovery
 *     also advertises `accounts.platform.intuit.com`). Appcenter is the
 *     recommended production endpoint for the consent screen.
 *   - Scopes differ per product. Default to QuickBooks Accounting; an
 *     integration that needs additional scopes (e.g. Payments) should
 *     extend via property-driven scope selection when that feature lands.
 *   - Tokens are bearer; the realm_id (QuickBooks company ID) is returned
 *     as a query param on the redirect and must be stored alongside the
 *     access/refresh tokens — API calls need it in the path
 *     (`/v3/company/<realm_id>/...`). We store it in the vault as a
 *     separate credential property (see integration.yaml).
 */

import { OAuthProvider, type OAuthProviderConfig } from '../OAuthProvider';
import { registerOAuthProvider } from '../registry';

class IntuitOAuthProvider extends OAuthProvider {
  readonly config: OAuthProviderConfig = {
    id:            'intuit',
    name:          'Intuit',
    authorizeUrl:  'https://appcenter.intuit.com/connect/oauth2',
    tokenUrl:      'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer',
    revokeUrl:     'https://developer.api.intuit.com/v2/oauth2/tokens/revoke',
    scopes:        [
      'com.intuit.quickbooks.accounting',
    ],
    scopeSeparator:       ' ',
    clientAuthMethod:     'header', // Intuit expects HTTP Basic auth header on the token endpoint
    refreshBufferSeconds: 300,
  };
}

const instance = new IntuitOAuthProvider();
registerOAuthProvider(instance);

export default instance;
