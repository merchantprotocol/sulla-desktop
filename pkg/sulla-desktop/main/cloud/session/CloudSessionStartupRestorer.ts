// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { VaultBrokerError } from '@pkg/vault-broker';

export interface CloudSessionRestoreBroker {
  status(): Promise<{ unlocked: boolean }>;
  integrationMetadata(integrationId: string): Promise<{
    activeAccountId?: string;
    accounts: Array<{ accountId: string; active?: boolean; connected: boolean }>;
  }>;
}

export interface RestoredCloudSessionIdentity {
  userId: string;
  activeContractorId: string;
  contractors: [];
}

export class VaultNotReadyError extends Error {}

export interface CloudSessionStartupRestorerDependencies {
  broker(): CloudSessionRestoreBroker;
  ensureLegacySessionAdopted(): Promise<void>;
  hasPendingCredential(): boolean;
  signInAgainMessage: string;
  setAdoptionError(message: string | undefined): void;
}

/** Restores only non-secret Cloud identity from the unlocked vault. */
export class CloudSessionStartupRestorer {
  constructor(private readonly dependencies: CloudSessionStartupRestorerDependencies) {}

  async restore(): Promise<RestoredCloudSessionIdentity | null> {
    const { broker, ensureLegacySessionAdopted, hasPendingCredential, signInAgainMessage, setAdoptionError } = this.dependencies;
    let metadata: Awaited<ReturnType<CloudSessionRestoreBroker['integrationMetadata']>>;
    try {
      const credentialBroker = broker();
      const status = await credentialBroker.status();
      if (!status.unlocked) throw new Error('vault is locked');
      await ensureLegacySessionAdopted();
      metadata = await credentialBroker.integrationMetadata('sulla-cloud');
    } catch (err) {
      const message = (err as Error)?.message || String(err);
      const code = (err as { code?: string; cause?: { code?: string } })?.code
        ?? (err as { cause?: { code?: string } })?.cause?.code;
      if ((err instanceof VaultBrokerError && (err.code === 'vault_locked' || err.status === 423))
        || ['ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET'].includes(code ?? '')
        || /locked|unavailable|timeout|timed out|not ready|starting|connection/i.test(message)) {
        throw new VaultNotReadyError(`vault not ready: ${ message }`);
      }
      throw err;
    }

    const active = metadata.accounts.find(account => account.accountId === metadata.activeAccountId && account.connected);
    const accountId = active?.accountId ?? metadata.accounts.find(account => account.active && account.connected)?.accountId;
    if (!accountId && hasPendingCredential()) {
      throw new VaultNotReadyError('vault not ready: the Sulla Cloud session is still being saved');
    }
    if (!accountId) {
      setAdoptionError(signInAgainMessage);
      return null;
    }
    setAdoptionError(undefined);
    return { userId: accountId, activeContractorId: accountId, contractors: [] };
  }
}
