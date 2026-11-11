// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { AuthSession, TokenPair, type TokenStore } from '@sulla/domain';

import type { SullaCloudItemGateway } from './SullaCloudItemGateway.js';

/**
 * TokenStore over the existing `sulla-cloud` vault item. Compare-and-set is the vault's revision check
 * (`updateOAuthCiphertextIfRevision`), so a stale refresh can never overwrite a newer rotation or resurrect a cleared session.
 */
export class VaultItemTokenStore implements TokenStore {
  constructor(private readonly gateway: SullaCloudItemGateway) {}

  async read(): Promise<AuthSession | null> {
    const record = await this.gateway.load();
    if (!record) return null;
    return new AuthSession(record.userId, record.activeContractorId, new TokenPair(record.accessToken, record.refreshToken), record.revision);
  }

  async compareAndSet(expected: AuthSession | null, next: AuthSession): Promise<boolean> {
    // A refresh only ever replaces tokens of an existing item; creating the item is the adopt path (adoptSullaCloudSession).
    if (!expected) return false;
    const record = await this.gateway.load();
    if (!record) return false;
    const stored = new AuthSession(record.userId, record.activeContractorId, new TokenPair(record.accessToken, record.refreshToken), record.revision);
    if (!expected.matches(stored)) return false;
    const revision = await this.gateway.replaceTokens(record.itemId, record.revision, next.tokens.accessToken, next.tokens.refreshToken);
    return revision !== null;
  }

  async clear(expected?: AuthSession | null): Promise<boolean> {
    if (!expected) return this.gateway.purge();
    const record = await this.gateway.load();
    if (!record) return false;
    const stored = new AuthSession(record.userId, record.activeContractorId, new TokenPair(record.accessToken, record.refreshToken), record.revision);
    if (!expected.matches(stored)) return false;
    return this.gateway.purge();
  }
}
