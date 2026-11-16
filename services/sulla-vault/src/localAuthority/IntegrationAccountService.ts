// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { randomUUID } from 'node:crypto';

import type { VaultItemPlaintext } from '@sulla/vault-crypto';

import type { BrokerIntegrationAccountImportRequest, BrokerOAuthAccountRequest } from '../contracts.js';
import { isNativeOAuthIntegration } from '../oauthPolicy.js';
import { trustedOriginsForIntegration } from '../operationPolicy.js';
import type { LocalAuthorityHost } from './LocalAuthorityHost.js';
import { CREDENTIAL_PROPERTY_PATTERN } from './LocalAuthorityLimits.js';
import type { ItemRow } from './LocalAuthorityTypes.js';
import { LocalVaultError } from './LocalVaultError.js';
import { BrokerCredentialFields } from './BrokerCredentialFields.js';

/**
 * Integration accounts: safe metadata reads, the active-account choice, Desktop-imported and
 * OAuth placeholder accounts, and the narrow backup-credential egress.
 * Moved verbatim from LocalVaultAuthority (E9); vault state lives on the host.
 */
export class IntegrationAccountService {
  constructor(private readonly host: LocalAuthorityHost) {}

  /** Narrow backup-only egress: personal items, fixed field allowlist, and a bound destination. */
  async backupCredentials(itemId:string,kind:'s3'|'nas',target:string):Promise<Record<string,string>> {
    const keys=this.host.requireKeys(); const generation=this.host.generation;
    if (!/^[0-9a-f-]{36}$/i.test(itemId)) throw new LocalVaultError('invalid_operation',400,'Backup credential ID is invalid');
    const item=(await this.host.itemRepository.findOwnedPersonalActive<ItemRow>([itemId,keys.userId])).rows[0];
    if (!item) throw new LocalVaultError('policy_denied',403,'Backup credential is unavailable');
    const plaintext=JSON.parse(await this.host.openItemText({version:1,ciphertext:item.ciphertext,encryptedItemKey:item.encrypted_item_key},keys.userKey,{itemId:item.id,ownerId:keys.userId})) as VaultItemPlaintext;
    const bound=BrokerCredentialFields.credentialField(plaintext,'backup_target');
    if (BrokerCredentialFields.credentialField(plaintext,'backup_kind')!==kind || bound!==target) throw new LocalVaultError('policy_denied',403,'Vault item must bind backup_kind and backup_target to this destination');
    const fields=kind==='s3'?['accessKeyId','secretAccessKey','sessionToken']:['username','password','domain'];
    const result:Record<string,string>={};
    for(const field of fields) { const value=BrokerCredentialFields.credentialField(plaintext,field); if(value) result[field]=value }
    if(kind==='s3' && (!result.accessKeyId || !result.secretAccessKey)) throw new LocalVaultError('credential_field_missing',400,'S3 backup credentials are incomplete');
    if(kind==='nas' && (!result.username || !result.password)) throw new LocalVaultError('credential_field_missing',400,'SMB backup credentials are incomplete');
    this.host.requireGeneration(generation);
    return result;
  }

  async integrationMetadata(
    callerId: string, token: string | undefined, integrationId: string, accountFilter?: string,
  ): Promise<import('../contracts.js').BrokerIntegrationMetadataResponse> {
    this.host.requireBrokerIdentity(callerId, token);
    return this.readIntegrationMetadata(integrationId, accountFilter);
  }

