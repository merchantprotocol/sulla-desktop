// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { IntegrationService } from '@pkg/agent/services/IntegrationService';

import type { AuthStatus, CloudAuthStatusService } from './CloudAuthStatusService';
import type { DesktopSignOutOutcome } from './DesktopCloudSignOut';

export interface CloudSignOutPorts {
  usesContainerVault(): boolean;
  integrations(): IntegrationService;
  pairRelay(userId: string): Promise<void>;
  stopCloudServices(): Promise<void>;
  /** Approved browsers/phones belong to the signed-out account. */
  removeApprovedClients(): Promise<void>;
  stopHeartbeat(): void;
  logger: { log(message: string): void; warn(message: string, detail?: unknown): void };
}

/** Runs the local-first Cloud sign-out (DesktopCloudSignOut). */
export interface CloudSignOutRunner {
  run(): Promise<DesktopSignOutOutcome>;
}

/**
 * `sulla-cloud:logout`: sign out, then tear down what belongs to the session
 * (Apple record, relay pairing, Cloud services, approved clients, heartbeat).
 */
export class CloudSignOutService {
  constructor(
    private readonly signOut: CloudSignOutRunner,
    private readonly status: CloudAuthStatusService,
    private readonly ports: CloudSignOutPorts,
  ) {}

  async logout(): Promise<AuthStatus> {
    const { logger } = this.ports;
    const outcome = await this.signOut.run();
    if (!outcome.signedOut) {
      logger.warn('[SullaCloudAuth] Could not remove the Sulla Cloud account:', outcome.error);
      // The local clear is the authority. If it fails (nothing was revoked), keep
      // Desktop paired and Cloud services running so both sides still describe one session.
      return this.status.build(this.status.vaultSessionError(outcome.error, 'sign out'));
    }
    if (outcome.serverRevoked === false) {
      logger.warn('[SullaCloudAuth] Signed out locally; Sulla Cloud could not revoke the session now, so it will expire on its own');
    }
    try {
      // Also disconnect the apple_signin vault record so it no longer shows
      // as connected. Deletes all Apple accounts for this user.
      if (!this.ports.usesContainerVault()) {
        const svc = this.ports.integrations();
        const appleAccounts = await svc.getAccounts('apple_signin');
        for (const acc of appleAccounts) {
          await svc.deleteAccount('apple_signin', acc.account_id);
        }
      }
    } catch (err) {
      logger.warn('[SullaCloudAuth] Failed to clear apple_signin accounts:', err);
    }
    try {
      await this.ports.pairRelay('');
    } catch { /* ignore */ }
    try {
      await this.ports.stopCloudServices();
      await this.ports.removeApprovedClients();
    } catch (err) {
      logger.warn('[SullaCloudAuth] Failed to stop cloud services:', err);
    }
    this.ports.stopHeartbeat();
    logger.log('[SullaCloudAuth] Signed out');
    return this.status.build();
  }
}
