// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { issueLocalBrokerContext, requireConfiguredCredentialBroker } from '../../../../vault-broker';

import type { OAuthProviderConfig, OAuthTokenSet } from '../../../integrations/oauth/OAuthProvider';
import type { ResolvedTokenCustody } from '../custody/TokenCustody';

export interface TokenExchangeRequest {
  custody: ResolvedTokenCustody;
  config: OAuthProviderConfig;
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  codeVerifier?: string;
  integrationId: string;
  accountId: string;
  useVault: boolean;
}

export class TokenExchanger {
  async exchange(request: TokenExchangeRequest): Promise<OAuthTokenSet> {
    const { custody, config: cfg, clientId, clientSecret, integrationId, accountId } = request;
    const body: Record<string, string> = {
      grant_type: 'authorization_code',
      code: request.code,
      redirect_uri: request.redirectUri,
      ...cfg.extraTokenParams,
    };
    if (request.codeVerifier) body.code_verifier = request.codeVerifier;
    const headers: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      'User-Agent': 'Sulla-Desktop/1.0',
    };

    if (custody.kind === 'vault' && request.useVault) {
      const injections = cfg.clientAuthMethod === 'header'
        ? [{ field: 'client_secret', target: 'header' as const, name: 'authorization', scheme: 'BasicClient' as const }]
        : cfg.clientAuthMethod === 'none' ? [] : [
          { field: 'client_id', target: 'form' as const, name: 'client_id', scheme: 'raw' as const },
          { field: 'client_secret', target: 'form' as const, name: 'client_secret', scheme: 'raw' as const },
        ];
      if (cfg.clientAuthMethod === 'none') body.client_id = clientId;
      const context = await issueLocalBrokerContext({
        agentId: 'oauth-exchange', podId: 'desktop-main',
        credentialScope: { integration_id: integrationId, account_id: accountId },
      });
      const broker = requireConfiguredCredentialBroker();
      const result = await broker.execute(broker.requestFor(context, {
        operation: 'oauth.exchange', ref: { integrationId, accountId }, url: cfg.tokenUrl,
        method: 'POST', headers, body, injections,
      }));
      if (result.status < 200 || result.status >= 300 || !result.body || typeof result.body !== 'object') {
        throw new Error('[OAuthService] Vault-owned token exchange failed');
      }
      return result.body as OAuthTokenSet;
    }

    if (cfg.clientAuthMethod === 'header') {
      headers.Authorization = `Basic ${ Buffer.from(`${ clientId }:${ clientSecret }`).toString('base64') }`;
    } else if (cfg.clientAuthMethod === 'none') {
      body.client_id = clientId;
    } else {
      body.client_id = clientId;
      body.client_secret = clientSecret;
    }
    const response = await fetch(cfg.tokenUrl, {
      method: 'POST', headers, body: new URLSearchParams(body).toString(),
    });
    if (!response.ok) throw new Error(`[OAuthService] Token exchange failed with status ${ response.status }`);
    return await response.json() as OAuthTokenSet;
  }
}
