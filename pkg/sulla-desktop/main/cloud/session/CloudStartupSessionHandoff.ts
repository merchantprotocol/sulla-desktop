// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { LocalVaultApprovalClient, LocalVaultBrokerClient } from '@pkg/vault-broker';

import type { CloudContractor } from '../account/ElectronCloudAccountTransport';
import { CloudSessionStartupRestorer, VaultNotReadyError } from './CloudSessionStartupRestorer';
import { CloudSessionRepository, type SessionIdentity } from './CloudSessionRepository';
import type { LegacyAdoptionOutcome, LegacyCloudSessionAdopter } from './LegacyCloudSessionAdopter';

export interface CloudStartupSessionHandoffPorts {
  usesContainerVault(): boolean;
  credentialBroker(): LocalVaultBrokerClient;
  approvalClient(): LocalVaultApprovalClient | null;
  findLegacyIntegrationSession(): Promise<Record<string, string> | null>;
  deleteLegacyIntegrationSession(): Promise<void>;
  /** True for the broker's "this vault cannot adopt a session" refusal. */
  isInvalidOperation(error: unknown): boolean;
  logger: { log(message: string): void };
}

/**
 * Startup restore of the signed-in Cloud session, plus the one-time handoff of a
 * session Desktop wrote before the container vault became the authority. Owns
 * the startup error the status shows ("Sign in to Sulla Cloud again.").
 */
export class CloudStartupSessionHandoff {
  static readonly SIGN_IN_AGAIN = 'Sign in to Sulla Cloud again.';

  private complete = false;
  private inFlight: Promise<void> | null = null;
  private error: string | undefined;

  constructor(
    private readonly sessions: CloudSessionRepository,
    private readonly adopter: LegacyCloudSessionAdopter,
    private readonly ports: CloudStartupSessionHandoffPorts,
  ) {}

  /** The last startup restore/adoption error, shown in the status until a restore succeeds. */
  lastError(): string | undefined {
    return this.error;
  }

  setLastError(message: string | undefined): void {
    this.error = message;
  }

  /**
   * Startup-restore variant of loadIdentity. getAccounts() swallows vault
   * errors and returns [] so settings stay usable while the vault boots — but
   * the vault container comes up minutes after Electron, and reading that []
   * as "signed out" skipped device heartbeat and the secure channel for the
   * whole app session (phone and Cloud dashboard saw the desktop as offline).
   * Here "vault not reachable/unlocked yet" throws so restore keeps waiting.
   */
  restoreIdentity(): Promise<SessionIdentity | null> {
    if (!this.ports.usesContainerVault()) return this.sessions.loadIdentity();
    const restorer = new CloudSessionStartupRestorer({
      broker:                    () => this.ports.credentialBroker(),
      ensureLegacySessionAdopted: () => this.ensureLegacySessionAdopted(),
      hasPendingCredential:      () => this.sessions.hasPending(),
      signInAgainMessage:        CloudStartupSessionHandoff.SIGN_IN_AGAIN,
      setAdoptionError:          (message) => { this.error = message; },
    });
    return restorer.restore();
  }

  /**
   * Adopt a session written by Desktop before the container vault became the
   * authority. The handoff runs at most once successfully per process; startup
   * retries it while Postgres/the vault are unavailable. Tokens never leave the
   * main process except for the existing fixed-purpose vault adoption call.
   */
  ensureLegacySessionAdopted(): Promise<void> {
    if (!this.ports.usesContainerVault() || this.complete) return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.adoptLegacySession().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async adoptLegacySession(): Promise<void> {
    const broker = this.ports.credentialBroker();
    const metadata = await broker.integrationMetadata(CloudSessionRepository.INTEGRATION_ID);
    if (metadata.activeAccountId || metadata.accounts.length > 0) {
      await this.ports.deleteLegacyIntegrationSession();
      this.complete = true;
      return;
    }

    const legacy = await this.ports.findLegacyIntegrationSession();
    const userId = legacy?.user_id;
    const refreshToken = legacy?.refresh_token;
    if (!legacy) {
      this.complete = true;
      return;
    }
    if (!userId || !refreshToken) {
      this.finishWithSignInAgain();
      return;
    }

    let adoption: LegacyAdoptionOutcome;
    try {
      adoption = await this.adopter.refresh({
        user_id: userId, active_contractor_id: legacy.active_contractor_id, access_token: legacy.access_token, refresh_token: refreshToken,
      });
    } catch (error) {
      throw new VaultNotReadyError(`cloud refresh unavailable: ${ (error as Error)?.message || error }`);
    }
    if (adoption.kind === 'rejected') {
      this.finishWithSignInAgain();
      return;
    }
    const tokens = adoption.tokens;

    let contractors: CloudContractor[] = [];
    try {
      contractors = legacy.contractors_json ? JSON.parse(legacy.contractors_json) as CloudContractor[] : [];
    } catch { /* use an empty list for legacy single-contractor sessions */ }
    const activeContractorId = legacy.active_contractor_id || userId;
    const client = this.ports.approvalClient();
    if (!client) throw new VaultNotReadyError('Desktop vault session service is unavailable');
    try {
      await client.adoptSullaCloudSession({
        userId, activeContractorId, contractors,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
      });
    } catch (error) {
      if (this.ports.isInvalidOperation(error)) {
        this.finishWithSignInAgain();
        return;
      }
      throw error;
    }
    await this.ports.deleteLegacyIntegrationSession();
    await this.sessions.clearLegacySettings();
    this.error = undefined;
    this.complete = true;
    this.ports.logger.log('[SullaCloudAuth] Adopted existing Sulla Cloud session into the container vault');
  }

  private finishWithSignInAgain(): void {
    this.error = CloudStartupSessionHandoff.SIGN_IN_AGAIN;
    this.complete = true;
  }
}
