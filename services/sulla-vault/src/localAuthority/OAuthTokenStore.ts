// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { Queryable } from '../db.js';
import type { LocalAuthorityHost } from './LocalAuthorityHost.js';
import { MAX_CREDENTIAL_BYTES } from './LocalAuthorityLimits.js';
import type { PreparedBrokerRequest, UnlockedKeys } from './LocalAuthorityTypes.js';
import { LocalVaultError } from './LocalVaultError.js';
import { BrokerCredentialFields } from './BrokerCredentialFields.js';

/**
 * Persists OAuth results into the integration item: token sets, dynamic client registration,
 * revocation, and the non-secret summary returned to the caller.
 * Moved verbatim from LocalVaultAuthority (E9); vault state lives on the host.
 */
export class OAuthTokenStore {
  constructor(private readonly host: LocalAuthorityHost) {}

  async storeOAuthTokens(prepared: PreparedBrokerRequest, body: unknown, db: Queryable): Promise<void> {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new LocalVaultError('invalid_upstream_response', 502, 'OAuth token response is invalid');
    }
    const response = body as Record<string, unknown>;
    if (typeof response.access_token !== 'string' || !response.access_token) {
      throw new LocalVaultError('invalid_upstream_response', 502, 'OAuth response did not contain an access token');
    }
    const keys = this.host.requireKeys();
    this.host.requireGeneration(prepared.generation);
    if (!prepared.item || !prepared.plaintext) throw new LocalVaultError('migration_failed', 409, 'OAuth credential item is unavailable');
    const integration = prepared.plaintext.integration;
    if (!integration) throw new LocalVaultError('migration_failed', 409, 'OAuth item is missing its integration reference');
    integration.properties.access_token = response.access_token;
    if (typeof response.refresh_token === 'string' && response.refresh_token) integration.properties.refresh_token = response.refresh_token;
    if (typeof response.expires_in === 'number') integration.properties.expires_in = String(response.expires_in);
    if (typeof response.expires_in === 'number') integration.properties.expires_at = String(Date.now() + Math.max(0, response.expires_in) * 1000);
    if (typeof response.scope === 'string') integration.properties.scope = response.scope;
    if (typeof response.token_type === 'string') integration.properties.token_type = response.token_type;
    if (typeof response.id_token === 'string' && response.id_token) integration.properties.id_token = response.id_token;
    const chatgptAccountId = BrokerCredentialFields.extractBoundedChatgptAccountId(response.id_token, response.access_token);
    if (chatgptAccountId) integration.properties.chatgpt_account_id = chatgptAccountId;
    prepared.item.revision = await this.persistOAuthItem(prepared, keys, db);
  }

  async storeOAuthRegistration(prepared: PreparedBrokerRequest, body: unknown, db: Queryable): Promise<string> {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new LocalVaultError('invalid_upstream_response', 502, 'OAuth registration response is invalid');
    }
    const response = body as Record<string, unknown>;
    if (typeof response.client_id !== 'string' || response.client_id.length < 1 || response.client_id.length > 4096) {
      throw new LocalVaultError('invalid_upstream_response', 502, 'OAuth registration response did not contain a valid client identity');
    }
    const keys = this.host.requireKeys();
    this.host.requireGeneration(prepared.generation);
    if (!prepared.item || !prepared.plaintext?.integration) {
      throw new LocalVaultError('migration_failed', 409, 'OAuth credential item is unavailable');
    }
    prepared.plaintext.integration.properties.oauth_client_id = response.client_id;
    for (const field of ['client_secret', 'registration_access_token'] as const) {
      const value = response[field];
      if (value !== undefined && (typeof value !== 'string' || !value || Buffer.byteLength(value) > MAX_CREDENTIAL_BYTES)) {
        throw new LocalVaultError('invalid_upstream_response', 502, 'OAuth registration response contained invalid secret material');
      }
      if (typeof value === 'string') prepared.plaintext.integration.properties[field] = value;
    }
    prepared.item.revision = await this.persistOAuthItem(prepared, keys, db);
    return response.client_id;
  }

  async clearOAuthTokens(prepared: PreparedBrokerRequest, db: Queryable): Promise<void> {
    const keys = this.host.requireKeys();
    this.host.requireGeneration(prepared.generation);
    if (!prepared.item || !prepared.plaintext?.integration) {
      throw new LocalVaultError('migration_failed', 409, 'OAuth credential item is unavailable');
    }
    for (const field of ['access_token', 'refresh_token', 'id_token', 'chatgpt_account_id', 'expires_in', 'expires_at', 'scope', 'token_type']) {
      delete prepared.plaintext.integration.properties[field];
    }
    prepared.item.revision = await this.persistOAuthItem(prepared, keys, db);
  }

  private async persistOAuthItem(
    prepared: Pick<PreparedBrokerRequest, 'item' | 'plaintext' | 'generation'>, keys: UnlockedKeys,
    db: Queryable,
  ): Promise<number> {
    if (!prepared.item || !prepared.plaintext) throw new LocalVaultError('migration_failed', 409, 'OAuth credential item is unavailable');
    const ownerId = prepared.item.collection_id ?? prepared.item.owner_user_id ?? keys.userId;
    const encrypted = await this.host.sealItem(JSON.stringify(prepared.plaintext), keys.userKey, {
      itemId: prepared.item.id,
      ownerId,
    });
    this.host.requireGeneration(prepared.generation);
    const updated = await this.host.itemRepository.updateOAuthCiphertextIfRevision([encrypted.ciphertext, encrypted.encryptedItemKey, prepared.item.id, prepared.item.revision], db);
    if (!updated.rowCount) throw new LocalVaultError('migration_failed', 409, 'OAuth item changed during token update');
    this.host.requireGeneration(prepared.generation);
    return Number(updated.rows[0].revision);
  }

  sanitizeOAuthResult(operation: string, body: unknown): Record<string, unknown> {
    const response = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
    return {
      updated:    true,
      operation,
      expires_in: typeof response.expires_in === 'number' ? response.expires_in : undefined,
      expires_at: typeof response.expires_in === 'number' ? Date.now() + Math.max(0, response.expires_in) * 1000 : undefined,
      scope:      typeof response.scope === 'string' ? response.scope : undefined,
      token_type: typeof response.token_type === 'string' ? response.token_type : undefined,
    };
  }
}
