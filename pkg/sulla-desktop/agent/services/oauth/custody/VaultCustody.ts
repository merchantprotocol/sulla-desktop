// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { getIntegrationService } from '../../IntegrationService';
import type { OAuthTokenSet } from '../../../integrations/oauth';
import { requireConfiguredCredentialBroker } from '@pkg/vault-broker';
import type { TokenAccount, TokenCustody, TokenMetadata } from './TokenCustody';

export class VaultCustody implements TokenCustody {
  readonly kind = 'vault' as const;
  async store(account: TokenAccount, tokens: OAuthTokenSet): Promise<TokenMetadata> {
    // oauth.exchange/refresh persisted the secret before returning metadata.
    return { ...account, expiresAt: Number(tokens.expires_at) || undefined, scope: tokens.scope, tokenType: tokens.token_type, refreshable: true };
  }
  async getMetadata(integrationId: string, accountId: string): Promise<TokenMetadata | null> {
    const values = await getIntegrationService().getMetadataValues(integrationId, accountId);
    const properties = Object.fromEntries(values.filter(value => value.account_id === accountId).map(value => [value.property, value.value]));
    if (!properties.expires_at && !properties.token_type) return null;
    return { integrationId, accountId, providerId: properties.provider_id || properties.provider || '', expiresAt: Number(properties.expires_at) || undefined, scope: properties.scope, tokenType: properties.token_type, clientId: properties.oauth_client_id || properties.client_id, connected: properties.connected !== 'false', refreshable: true };
  }
  async listRefreshable(): Promise<TokenMetadata[]> {
    const { integrations } = await import('../../../integrations/catalog');
    const broker = requireConfiguredCredentialBroker();
    const result: TokenMetadata[] = [];
    for (const [integrationId, integration] of Object.entries(integrations)) {
      const fallbackProviderId = integration.oauthProviderId;
      if (!fallbackProviderId) continue;
      try {
        const metadata = await broker.integrationMetadata(integrationId);
        for (const account of metadata.accounts) {
          if (!account.connected) continue;
          const properties = account.properties;
          if (!properties.expires_at && !properties.token_type) continue;
          result.push({
            integrationId,
            accountId: account.accountId,
            providerId: properties.provider_id || properties.provider || fallbackProviderId,
            expiresAt: Number(properties.expires_at) || undefined,
            scope: properties.scope,
            tokenType: properties.token_type,
            clientId: properties.oauth_client_id || properties.client_id,
            connected: account.connected,
            refreshable: true,
          });
        }
      } catch {
        // No vault items for this integration.
      }
    }
    return result;
  }
  async remove(): Promise<void> { /* the vault revoke operation owns removal */ }
}
