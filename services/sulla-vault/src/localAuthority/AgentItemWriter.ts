// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { randomBytes, randomUUID } from 'node:crypto';

import type { VaultItemPlaintext } from '@sulla/vault-crypto';

import type {
  BrokerClaims,
  BrokerIntegrationCredentialWriteRequest,
  BrokerVaultItemUpdateRequest,
  BrokerVaultItemWriteRequest,
  BrokerVaultItemWriteResponse,
} from '../contracts.js';
import type { LocalAuthorityHost } from './LocalAuthorityHost.js';
import { BROKER_IDENTIFIER_PATTERN, MAX_CREDENTIAL_BYTES, UUID_PATTERN } from './LocalAuthorityLimits.js';
import type { ItemRow, UnlockedKeys } from './LocalAuthorityTypes.js';
import { LocalVaultError } from './LocalVaultError.js';

/**
 * Broker-side writes by agents: create/update logins and integration credentials an agent owns,
 * bound to the signed caller claims and recorded in the agent audit trail.
 * Moved verbatim from LocalVaultAuthority (E9); vault state lives on the host.
 */
export class AgentItemWriter {
  constructor(private readonly host: LocalAuthorityHost) {}

  private validateAgentWriteClaims(claims: BrokerClaims, callerId: string, token: string | undefined): UnlockedKeys {
    this.host.requireBrokerIdentity(callerId, token);
    const validIdentifier = (value: unknown) => typeof value === 'string' && BROKER_IDENTIFIER_PATTERN.test(value);
    if (!claims || !UUID_PATTERN.test(claims.sub) || !validIdentifier(claims.agent_id) || !validIdentifier(claims.pod_id)) {
      throw new LocalVaultError('invalid_caller_identity', 400, 'Broker caller identity is invalid');
    }
    const keys = this.host.requireKeys();
    if (claims.sub !== keys.userId) throw new LocalVaultError('invalid_caller_identity', 403, 'Broker principal is not unlocked');
    return keys;
  }

  private generatedPassword(): string {
    // 192 random bits, encoded without ambiguous punctuation; generation stays inside Vault.
    return randomBytes(24).toString('base64url');
  }

  async createAgentVaultItem(
    callerId: string, token: string | undefined, input: BrokerVaultItemWriteRequest,
  ): Promise<BrokerVaultItemWriteResponse> {
    return this.host.runSecurityOperation(async() => {
      const keys = this.validateAgentWriteClaims(input?.claims, callerId, token);
      const title = typeof input.title === 'string' ? input.title.trim() : '';
      if (!title || title.length > 200) throw new LocalVaultError('invalid_operation', 400, 'Item title is invalid');
      if ((input.password === undefined) === (input.generate !== true)) {
        throw new LocalVaultError('invalid_operation', 400, 'Provide exactly one of password or generate:true');
      }
      const password = input.generate === true ? this.generatedPassword() : String(input.password);
      if (!password || Buffer.byteLength(password) > MAX_CREDENTIAL_BYTES) throw new LocalVaultError('invalid_operation', 400, 'Password is invalid');
      const id = randomUUID();
      const sites = input.url ? [new URL(input.url).hostname] : [];
      const item: VaultItemPlaintext = {
        type: 'login', name: title, username: input.username, password,
        uris: input.url ? [{ uri: input.url }] : undefined, notes: input.notes, folder: input.folder,
        tags: Array.isArray(input.tags) ? input.tags.map(String).filter(Boolean).slice(0, 50) : undefined,
        agentPolicy: { mode: 'agents', level: 'metadata', agents: [input.claims.agent_id], sites, expiresAt: null, askFirst: false, allowServerAgents: false },
      };
      const encrypted = await this.host.sealItem(JSON.stringify(item), keys.userKey, { itemId: id, ownerId: keys.userId });
      const generation = this.host.generation;
      const result = await this.host.runTransaction(async client => {
        const created = await this.host.itemRepository.insertAgentItem<{ revision: number }>([id, keys.userId, item.type, encrypted.ciphertext, encrypted.encryptedItemKey, item.agentPolicy], client);
        this.host.requireGeneration(generation);
        await this.host.auditLogRepository.recordAgentCreated([keys.userId, id, input.claims.pod_id, { agentId: input.claims.agent_id }], client);
        return Number(created.rows[0].revision);
      });
      return { itemId: id, revision: result, generated: input.generate === true };
    });
  }

