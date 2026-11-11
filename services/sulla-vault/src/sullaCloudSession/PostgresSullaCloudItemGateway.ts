// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { decryptItemText, encryptItem, type EncryptedEnvelope, type VaultItemPlaintext } from '@sulla/vault-crypto';

import type { Queryable } from '../db.js';
import type { PostgresVaultItemRepository } from '../repositories/PostgresVaultItemRepositories.js';
import type { PostgresIntegrationStateRepository } from '../repositories/PostgresVaultAuthorityRepositories.js';
import { SULLA_CLOUD_INTEGRATION_ID } from '../sullaCloudRelay.js';
import type { SullaCloudItemGateway, SullaCloudSessionRecord } from './SullaCloudItemGateway.js';
import type { VaultUserKeyHolder } from './VaultRevocationQueue.js';

/** What the gateway needs from the vault authority (it owns the keys, the lock generation and the transaction/audit plumbing). */
export interface SullaCloudVaultContext extends VaultUserKeyHolder {
  generation(): number;
  requireGeneration(generation: number): void;
  transaction<T>(work: (client: Queryable) => Promise<T>): Promise<T>;
  auditHumanAction(client: Queryable, userId: string, action: string, itemId?: string | null): Promise<void>;
}

interface StoredItem {
  id:                 string;
  owner_user_id:      string | null;
  collection_id:      string | null;
  ciphertext:         EncryptedEnvelope;
  encrypted_item_key: EncryptedEnvelope;
  revision:           number | string;
}

/** The `sulla-cloud` vault item behind SullaCloudItemGateway. Same item shape and same revision compare-and-set as before. */
export class PostgresSullaCloudItemGateway implements SullaCloudItemGateway {
  /** apple_signin rides along with the Sulla Cloud session, as it did in the old clear. */
  private static readonly FAMILIES = [SULLA_CLOUD_INTEGRATION_ID, 'apple_signin'];

  constructor(
    private readonly vault: SullaCloudVaultContext,
    private readonly items: PostgresVaultItemRepository,
    private readonly state: PostgresIntegrationStateRepository,
  ) {}

  async load(): Promise<SullaCloudSessionRecord | null> {
    const { userId, userKey } = this.vault.userKey();
    const active = await this.state.findActive<{ active_account_id: string }>(userId, SULLA_CLOUD_INTEGRATION_ID);
    const accountId = active.rows[0]?.active_account_id;
    if (!accountId) return null;
    const item = (await this.items.findBrokerCredential<StoredItem>([userId, null, `${ SULLA_CLOUD_INTEGRATION_ID }/${ accountId }`])).rows[0];
    if (!item || item.collection_id || item.owner_user_id !== userId) return null;
    const properties = (await this.decrypt(item, userKey, userId)).integration?.properties ?? {};
    const { access_token: accessToken, refresh_token: refreshToken, user_id: sessionUser, active_contractor_id: contractor } = properties;
    if (!accessToken || !refreshToken) return null;
    return {
      itemId: item.id, revision: Number(item.revision), userId: sessionUser || userId,
      activeContractorId: contractor || sessionUser || userId, accessToken, refreshToken,
    };
  }

  async replaceTokens(itemId: string, expectedRevision: number, accessToken: string, refreshToken: string): Promise<number | null> {
    const { userId, userKey } = this.vault.userKey();
    const generation = this.vault.generation();
    return this.vault.transaction(async client => {
      this.vault.requireGeneration(generation);
      const item = (await this.items.findOwnedPersonalActive<StoredItem>([itemId, userId], client)).rows[0];
      if (!item || Number(item.revision) !== expectedRevision) return null;
      const plaintext = await this.decrypt(item, userKey, userId);
      if (!plaintext.integration) return null;
      plaintext.integration.properties.access_token = accessToken;
      plaintext.integration.properties.refresh_token = refreshToken;
      const encrypted = await encryptItem(JSON.stringify(plaintext), userKey, { itemId: item.id, ownerId: userId });
      this.vault.requireGeneration(generation);
      const updated = await this.items.updateOAuthCiphertextIfRevision<{ revision: string }>(
        [encrypted.ciphertext, encrypted.encryptedItemKey, item.id, expectedRevision], client,
      );
      if (!updated.rowCount) return null;
      await this.vault.auditHumanAction(client, userId, 'sulla_cloud_token_refreshed', item.id);
      this.vault.requireGeneration(generation);
      return Number(updated.rows[0].revision);
    });
  }

  async purge(): Promise<boolean> {
    const { userId } = this.vault.userKey();
    const generation = this.vault.generation();
    return this.vault.transaction(async client => {
      const scrubbed = await this.items.scrubIntegrationFamilies([userId, PostgresSullaCloudItemGateway.FAMILIES], client);
      await this.state.clear(userId, PostgresSullaCloudItemGateway.FAMILIES, client);
      await this.vault.auditHumanAction(client, userId, 'sulla_cloud_session_cleared');
      this.vault.requireGeneration(generation);
      return (scrubbed.rowCount ?? 0) > 0;
    });
  }

  private async decrypt(item: StoredItem, userKey: Uint8Array, userId: string): Promise<VaultItemPlaintext> {
    return JSON.parse(await decryptItemText(
      { version: 1, ciphertext: item.ciphertext, encryptedItemKey: item.encrypted_item_key }, userKey, { itemId: item.id, ownerId: item.owner_user_id ?? userId },
    )) as VaultItemPlaintext;
  }
}