  private async readIntegrationMetadata(
    integrationId: string, accountFilter?: string,
  ): Promise<import('../contracts.js').BrokerIntegrationMetadataResponse> {
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(integrationId)) {
      throw new LocalVaultError('invalid_operation', 400, 'Integration identifier is invalid');
    }
    const keys = this.host.requireKeys();
    const generation = this.host.generation;
    const result = await this.host.itemRepository.listIntegrationMetadata<ItemRow & { integration_ref: string }>([keys.userId, integrationId, accountFilter ?? null]);
    this.host.requireGeneration(generation);
    const active = await this.host.localStore.findActiveAccount<{ active_account_id: string | null }>(keys.userId, integrationId);
    this.host.requireGeneration(generation);
    const availableIds = result.rows.map(item => item.integration_ref.slice(integrationId.length + 1));
    const configuredActive = active.rows[0]?.active_account_id;
    const activeAccountId = configuredActive && availableIds.includes(configuredActive)
      ? configuredActive
      : availableIds[0];
    const accounts = await Promise.all(result.rows.map(async item => {
      const plaintext = JSON.parse(await this.host.openItemText(
        { version: 1, ciphertext: item.ciphertext, encryptedItemKey: item.encrypted_item_key },
        keys.userKey,
        { itemId: item.id, ownerId: keys.userId },
      )) as VaultItemPlaintext;
      this.host.requireGeneration(generation);
      const sourceProperties = plaintext.integration?.properties ?? {};
      const properties = BrokerCredentialFields.safeIntegrationMetadata(sourceProperties, integrationId);
      const accountId = item.integration_ref.slice(integrationId.length + 1);
      const explicitStatus = properties.connection_status?.toLowerCase();
      const hasCredential = Object.entries(sourceProperties)
        .some(([name, value]) => CREDENTIAL_PROPERTY_PATTERN.test(name) && typeof value === 'string' && value.length > 0);
      const credentialRequired = Object.keys(sourceProperties).some(name => CREDENTIAL_PROPERTY_PATTERN.test(name));
      return {
        accountId,
        label: properties.account_label || accountId,
        connected: explicitStatus ? ['connected', 'true'].includes(explicitStatus) : hasCredential,
        credentialRequired,
        active: accountId === activeAccountId,
        revision: item.revision,
        properties,
      };
    }));
    this.host.requireGeneration(generation);
    return { integrationId, activeAccountId, accounts };
  }

  async setActiveIntegrationAccount(
    callerId: string, token: string | undefined, integrationId: string, accountId: string,
  ): Promise<import('../contracts.js').BrokerIntegrationMetadataResponse> {
    this.host.requireBrokerIdentity(callerId, token);
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(integrationId) || !/^[A-Za-z0-9._-]{1,128}$/.test(accountId)) {
      throw new LocalVaultError('invalid_operation', 400, 'Integration account identifier is invalid');
    }
    const keys = this.host.requireKeys();
    const generation = this.host.generation;
    const exists = await this.host.itemRepository.existsByIntegrationRefForActivation([keys.userId, `${ integrationId }/${ accountId }`]);
    this.host.requireGeneration(generation);
    if (!exists.rowCount) throw new LocalVaultError('invalid_operation', 404, 'Integration account is unavailable');
    await this.host.integrationStateRepository.upsert(keys.userId, integrationId, accountId);
    this.host.requireGeneration(generation);
    return this.host.integrationMetadata(callerId, token, integrationId);
  }

  /**
   * Create the empty account a first OAuth sign-in writes its tokens into.
   * oauth.exchange only updates an existing item, so without this a new
   * Codex/Grok sign-in had nowhere to land. Desktop identity only, built-in
   * OAuth integrations only, metadata only: no secret crosses this call.
   */
  async ensureOAuthAccount(
    callerId: string, token: string | undefined, integrationId: string, input: BrokerOAuthAccountRequest,
  ): Promise<import('../contracts.js').BrokerIntegrationMetadataResponse> {
    this.host.requireDesktopIdentity(callerId, token);
    const accountId = input?.accountId;
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(integrationId) || typeof accountId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(accountId)) {
      throw new LocalVaultError('invalid_operation', 400, 'Integration account identifier is invalid');
    }
    if (!isNativeOAuthIntegration(integrationId)) {
      throw new LocalVaultError('policy_denied', 403, 'Integration has no built-in OAuth sign-in');
    }
    const label = typeof input.label === 'string' && input.label.trim() ? input.label.trim().slice(0, 120) : accountId;
    const keys = this.host.requireKeys();
    const generation = this.host.generation;
    const integrationRef = `${ integrationId }/${ accountId }`;
    const exists = await this.host.itemRepository.existsByIntegrationRefForOAuth([keys.userId, integrationRef]);
    this.host.requireGeneration(generation);
    if (!exists.rowCount) {
      // Same default as the vault's guided Connect screen with "agents can use this" on.
      const policy = {
        mode: 'agents' as const, level: 'autofill' as const, agents: [], sites: [], expiresAt: null,
        askFirst: false, allowServerAgents: false,
      };
      const itemId = randomUUID();
      const plaintext: VaultItemPlaintext = {
        type: 'apiKey', name: label, agentPolicy: policy,
        integration: { integrationId, accountId, properties: { account_label: label } },
      };
      const encrypted = await this.host.sealItem(JSON.stringify(plaintext), keys.userKey, { itemId, ownerId: keys.userId });
      await this.host.runSecurityOperation(() => this.host.runTransaction(async client => {
        this.host.requireGeneration(generation);
        await this.host.itemRepository.insertOAuthAccount([itemId, keys.userId, encrypted.ciphertext, encrypted.encryptedItemKey, policy, integrationRef], client);
        await this.host.auditHumanAction(client, keys.userId, 'oauth_account_created', itemId, label);
        this.host.requireGeneration(generation);
      }));
    }
    return this.readIntegrationMetadata(integrationId, accountId);
  }

  /** Trusted Desktop handoff for credentials collected by first-run and Connect UI. */
  async importDesktopIntegrationAccount(
    callerId: string, token: string | undefined, integrationId: string, input: BrokerIntegrationAccountImportRequest,
  ): Promise<import('../contracts.js').BrokerIntegrationMetadataResponse> {
    this.host.requireDesktopIdentity(callerId, token);
    const accountId = String(input?.accountId ?? '').trim();
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(integrationId) || !/^[A-Za-z0-9._-]{1,128}$/.test(accountId)) {
      throw new LocalVaultError('invalid_operation', 400, 'Integration account identifier is invalid');
    }
    if (!input.values || typeof input.values !== 'object' || Array.isArray(input.values)) {
      throw new LocalVaultError('invalid_operation', 400, 'Integration account values are invalid');
    }
    const values: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const [property, value] of Object.entries(input.values)) {
      if (!/^[A-Za-z0-9._-]{1,128}$/.test(property) || typeof value !== 'string') {
        throw new LocalVaultError('invalid_operation', 400, 'Integration account value is invalid');
      }
      values[property] = value;
    }
    const label = typeof input.label === 'string' && input.label.trim()
      ? input.label.trim().slice(0, 120)
      : (values.account_label || accountId);
    values.account_label = label;
    if (input.connected !== undefined) values.connection_status = input.connected ? 'connected' : 'disconnected';

    const keys = this.host.requireKeys();
    const generation = this.host.generation;
    const integrationRef = `${ integrationId }/${ accountId }`;
    const existing = await this.host.itemRepository.findOwnedIntegrationAccount<ItemRow>([keys.userId, integrationRef]);
    this.host.requireGeneration(generation);
    const itemId = existing.rows[0]?.id ?? randomUUID();
    let plaintext: VaultItemPlaintext;
    if (existing.rowCount) {
      const row = existing.rows[0];
      plaintext = JSON.parse(await this.host.openItemText(
        { version: 1, ciphertext: row.ciphertext, encryptedItemKey: row.encrypted_item_key },
        keys.userKey, { itemId, ownerId: keys.userId },
      )) as VaultItemPlaintext;
      plaintext.integration ??= { integrationId, accountId, properties: {} };
      plaintext.integration.properties = { ...plaintext.integration.properties, ...values };
      plaintext.name = label;
    } else {
      const sites = trustedOriginsForIntegration(integrationId);
      if (['custom', 'azure-openai'].includes(integrationId) && (values.base_url || values.resource_url)) {
        try {
          const baseUrl = new URL(values.base_url || values.resource_url);
          const hostname = baseUrl.hostname.toLowerCase();
          const azureHost = integrationId !== 'azure-openai' || ['.openai.azure.com', '.services.ai.azure.com', '.cognitiveservices.azure.com'].some(suffix => hostname.endsWith(suffix));
          if (baseUrl.protocol === 'https:' && hostname && azureHost) sites.push(hostname);
        } catch { /* invalid base URLs are rejected when used; never grant a site here */ }
      }
      if (integrationId === 'vertex-ai' && values.region) {
        const region = values.region.toLowerCase();
        if (/^[a-z]+-[a-z]+\d$/.test(region)) sites.push(`${ region }-aiplatform.googleapis.com`);
      }
      const policy = {
        mode: 'agents' as const, level: 'autofill' as const, agents: [], sites: [...new Set(sites)],
        expiresAt: null, askFirst: false, allowServerAgents: false,
      };
      plaintext = {
        type: 'apiKey', name: label, agentPolicy: policy,
        integration: { integrationId, accountId, properties: values },
      };
    }
    const encrypted = await this.host.sealItem(JSON.stringify(plaintext), keys.userKey, { itemId, ownerId: keys.userId });
    await this.host.runSecurityOperation(() => this.host.runTransaction(async client => {
      this.host.requireGeneration(generation);
      if (existing.rowCount) {
        const row = existing.rows[0];
        const updated = await this.host.itemRepository.updateIntegrationCiphertextIfRevision([encrypted.ciphertext, encrypted.encryptedItemKey, itemId, row.revision], client);
        if (!updated.rowCount) throw new LocalVaultError('invalid_operation', 409, 'Vault item changed; retry');
      } else {
        await this.host.itemRepository.insertIntegrationAccount([itemId, keys.userId, encrypted.ciphertext, encrypted.encryptedItemKey, plaintext.agentPolicy, integrationRef], client);
      }
      if (input.active !== false) {
        await this.host.integrationStateRepository.upsertImported(keys.userId, integrationId, accountId, client);
      }
      await this.host.auditHumanAction(client, keys.userId, existing.rowCount ? 'integration_account_updated' : 'integration_account_created', itemId, label);
    }));
    this.host.requireGeneration(generation);
    return this.readIntegrationMetadata(integrationId, accountId);
  }
}
