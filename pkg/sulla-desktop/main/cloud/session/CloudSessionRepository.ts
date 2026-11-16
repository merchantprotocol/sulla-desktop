// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { IntegrationService } from '@pkg/agent/services/IntegrationService';
import type { PendingCredential } from '@pkg/main/firstRun/pendingCredentials';
import type { LocalVaultApprovalClient, LocalVaultBrokerClient } from '@pkg/vault-broker';

import type { CloudContractor, CloudSignInResponse } from '../account/ElectronCloudAccountTransport';

export interface StoredTokens {
  accessToken:  string;
  refreshToken: string;
}

/**
 * Normalized sign-in result. Maps both today's `contractor`-only server response
 * and the future `{userId, contractors[]}` response into the same shape.
 */
export interface CloudSession {
  userId:             string;            // Stable identity — used for relay pairing
  activeContractorId: string;            // Currently selected business
  contractors:        CloudContractor[]; // All businesses this user can access (today: 1)
  tokens:             StoredTokens;
}

export type SessionIdentity = Pick<CloudSession, 'userId' | 'activeContractorId' | 'contractors'>;

/** The app pieces the repository reads and writes. Wired to the real modules by SullaCloudAuthServiceProvider. */
export interface CloudSessionStoragePorts {
  usesContainerVault(): boolean;
  approvalClient(): LocalVaultApprovalClient | null;
  credentialBroker(): LocalVaultBrokerClient;
  integrations(): IntegrationService;
  pendingCredential(integrationId: string): PendingCredential | undefined;
  queuePendingCredential(entry: PendingCredential): Promise<void>;
  clearPendingCredential(integrationId: string): Promise<void>;
  deleteLegacyIntegrationSession(): Promise<void>;
  deleteSetting(key: string): Promise<unknown>;
  vaultLockedError(): Error;
}

/**
 * Where the Sulla Cloud session lives: the container vault (default), the
 * vault-encrypted `sulla-cloud` integration account (server mode), or the
 * first-run in-memory pending credential queue. Storage keys and formats are
 * unchanged from the procedural sullaCloudAuth.ts.
 */
export class CloudSessionRepository {
  static readonly INTEGRATION_ID = 'sulla-cloud';
  /** Legacy setting keys from the safeStorage era, cleared on every save/clear. */
  static readonly LEGACY_SETTING_KEYS: readonly string[] = ['sullaCloudTokensEncrypted', 'sullaCloudUserId', 'sullaCloudPhone'];

  constructor(private readonly ports: CloudSessionStoragePorts) {}

  static fromSignIn(data: CloudSignInResponse): CloudSession {
    const contractors = data.contractors?.length ? data.contractors : [data.contractor];
    return {
      userId:             data.userId ?? data.contractor.id,
      activeContractorId: data.contractor.id,
      contractors,
      tokens:             {
        accessToken:  data.accessToken,
        refreshToken: data.refreshToken,
      },
    };
  }

  pending(): PendingCredential | undefined {
    return this.ports.pendingCredential(CloudSessionRepository.INTEGRATION_ID);
  }

  hasPending(): boolean {
    return !!this.pending();
  }

  clearPending(): Promise<void> {
    return this.ports.clearPendingCredential(CloudSessionRepository.INTEGRATION_ID);
  }

  /** Holds the session only in main-process memory until the vault can adopt it (first run). */
  queuePending(session: CloudSession): Promise<void> {
    return this.ports.queuePendingCredential({
      integrationId: CloudSessionRepository.INTEGRATION_ID,
      accountId:     session.userId,
      activate:      true,
      values: {
        access_token:         session.tokens.accessToken,
        refresh_token:        session.tokens.refreshToken,
        user_id:              session.userId,
        active_contractor_id: session.activeContractorId,
        contractors_json:     JSON.stringify(session.contractors),
      },
    });
  }

  async save(session: CloudSession): Promise<void> {
    if (this.ports.usesContainerVault()) {
      const client = this.ports.approvalClient();
      if (!client) throw new Error('Desktop vault session service is unavailable');
      await client.adoptSullaCloudSession({
        userId: session.userId, activeContractorId: session.activeContractorId,
        contractors: session.contractors, accessToken: session.tokens.accessToken,
        refreshToken: session.tokens.refreshToken,
      });
      await this.clearLegacySettings();
      return;
    }
    const svc = this.ports.integrations();
    const id = CloudSessionRepository.INTEGRATION_ID;
    const accountId = session.userId;

    await svc.setMultipleValues([
      { integration_id: id, account_id: accountId, property: 'access_token', value: session.tokens.accessToken },
      { integration_id: id, account_id: accountId, property: 'refresh_token', value: session.tokens.refreshToken },
      { integration_id: id, account_id: accountId, property: 'user_id', value: session.userId },
      { integration_id: id, account_id: accountId, property: 'active_contractor_id', value: session.activeContractorId },
      { integration_id: id, account_id: accountId, property: 'contractors_json', value: JSON.stringify(session.contractors) },
    ]);
    await svc.setConnectionStatus(id, true, accountId);

    // Clear any legacy settings left over from the safeStorage era.
    await this.clearLegacySettings();

    // Device registration, heartbeat, secure channel and any opted-in sync
    // are started by cloudLifecycle.startCloudServices() on sign-in/restore,
    // not here — save also runs on every token refresh.
  }

