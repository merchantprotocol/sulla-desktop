// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { OAuthTokenSet } from '../../../integrations/oauth';

export interface TokenAccount {
  integrationId: string;
  accountId: string;
  providerId: string;
}

export interface TokenMetadata extends TokenAccount {
  expiresAt?: number;
  scope?: string;
  tokenType?: string;
  clientId?: string;
  connected?: boolean;
  refreshable: boolean;
  updatedAt?: number;
}

export interface TokenCustody {
  readonly kind: 'vault';
  store(account: TokenAccount, tokens: OAuthTokenSet): Promise<TokenMetadata>;
  getMetadata(integrationId: string, accountId: string): Promise<TokenMetadata | null>;
  listRefreshable(): Promise<TokenMetadata[]>;
  remove(integrationId: string, accountId: string): Promise<void>;
}

/** A custody whose secret material is allowed to enter this process. */
export interface RawTokenCustody {
  readonly kind: 'memory' | 'legacy';
  store(account: TokenAccount, tokens: OAuthTokenSet): Promise<TokenMetadata>;
  getMetadata(integrationId: string, accountId: string): Promise<TokenMetadata | null>;
  getRawTokens(integrationId: string, accountId: string): Promise<OAuthTokenSet | null>;
  listRefreshable(): Promise<TokenMetadata[]>;
  remove(integrationId: string, accountId: string): Promise<void>;
}

export type ResolvedTokenCustody = TokenCustody | RawTokenCustody;

export function isRawTokenCustody(custody: ResolvedTokenCustody): custody is RawTokenCustody {
  return custody.kind !== 'vault';
}