  async updateAgentVaultItem(
    callerId: string, token: string | undefined, input: BrokerVaultItemUpdateRequest,
  ): Promise<BrokerVaultItemWriteResponse> {
    return this.host.runSecurityOperation(async() => {
      const keys = this.validateAgentWriteClaims(input?.claims, callerId, token);
      if (!UUID_PATTERN.test(input.itemId)) throw new LocalVaultError('invalid_operation', 400, 'Item reference is invalid');
      const owned = await this.host.auditLogRepository.wasCreatedByAgentForUpdate([input.itemId, input.claims.agent_id]);
      if (!owned.rowCount) throw new LocalVaultError('policy_denied', 403, 'Agents may update only vault items they created');
      const rows = await this.host.itemRepository.findOwnedActiveForAgentUpdate<ItemRow>([input.itemId, keys.userId]);
      const row = rows.rows[0];
      if (!row) throw new LocalVaultError('policy_denied', 404, 'Vault item was not found');
      const item = JSON.parse(await this.host.openItemText(
        { version: 1, ciphertext: row.ciphertext, encryptedItemKey: row.encrypted_item_key }, keys.userKey,
        { itemId: row.id, ownerId: keys.userId },
      )) as VaultItemPlaintext;
      if (input.password !== undefined && input.generate === true) throw new LocalVaultError('invalid_operation', 400, 'Provide password or generate:true, not both');
      if (input.password !== undefined) item.password = String(input.password);
      if (input.generate === true) item.password = this.generatedPassword();
      if (input.title !== undefined) item.name = String(input.title).trim();
      if (input.username !== undefined) item.username = String(input.username);
      if (input.url !== undefined) item.uris = [{ uri: String(input.url) }];
      if (input.notes !== undefined) item.notes = String(input.notes);
      if (input.folder !== undefined) item.folder = String(input.folder);
      if (input.tags !== undefined) item.tags = input.tags.map(String).filter(Boolean).slice(0, 50);
      const encrypted = await this.host.sealItem(JSON.stringify(item), keys.userKey, { itemId: row.id, ownerId: keys.userId });
      const generation = this.host.generation;
      const revision = await this.host.runTransaction(async client => {
        const updated = await this.host.itemRepository.updateOwnedCiphertextIfRevision<{ revision: number }>([encrypted.ciphertext, encrypted.encryptedItemKey, row.id, keys.userId, row.revision], client);
        if (!updated.rowCount) throw new LocalVaultError('invalid_operation', 409, 'Vault item changed; retry');
        this.host.requireGeneration(generation);
        await this.host.auditLogRepository.recordAgentUpdated([keys.userId, row.id, input.claims.pod_id, { agentId: input.claims.agent_id }], client);
        return Number(updated.rows[0].revision);
      });
      return { itemId: row.id, revision, generated: input.generate === true };
    });
  }

  async setAgentIntegrationCredential(
    callerId: string, token: string | undefined, input: BrokerIntegrationCredentialWriteRequest,
  ): Promise<BrokerVaultItemWriteResponse> {
    return this.host.runSecurityOperation(async() => {
      const integrationId = String(input.integrationId ?? '').trim();
      const accountId = String(input.accountId ?? 'default').trim();
      const property = String(input.property ?? '').trim();
      if (integrationId === 'clerk') throw new LocalVaultError('policy_denied', 403, 'Clerk credentials can only be changed in Desktop Integrations.');
      if (![integrationId, accountId, property].every(value => /^[A-Za-z0-9._-]{1,128}$/.test(value))) {
        throw new LocalVaultError('invalid_operation', 400, 'Credential reference is invalid');
      }
      const keys = this.validateAgentWriteClaims(input.claims, callerId, token);
      const existing = await this.host.itemRepository.findOwnedIntegrationCredential<ItemRow>([keys.userId, `${ integrationId }/${ accountId }`]);
      if (!existing.rowCount) {
        const result = await this.createAgentIntegrationItem(keys, input, integrationId, accountId, property);
        return result;
      }
      const row = existing.rows[0];
      const owned = await this.host.auditLogRepository.wasCreatedByAgentForIntegration([row.id, input.claims.agent_id]);
      if (!owned.rowCount) throw new LocalVaultError('policy_denied', 403, 'Agents may update only credentials they created');
      const item = JSON.parse(await this.host.openItemText({ version: 1, ciphertext: row.ciphertext, encryptedItemKey: row.encrypted_item_key }, keys.userKey, { itemId: row.id, ownerId: keys.userId })) as VaultItemPlaintext;
      item.integration ??= { integrationId, accountId, properties: {} };
      item.integration.properties[property] = String(input.value);
      const encrypted = await this.host.sealItem(JSON.stringify(item), keys.userKey, { itemId: row.id, ownerId: keys.userId });
      const updated = await this.host.runTransaction(async client => {
        const result = await this.host.itemRepository.updateCiphertextIfRevision<{ revision: number }>([encrypted.ciphertext, encrypted.encryptedItemKey, row.id, row.revision], client);
        if (!result.rowCount) throw new LocalVaultError('invalid_operation', 409, 'Vault item changed; retry');
        await this.host.auditLogRepository.recordIntegrationAgentUpdated([keys.userId, row.id, input.claims.pod_id, { agentId: input.claims.agent_id }], client);
        return Number(result.rows[0].revision);
      });
      return { itemId: row.id, revision: updated, generated: false };
    });
  }

  private async createAgentIntegrationItem(keys: UnlockedKeys, input: BrokerIntegrationCredentialWriteRequest, integrationId: string, accountId: string, property: string): Promise<BrokerVaultItemWriteResponse> {
    const id = randomUUID();
    const item: VaultItemPlaintext = { type: 'login', name: `${ integrationId } (${ accountId })`, integration: { integrationId, accountId, properties: { [property]: String(input.value) } }, agentPolicy: { mode: 'agents', level: 'metadata', agents: [input.claims.agent_id], sites: [], expiresAt: null, askFirst: false, allowServerAgents: false } };
    const encrypted = await this.host.sealItem(JSON.stringify(item), keys.userKey, { itemId: id, ownerId: keys.userId });
    const revision = await this.host.runTransaction(async client => {
      const created = await this.host.itemRepository.insertAgentIntegrationItem<{ revision: number }>([id, keys.userId, item.type, encrypted.ciphertext, encrypted.encryptedItemKey, item.agentPolicy, `${ integrationId }/${ accountId }`], client);
      await this.host.auditLogRepository.recordIntegrationAgentCreated([keys.userId, id, input.claims.pod_id, { agentId: input.claims.agent_id }], client);
      return Number(created.rows[0].revision);
    });
    return { itemId: id, revision, generated: false };
  }
}
