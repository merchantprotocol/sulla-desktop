// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { getPendingCredential, queuePendingCredential } from '@pkg/main/firstRun/pendingCredentials';

import type { OAuthTokenSet } from '../../../integrations/oauth';
import type { RawTokenCustody, TokenAccount, TokenMetadata } from './TokenCustody';

export class FirstRunMemoryCustody implements RawTokenCustody {
  readonly kind = 'memory' as const;

  async store(account: TokenAccount, tokens: OAuthTokenSet): Promise<TokenMetadata> {
    const values = Object.fromEntries(Object.entries(tokens)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]) => [key, typeof value === 'string' ? value : String(value)]));
    values.provider_id = account.providerId;
    await queuePendingCredential({ integrationId: account.integrationId, accountId: account.accountId, values, activate: true });
    return this.metadata(account, tokens);
  }

  async getRawTokens(integrationId: string, accountId: string): Promise<OAuthTokenSet | null> {
    const entry = getPendingCredential(integrationId, accountId);
    return entry ? entry.values as OAuthTokenSet : null;
  }

  async getMetadata(integrationId: string, accountId: string): Promise<TokenMetadata | null> {
    const tokens = await this.getRawTokens(integrationId, accountId);
    return tokens ? this.metadata({ integrationId, accountId, providerId: String(tokens.provider_id || '') }, tokens) : null;
  }

  async listRefreshable(): Promise<TokenMetadata[]> { return [] }
  async remove(): Promise<void> { /* pending entries are cleared by the first-run owner */ }

  private metadata(account: TokenAccount, tokens: OAuthTokenSet): TokenMetadata {
    return { ...account, expiresAt: Number(tokens.expires_at) || undefined, scope: tokens.scope, tokenType: tokens.token_type, refreshable: !!tokens.refresh_token };
  }
}
