// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { randomUUID } from 'node:crypto';

import {
  isKnownCustomFieldType,
  validateCustomFields,
  validateVaultItemProxy,
  type VaultItemCustomField,
  type VaultItemPlaintext,
} from '@sulla/vault-crypto';

import type { LocalAuthorityHost } from './LocalAuthorityHost.js';
import type { ItemRow } from './LocalAuthorityTypes.js';
import { LocalVaultError } from './LocalVaultError.js';

/**
 * The human vault page's item operations: list, activity, reveal, create/update with custom-field
 * and proxy-rule validation (revision compare-and-set), and soft delete.
 * Moved verbatim from LocalVaultAuthority (E9); vault state lives on the host.
 */
export class HumanItemService {
  constructor(private readonly host: LocalAuthorityHost) {}

  async listHumanItems(sessionId: string | undefined, csrf: string | undefined): Promise<Array<Record<string, unknown>>> {
    return this.host.runSecurityOperation(async() => {
    const session = this.host.validateHumanSession(sessionId, csrf);
    if (session.phase !== 'unlocked') throw new LocalVaultError('vault_locked', 423, 'Vault is locked');
    const keys = this.host.requireKeys();
    const generation = this.host.generation;
    const rows = await this.host.itemRepository.listOwnedActiveByUpdated<ItemRow & { item_type: string; updated_at: string }>([keys.userId]);
    const items = await Promise.all(rows.rows.map(async row => {
      const item = JSON.parse(await this.host.openItemText(
        { version: 1, ciphertext: row.ciphertext, encryptedItemKey: row.encrypted_item_key }, keys.userKey,
        { itemId: row.id, ownerId: keys.userId },
      )) as VaultItemPlaintext;
      return {
        id: row.id, type: item.type, name: item.name, favorite: item.favorite, username: item.username,
        uris: item.uris, folder: item.folder, agentPolicy: item.agentPolicy,
        integration: item.integration ? { integrationId: item.integration.integrationId, accountId: item.integration.accountId } : undefined,
        revision: Number(row.revision), updatedAt: row.updated_at,
      };
    }));
    this.host.requireGeneration(generation);
    return items;
    });
  }

  async listHumanItemActivity(
    sessionId: string | undefined, csrf: string | undefined, itemId?: string,
  ): Promise<Array<Record<string, unknown>>> {
    return this.host.runSecurityOperation(async() => {
    const session = this.host.validateHumanSession(sessionId, csrf);
    if (session.phase !== 'unlocked') throw new LocalVaultError('vault_locked', 423, 'Vault is locked');
    const keys = this.host.requireKeys();
    const generation = this.host.generation;
    const params: unknown[] = [keys.userId];
    const itemFilter = itemId ? 'AND a.item_id=$2' : '';
    if (itemId) params.push(itemId);
    const result = await this.host.auditLogRepository.listOwnedActivity(params, itemFilter);
    this.host.requireGeneration(generation);
    return result.rows;
    });
  }

  async revealHumanItem(sessionId: string | undefined, csrf: string | undefined, itemId: string): Promise<Record<string, unknown>> {
    return this.host.runSecurityOperation(async() => {
    const session = this.host.validateHumanSession(sessionId, csrf);
    if (session.phase !== 'unlocked') throw new LocalVaultError('vault_locked', 423, 'Vault is locked');
    const keys = this.host.requireKeys();
    const generation = this.host.generation;
    const result = await this.host.itemRepository.findOwnedActiveForReveal<ItemRow>([itemId, keys.userId]);
    const row = result.rows[0];
    if (!row) throw new LocalVaultError('policy_denied', 404, 'Vault item was not found');
    const item = JSON.parse(await this.host.openItemText(
      { version: 1, ciphertext: row.ciphertext, encryptedItemKey: row.encrypted_item_key }, keys.userKey,
      { itemId: row.id, ownerId: keys.userId },
    )) as VaultItemPlaintext;
    this.host.requireGeneration(generation);
    await this.host.auditHumanAction(this.host.db, keys.userId, 'human_item_reveal', row.id, item.name);
    this.host.requireGeneration(generation);
    return { id: row.id, revision: Number(row.revision), item };
    });
  }

