// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { AuthSession, TokenPair, type TokenStore } from '@sulla/domain';

import type { SullaCloudItemGateway } from './SullaCloudItemGateway.js';
import type { SullaCloudVaultContext } from './PostgresSullaCloudItemGateway.js';
import type { ProfileContext } from '../profiles/VaultProfileSession.js';

/**
 * TokenStore over the existing `sulla-cloud` vault item. Compare-and-set is the vault's revision check
 * (`updateOAuthCiphertextIfRevision`), so a stale refresh can never overwrite a newer rotation or resurrect a cleared session.
 */
export class VaultItemTokenStore implements TokenStore {
  private readonly snapshots = new WeakMap<AuthSession, { profile: ProfileContext; authorityGeneration: number }>();
  private readonly staleRefreshWarnings = new Set<string>();

  constructor(private readonly gateway: SullaCloudItemGateway, private readonly vault?: SullaCloudVaultContext) {}

  async read(): Promise<AuthSession | null> {
    const record = await this.gateway.load();
    if (!record) return null;
    const session = new AuthSession(record.userId, record.activeContractorId, new TokenPair(record.accessToken, record.refreshToken), record.revision);
    if (this.profileBound) this.snapshots.set(session, { profile: this.vault!.profileContext!(), authorityGeneration: this.vault!.generation() });
    return session;
  }

  async compareAndSet(expected: AuthSession | null, next: AuthSession): Promise<boolean> {
    // A refresh only ever replaces tokens of an existing item; creating the item is the adopt path (adoptSullaCloudSession).
    if (!expected) return false;
    const snapshot = this.snapshots.get(expected);
    if (this.profileBound && !snapshot) return false;
    if (this.profileBound && snapshot && !this.isCurrent(snapshot)) return false;
    const record = await this.gateway.load();
    if (!record) return false;
    const stored = new AuthSession(record.userId, record.activeContractorId, new TokenPair(record.accessToken, record.refreshToken), record.revision);
    if (!expected.matches(stored)) return false;
    if (this.profileBound && snapshot && !this.isCurrent(snapshot)) return false;
    const revision = await this.gateway.replaceTokens(record.itemId, record.revision, next.tokens.accessToken, next.tokens.refreshToken);
    return revision !== null;
  }

  async clear(expected?: AuthSession | null): Promise<boolean> {
    if (!expected) return this.gateway.purge();
    const snapshot = this.snapshots.get(expected);
    if (this.profileBound && !snapshot) return false;
    if (this.profileBound && snapshot && !this.isCurrent(snapshot)) return false;
    const record = await this.gateway.load();
    if (!record) return false;
    const stored = new AuthSession(record.userId, record.activeContractorId, new TokenPair(record.accessToken, record.refreshToken), record.revision);
    if (!expected.matches(stored)) return false;
    if (this.profileBound && snapshot && !this.isCurrent(snapshot)) return false;
    return this.gateway.purge();
  }

  private isCurrent(snapshot: { profile: ProfileContext; authorityGeneration: number }): boolean {
    try {
      this.vault!.assertProfileCurrent!(snapshot.profile);
      this.vault!.requireGeneration(snapshot.authorityGeneration);
      return true;
    } catch {
      const key = `${snapshot.profile.profileId}/${snapshot.profile.generation.value}`;
      if (!this.staleRefreshWarnings.has(key)) {
        this.staleRefreshWarnings.add(key);
        console.warn('Dropped stale Sulla Cloud token refresh');
      }
      return false;
    }
  }

  private get profileBound(): boolean {
    return Boolean(this.vault?.profileContext && this.vault.assertProfileCurrent);
  }
}