  /** Token refresh write-back: a pending first-run session goes back to the queue, anything else to storage. */
  async saveRefreshed(session: CloudSession): Promise<void> {
    if (!this.hasPending()) {
      await this.save(session);
      return;
    }
    await this.queuePending(session);
  }

  async load(): Promise<CloudSession | null> {
    const queued = this.pending();
    if (queued) {
      return {
        userId: queued.values.user_id,
        activeContractorId: queued.values.active_contractor_id,
        contractors: JSON.parse(queued.values.contractors_json || '[]'),
        tokens: { accessToken: queued.values.access_token, refreshToken: queued.values.refresh_token },
      };
    }
    const id = CloudSessionRepository.INTEGRATION_ID;
    const svc = this.ports.integrations();
    const accounts = await svc.getAccounts(id);
    if (accounts.length === 0) return null;

    // We only ever have one signed-in user account; use the first (active) one.
    const accountId = accounts.find(a => a.active)?.account_id ?? accounts[0].account_id;

    const [accessTokenV, refreshTokenV, userIdV, activeContractorIdV, contractorsJsonV] = await Promise.all([
      svc.getIntegrationValue(id, 'access_token', accountId),
      svc.getIntegrationValue(id, 'refresh_token', accountId),
      svc.getIntegrationValue(id, 'user_id', accountId),
      svc.getIntegrationValue(id, 'active_contractor_id', accountId),
      svc.getIntegrationValue(id, 'contractors_json', accountId),
    ]);

    if (!accessTokenV?.value || !userIdV?.value) return null;

    let contractors: CloudContractor[] = [];
    try {
      contractors = contractorsJsonV?.value ? JSON.parse(contractorsJsonV.value) as CloudContractor[] : [];
    } catch {
      contractors = [];
    }

    return {
      userId:             userIdV.value,
      activeContractorId: activeContractorIdV?.value || userIdV.value,
      contractors,
      tokens:             {
        accessToken:  accessTokenV.value,
        refreshToken: refreshTokenV?.value ?? '',
      },
    };
  }

  /**
   * Non-secret session identity. Under the container vault the app may read
   * only account metadata (tokens stay in the vault), so the identity comes
   * from the account id, which save() keys by userId.
   */
  async loadIdentity(): Promise<SessionIdentity | null> {
    const queued = this.pending();
    if (queued) {
      return {
        userId:             queued.values.user_id,
        activeContractorId: queued.values.active_contractor_id,
        contractors:        JSON.parse(queued.values.contractors_json || '[]'),
      };
    }
    if (!this.ports.usesContainerVault()) {
      const session = await this.load();
      return session ? { userId: session.userId, activeContractorId: session.activeContractorId, contractors: session.contractors } : null;
    }
    const broker = this.ports.credentialBroker();
    const status = await broker.status();
    if (!status.unlocked) throw this.ports.vaultLockedError();
    const metadata = await broker.integrationMetadata(CloudSessionRepository.INTEGRATION_ID);
    const active = metadata.accounts.find(account => account.accountId === metadata.activeAccountId && account.connected);
    const accountId = active?.accountId ?? metadata.accounts.find(account => account.active && account.connected)?.accountId;
    if (!accountId) return null;
    // Today userId === activeContractorId (single-contractor server response).
    return { userId: accountId, activeContractorId: accountId, contractors: [] };
  }

  async clear(): Promise<void> {
    if (this.ports.usesContainerVault()) {
      const client = this.ports.approvalClient();
      if (!client) throw new Error('Desktop vault session service is unavailable');
      await client.clearSullaCloudSession();
      await this.ports.deleteLegacyIntegrationSession();
      await this.clearLegacySettings();
      return;
    }
    const svc = this.ports.integrations();
    const accounts = await svc.getAccounts(CloudSessionRepository.INTEGRATION_ID);
    for (const acc of accounts) {
      await svc.deleteAccount(CloudSessionRepository.INTEGRATION_ID, acc.account_id);
    }
    await this.clearLegacySettings();
  }

  async clearLegacySettings(): Promise<void> {
    try {
      for (const key of CloudSessionRepository.LEGACY_SETTING_KEYS) await this.ports.deleteSetting(key);
    } catch { /* ignore */ }
  }
}