  async saveHumanItem(
    sessionId: string | undefined, csrf: string | undefined,
    input: { id?: string; revision?: number; item: VaultItemPlaintext },
  ): Promise<{ id: string; revision: number }> {
    return this.host.runSecurityOperation(async() => {
    const session = this.host.validateHumanSession(sessionId, csrf);
    if (session.phase !== 'unlocked') throw new LocalVaultError('vault_locked', 423, 'Vault is locked');
    const keys = this.host.requireKeys();
    const generation = this.host.generation;
    if (!input.item || typeof input.item.name !== 'string' || !input.item.name.trim() || !input.item.agentPolicy) {
      throw new LocalVaultError('invalid_operation', 400, 'Vault item is invalid');
    }
    const policy = input.item.agentPolicy;
    if (!['only_me', 'agents'].includes(policy.mode) || !['metadata', 'autofill', 'full'].includes(policy.level) ||
        !Array.isArray(policy.agents) || !policy.agents.every(value => typeof value === 'string') ||
        !Array.isArray(policy.sites) || !policy.sites.every(value => typeof value === 'string') ||
        (policy.expiresAt !== null && (typeof policy.expiresAt !== 'string' || !Number.isFinite(Date.parse(policy.expiresAt))))) {
      throw new LocalVaultError('invalid_operation', 400, 'Agent access policy is invalid');
    }
    const id = input.id ?? randomUUID();
    const item: VaultItemPlaintext = { ...input.item };
    if (item.customFields !== undefined) {
      // Unknown types (from a newer client) may only round-trip when the stored item already had them.
      const raw: unknown = item.customFields;
      const hasUnknownType = Array.isArray(raw) && raw.some(field => !isKnownCustomFieldType((field as { type?: unknown } | null)?.type));
      const preserved = input.id && hasUnknownType ? await this.storedCustomFields(keys, input.id) : [];
      this.host.requireGeneration(generation);
      const checked = validateCustomFields(raw, { preserved });
      if (!checked.ok) throw new LocalVaultError('invalid_operation', 400, checked.error);
      if (checked.fields.length) item.customFields = checked.fields;
      else delete item.customFields;
    }
    if (item.proxy !== undefined) {
      const checked = validateVaultItemProxy(item);
      if (!checked.ok) throw new LocalVaultError('invalid_operation', 400, checked.error);
      item.proxy = checked.proxy;
    }
    const encrypted = await this.host.sealItem(JSON.stringify(item), keys.userKey, { itemId: id, ownerId: keys.userId });
    const result = await this.host.runTransaction(async client => {
      if (!input.id) {
      const created = await this.host.itemRepository.insertHumanItem<{ revision: number }>([id, keys.userId, input.item.type, encrypted.ciphertext, encrypted.encryptedItemKey, input.item.agentPolicy,
          input.item.integration ? `${ input.item.integration.integrationId }/${ input.item.integration.accountId }` : null], client);
      this.host.requireGeneration(generation);
      await this.host.auditHumanAction(client, keys.userId, 'human_item_created', id, input.item.name);
      this.host.requireGeneration(generation);
      return { id, revision: Number(created.rows[0].revision) };
      }
    const revision = Number(input.revision);
    if (!Number.isSafeInteger(revision) || revision < 1) throw new LocalVaultError('invalid_operation', 400, 'Item revision is required');
    const updated = await this.host.itemRepository.updateHumanItemIfRevision<{ revision: number }>([input.item.type, encrypted.ciphertext, encrypted.encryptedItemKey, input.item.agentPolicy,
        input.item.integration ? `${ input.item.integration.integrationId }/${ input.item.integration.accountId }` : null,
        id, keys.userId, revision], client);
    if (!updated.rowCount) throw new LocalVaultError('invalid_operation', 409, 'Vault item changed; reload and retry');
    this.host.requireGeneration(generation);
    await this.host.auditHumanAction(client, keys.userId, 'human_item_updated', id, input.item.name);
    this.host.requireGeneration(generation);
    return { id, revision: Number(updated.rows[0].revision) };
    });
    return result;
    });
  }

  /** Decrypts only the custom fields of a stored item; used to let unknown field types round-trip. */
  private async storedCustomFields(keys: { userId: string; userKey: Uint8Array }, itemId: string): Promise<VaultItemCustomField[]> {
    const result = await this.host.itemRepository.findOwnedActiveCustomFields<ItemRow>([itemId, keys.userId]);
    const row = result.rows[0];
    if (!row) return [];
    const stored = JSON.parse(await this.host.openItemText(
      { version: 1, ciphertext: row.ciphertext, encryptedItemKey: row.encrypted_item_key }, keys.userKey,
      { itemId: row.id, ownerId: keys.userId },
    )) as VaultItemPlaintext;
    return Array.isArray(stored.customFields) ? stored.customFields : [];
  }

  async deleteHumanItem(sessionId: string | undefined, csrf: string | undefined, itemId: string, revision: number): Promise<void> {
    return this.host.runSecurityOperation(async() => {
    const session = this.host.validateHumanSession(sessionId, csrf);
    if (session.phase !== 'unlocked') throw new LocalVaultError('vault_locked', 423, 'Vault is locked');
    const keys = this.host.requireKeys();
    const generation = this.host.generation;
    await this.host.runTransaction(async client => {
    const result = await this.host.itemRepository.softDeleteOwnedIfRevision([itemId, keys.userId, revision], client);
    if (!result.rowCount) throw new LocalVaultError('invalid_operation', 409, 'Vault item changed; reload and retry');
    this.host.requireGeneration(generation);
    await this.host.auditHumanAction(client, keys.userId, 'human_item_deleted', itemId);
    this.host.requireGeneration(generation);
    });
    });
  }
}
