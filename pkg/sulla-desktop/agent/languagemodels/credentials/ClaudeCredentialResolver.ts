// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { usesContainerVaultAuthority, type ProviderCliBridgeLease } from '../../../vault-broker';
import { SullaSettingsModel } from '../../database/models/SullaSettingsModel';
import { getIntegrationService } from '../../services/IntegrationService';
import { createGuestClaudeAuth } from '../guestClaudeBridge';

import type { BaseThreadState } from '../../nodes/Graph';

export type ClaudeCredentialSource = 'pending-memory' | 'vault-broker' | 'integration-vault' | 'legacy-settings' | 'none';

interface ClaudeCredentialBase {
  accountId: string | null;
  source:    ClaudeCredentialSource;
  workspaceId?: string;
}

export type ClaudeCredentialResult =
  | (ClaudeCredentialBase & { kind: 'oauth-capability'; oauthToken?: string; baseUrl?: string; lease?: ProviderCliBridgeLease })
  | (ClaudeCredentialBase & { kind: 'oauth-pending'; oauthToken: string })
  | (ClaudeCredentialBase & { kind: 'api-key'; apiKey: string; baseUrl?: string; lease?: ProviderCliBridgeLease })
  | (ClaudeCredentialBase & { kind: 'none'; unavailable?: boolean });

export interface ClaudeCredentialResolveOptions {
  /** Mint an opaque, process-scoped broker capability. Catalog/status callers leave this false. */
  execution?:      boolean;
  conversationId?: string;
  state?:          BaseThreadState;
}

/** The only precedence and account-selection policy for Claude credentials. */
export class ClaudeCredentialResolver {
  async resolve(options: ClaudeCredentialResolveOptions = {}): Promise<ClaudeCredentialResult> {
    try {
      const { getPendingCredential } = await import('../../../main/firstRun/pendingCredentials');
      const pending = getPendingCredential('claude-code');
      const oauthToken = pending?.values.oauth_token || pending?.values.access_token || '';
      const apiKey = pending?.values.api_key || '';
      const accountId = pending?.accountId || 'oauth';
      const workspaceId = pending?.values.workspace_id?.trim() || undefined;
      if (oauthToken) return { kind: 'oauth-pending', accountId, source: 'pending-memory', oauthToken, workspaceId };
      if (apiKey) return { kind: 'api-key', accountId, source: 'pending-memory', apiKey, workspaceId };
    } catch { /* first-run custody only exists in the main process */ }

    const integrations = getIntegrationService();
    if (usesContainerVaultAuthority()) {
      try {
        const accounts = await integrations.getAccounts('claude-code');
        const activeId = await integrations.getActiveAccountId('claude-code');
        const account = accounts.find(candidate => candidate.account_id === activeId && candidate.connected)
          ?? accounts.find(candidate => candidate.connected);
        if (!account) return { kind: 'none', accountId: activeId, source: 'vault-broker' };
        const metadata = await integrations.getMetadataValues('claude-code', account.account_id);
        const workspaceId = metadata.find(value => value.property === 'workspace_id')?.value.trim() || undefined;
        if (!options.execution) {
          return account.account_id === 'oauth'
            ? { kind: 'oauth-capability', accountId: account.account_id, source: 'vault-broker', workspaceId }
            : { kind: 'api-key', accountId: account.account_id, source: 'vault-broker', apiKey: '', workspaceId };
        }
        const bridge = await createGuestClaudeAuth({
          conversationId: options.conversationId ?? `claude-${ Date.now() }`,
          state:          options.state,
        });
        if (bridge) {
          return bridge.oauthToken
            ? { kind: 'oauth-capability', accountId: account.account_id, source: 'vault-broker', oauthToken: bridge.oauthToken, baseUrl: bridge.baseUrl, lease: bridge.lease, workspaceId }
            : { kind: 'api-key', accountId: account.account_id, source: 'vault-broker', apiKey: bridge.apiKey, baseUrl: bridge.baseUrl, lease: bridge.lease, workspaceId };
        }
      } catch {
        // A locked/unavailable authority is not permission to read stale legacy secrets.
        return { kind: 'none', accountId: null, source: 'vault-broker', unavailable: true };
      }
      return { kind: 'none', accountId: null, source: 'vault-broker' };
    }

    try {
      const accountId = await integrations.getActiveAccountId('claude-code').catch(() => 'default');
      const values = await integrations.getFormValues('claude-code', accountId);
      const oauthToken = values.find(value => value.property === 'oauth_token')?.value || '';
      const apiKey = values.find(value => value.property === 'api_key')?.value || '';
      const workspaceId = values.find(value => value.property === 'workspace_id')?.value.trim() || undefined;
      if (oauthToken) return { kind: 'oauth-capability', accountId, source: 'integration-vault', oauthToken, workspaceId };
      if (apiKey) return { kind: 'api-key', accountId, source: 'integration-vault', apiKey, workspaceId };
    } catch { /* migrate-era settings fallback below */ }

    const oauthToken = (await SullaSettingsModel.get('claudeOAuthToken', '')) ?? '';
    const apiKey = (await SullaSettingsModel.get('claudeApiKey', '')) ?? '';
    if (oauthToken) return { kind: 'oauth-capability', accountId: 'oauth', source: 'legacy-settings', oauthToken };
    if (apiKey) return { kind: 'api-key', accountId: 'default', source: 'legacy-settings', apiKey };
    return { kind: 'none', accountId: null, source: 'none' };
  }
}

export const claudeCredentialResolver = new ClaudeCredentialResolver();
