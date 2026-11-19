// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { VaultItemPlaintext } from '@sulla/vault-crypto';

import type { BrokerExecuteRequest } from '../contracts.js';
import { CHATGPT_ACCOUNT_ID_PATTERN, CHATGPT_AUTH_CLAIM, CREDENTIAL_PROPERTY_PATTERN, MAX_CREDENTIAL_BYTES } from './LocalAuthorityLimits.js';

/**
 * Reads credential values out of a decrypted vault item, derives routing metadata from
 * tokens, redacts secrets from text and filters integration metadata down to safe fields.
 * Moved verbatim from localAuthority.ts (E9). Static methods never use `this`.
 */
export class BrokerCredentialFields {
  static readonly SAFE_INTEGRATION_METADATA_FIELDS: ReadonlySet<string> = new Set([
    'account_label', 'connection_status', 'connected_at', 'last_sync_at', 'base_url', 'server_url',
    'gateway_url', 'resource_url', 'project_id', 'provider', 'provider_id', 'model', 'workspace_id', 'region', 'plan', 'llm_access', 'client_id', 'oauth_client_id',
    'expires_at', 'token_type', 'scope',
  ]);

  static extractBoundedChatgptAccountId(...tokens: unknown[]): string | undefined {
    for (const token of tokens) {
      if (typeof token !== 'string' || token.length > MAX_CREDENTIAL_BYTES) continue;
      const parts = token.split('.');
      if (parts.length !== 3 || !parts[1]) continue;
      try {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as unknown;
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) continue;
        const auth = (payload as Record<string, unknown>)[CHATGPT_AUTH_CLAIM];
        if (!auth || typeof auth !== 'object' || Array.isArray(auth)) continue;
        const accountId = (auth as Record<string, unknown>).chatgpt_account_id;
        if (typeof accountId === 'string' && accountId.trim() === accountId && CHATGPT_ACCOUNT_ID_PATTERN.test(accountId)) {
          return accountId;
        }
      } catch { /* malformed tokens do not produce routing metadata */ }
    }
    return undefined;
  }

  static safeIntegrationMetadata(
    source: Record<string, unknown>,
    integrationId = '',
  ): Record<string, string> {
    const secrets = Object.entries(source)
      .filter(([name, value]) => CREDENTIAL_PROPERTY_PATTERN.test(name) && typeof value === 'string' && value.length > 0)
      .map(([, value]) => value as string);
    const output: Record<string, string> = {};
    for (const [name, value] of Object.entries(source)) {
      if (!BrokerCredentialFields.SAFE_INTEGRATION_METADATA_FIELDS.has(name) || typeof value !== 'string') continue;
      if (name === 'base_url' || name === 'server_url' || name === 'gateway_url' || name === 'resource_url') {
        try {
          const parsed = new URL(value);
          if (parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.protocol !== 'https:' && !(name === 'base_url' && ['ollama', 'lm-studio', 'local-server'].includes(integrationId) && parsed.protocol === 'http:'))) continue;
          if (name === 'gateway_url') {
            output[name] = parsed.origin;
            continue;
          }
        } catch { continue; }
      }
      output[name] = BrokerCredentialFields.redact(value, secrets);
    }
    return output;
  }

  static credentialField(item: VaultItemPlaintext, field: string): string | undefined {
    return item.integration?.properties?.[field] ??
      (field === 'username' ? item.username : undefined) ??
      (['password', 'api_key', 'bearer_token', 'api_token', 'access_token', 'auth_token', 'token'].includes(field)
        ? item.password
        : undefined) ??
      item.fields?.find(candidate => candidate.name === field)?.value ??
      // Custom fields are usable by label at the same autofill level as the password; lowest priority.
      item.customFields?.find(candidate => candidate.label === field && typeof candidate.value === 'string')?.value;
  }

  static proxySource(item: VaultItemPlaintext, source: string): string | undefined {
    if (source === 'password') return item.password;
    if (source === 'username') return item.username;
    if (!source.startsWith('custom:')) return undefined;
    const name = source.slice(7);
    return item.fields?.find(candidate => candidate.name === name)?.value ??
      item.customFields?.find(candidate => candidate.label === name)?.value;
  }

  static proxyHostMatches(host: string, allowed: string): boolean {
    const normalized = allowed.toLowerCase().replace(/^\*\./, '');
    return host === normalized || (allowed.startsWith('*.') && host.endsWith(`.${ normalized }`));
  }

  static deriveChatgptAccountRoutingForRequest(
    input: Pick<BrokerExecuteRequest, 'operation' | 'ref'>,
    plaintext: VaultItemPlaintext,
  ): void {
    if (!['provider.cli', 'provider.models'].includes(input.operation) || input.ref.integrationId !== 'codex') return;
    const properties = plaintext.integration?.properties;
    if (!properties || properties.chatgpt_account_id) return;
    const accountId = BrokerCredentialFields.extractBoundedChatgptAccountId(properties.id_token, properties.access_token);
    if (accountId) properties.chatgpt_account_id = accountId;
  }

  static redact(value: string, secrets: string[]): string {
    let next = value;
    for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) {
      next = next.split(secret).join('[REDACTED]');
    }
    return next;
  }
}
