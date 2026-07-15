// Robinhood OAuth 2.0 provider for the Robinhood Agentic Trading MCP server.
//
// Robinhood uses a public PKCE client created through Dynamic Client
// Registration for the concrete localhost redirect_uri. The resulting
// client_id is persisted in the integration vault as oauth_client_id so
// refresh_token grants continue to work after restart.

import { OAuthProvider, type OAuthProviderConfig, type OAuthProviderHookContext, type OAuthTokenSet } from '../OAuthProvider';
import { registerOAuthProvider } from '../registry';

const ROBINHOOD_MCP_SERVER_URL = 'https://agent.robinhood.com/mcp/trading';

function mcpAccountId(accountId: string): string {
  return accountId === 'default' || accountId === 'oauth'
    ? 'robinhood'
    : `robinhood-${ accountId }`;
}

class RobinhoodOAuthProvider extends OAuthProvider {
  readonly config: OAuthProviderConfig = {
    id:                         'robinhood',
    name:                       'Robinhood',
    authorizeUrl:               'https://robinhood.com/oauth',
    tokenUrl:                   'https://api.robinhood.com/oauth2/token/',
    scopes:                     ['internal'],
    scopeSeparator:             ' ',
    clientAuthMethod:           'none',
    usePKCE:                    true,
    registrationEndpoint:       'https://agent.robinhood.com/oauth/trading/register',
    registrationClientMetadata: {
      client_name:                'Sulla Desktop',
      grant_types:                ['authorization_code', 'refresh_token'],
      response_types:             ['code'],
      token_endpoint_auth_method: 'none',
    },
    extraAuthorizeParams: { resource: ROBINHOOD_MCP_SERVER_URL },
    extraTokenParams:     { resource: ROBINHOOD_MCP_SERVER_URL },
    refreshBufferSeconds: 300,
  };

  override async onTokenReceived(tokens: OAuthTokenSet, context?: OAuthProviderHookContext): Promise<void> {
    if (!context?.accountId || !tokens.access_token) return;

    const { getIntegrationService } = await import('../../../services/IntegrationService');
    const { MCPBridge } = await import('../../mcp/MCPBridge');

    const accountId = mcpAccountId(context.accountId);
    const svc = getIntegrationService();

    await svc.setMultipleValues([
      {
        integration_id: 'mcp',
        account_id:     accountId,
        property:       'account_label',
        value:          'Robinhood Trading',
      },
      {
        integration_id: 'mcp',
        account_id:     accountId,
        property:       'server_url',
        value:          ROBINHOOD_MCP_SERVER_URL,
      },
      {
        integration_id: 'mcp',
        account_id:     accountId,
        property:       'auth_token',
        value:          tokens.access_token,
      },
    ]);
    await svc.setConnectionStatus('mcp', true, accountId);

    const bridge = MCPBridge.getInstance();
    await bridge.refreshAccount(accountId);
    await bridge.refreshConfigs(accountId);
  }

  override async onTokensRevoked(context?: OAuthProviderHookContext): Promise<void> {
    if (!context?.accountId) return;

    try {
      const { getIntegrationService } = await import('../../../services/IntegrationService');
      const { MCPBridge } = await import('../../mcp/MCPBridge');

      const accountId = mcpAccountId(context.accountId);
      const bridge = MCPBridge.getInstance();
      await bridge.removeAccount(accountId);
      bridge.removeConfigs(accountId);

      const svc = getIntegrationService();
      await svc.deleteAccount('mcp', accountId);
    } catch (err) {
      console.warn('[RobinhoodOAuth] Failed to tear down MCP account:', err);
    }
  }
}

const instance = new RobinhoodOAuthProvider();
registerOAuthProvider(instance);

export default instance;
