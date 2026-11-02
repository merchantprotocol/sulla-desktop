// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { postgresClient } from '../../../database/PostgresClient';
import type { OAuthTokenSet } from '../../../integrations/oauth';
import type { RawTokenCustody, TokenAccount, TokenMetadata } from './TokenCustody';

export interface LegacyOAuthTokenRow { token_id?: number; integration_id: string; account_id: string; provider_id: string; access_token: string; refresh_token: string | null; token_type: string; scope: string | null; expires_at: number | null; raw_response: Record<string, unknown> | null; created_at?: Date; updated_at: Date | string }

export class LegacyDbCustody implements RawTokenCustody {
  readonly kind = 'legacy' as const;
  async store(account: TokenAccount, tokens: OAuthTokenSet): Promise<TokenMetadata> {
    await postgresClient.query(`INSERT INTO oauth_tokens (integration_id, account_id, provider_id, access_token, refresh_token, token_type, scope, expires_at, raw_response, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,CURRENT_TIMESTAMP) ON CONFLICT (integration_id, account_id) DO UPDATE SET provider_id=EXCLUDED.provider_id, access_token=EXCLUDED.access_token, refresh_token=COALESCE(EXCLUDED.refresh_token, oauth_tokens.refresh_token), token_type=EXCLUDED.token_type, scope=EXCLUDED.scope, expires_at=EXCLUDED.expires_at, raw_response=EXCLUDED.raw_response, updated_at=CURRENT_TIMESTAMP`, [account.integrationId, account.accountId, account.providerId, tokens.access_token, tokens.refresh_token ?? null, tokens.token_type || 'Bearer', tokens.scope ?? null, tokens.expires_at ?? null, JSON.stringify(tokens)]);
    return this.toMetadata(account, tokens);
  }
  async row(integrationId: string, accountId: string): Promise<LegacyOAuthTokenRow | null> { return postgresClient.queryOne<LegacyOAuthTokenRow>('SELECT * FROM oauth_tokens WHERE integration_id=$1 AND account_id=$2', [integrationId, accountId]) }
  async getRawTokens(integrationId: string, accountId: string): Promise<OAuthTokenSet | null> { const row = await this.row(integrationId, accountId); return row ? this.toTokens(row) : null }
  async getMetadata(integrationId: string, accountId: string): Promise<TokenMetadata | null> { const row = await this.row(integrationId, accountId); return row ? this.toMetadata({ integrationId, accountId, providerId: row.provider_id }, this.toTokens(row)) : null }
  async listRefreshable(): Promise<TokenMetadata[]> { const rows = await postgresClient.query<LegacyOAuthTokenRow>('SELECT * FROM oauth_tokens WHERE refresh_token IS NOT NULL'); return rows.map(row => this.toMetadata({ integrationId: row.integration_id, accountId: row.account_id, providerId: row.provider_id }, this.toTokens(row), row.updated_at)) }
  async remove(integrationId: string, accountId: string): Promise<void> { await postgresClient.query('DELETE FROM oauth_tokens WHERE integration_id=$1 AND account_id=$2', [integrationId, accountId]) }
  private toTokens(row: LegacyOAuthTokenRow): OAuthTokenSet { return { ...(row.raw_response || {}), access_token: row.access_token, refresh_token: row.refresh_token || undefined, token_type: row.token_type, scope: row.scope || undefined, expires_at: row.expires_at || undefined } as OAuthTokenSet }
  private toMetadata(account: TokenAccount, tokens: OAuthTokenSet, updatedAt?: Date | string): TokenMetadata {
    const updatedAtMs = updatedAt instanceof Date ? updatedAt.getTime() : updatedAt ? new Date(updatedAt).getTime() : undefined;
    return { ...account, expiresAt: Number(tokens.expires_at) || undefined, scope: tokens.scope, tokenType: tokens.token_type, refreshable: !!tokens.refresh_token, updatedAt: updatedAtMs };
  }
}
