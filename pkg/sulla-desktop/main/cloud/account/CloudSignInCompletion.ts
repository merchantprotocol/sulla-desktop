// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { AuthResult, CloudAuthStatusService } from '../session/CloudAuthStatusService';
import { CloudSessionRepository } from '../session/CloudSessionRepository';
import type { CloudAccountWrapService } from './CloudAccountWrapService';
import type { CloudSignInResponse } from './ElectronCloudAccountTransport';

export interface CloudSignInCompletionPorts {
  usesContainerVault(): boolean;
  /** Metadata-only enrollment gate (DesktopVaultEnrollment.coordinator.gate). */
  enrollmentGate(): Promise<string>;
  /** Tells the owner this computer waits for approval (an OK-only message box). */
  showApprovalWait(message: string): Promise<void>;
  pairRelay(userId: string): Promise<void>;
  startCloudServices(): Promise<void>;
  onboardingComplete(): boolean;
  /** The lifecycle vault is unlocked and its service reports ready. */
  vaultReady(): boolean;
  /** The vault container's own status; throws while it is not running. */
  containerVaultStatus(): Promise<{ unlocked: boolean; setupRequired?: boolean }>;
  trace(area: 'vault' | 'account', message: string, details?: Record<string, unknown>): void;
  logger: { log(message: string): void; warn(message: string, detail?: unknown): void; error(message: string, detail?: unknown): void };
  sleep(ms: number): Promise<void>;
  now(): number;
}

/** The server-mode refresh gate a new session reopens. */
export interface SignedInSessionGate {
  adopted(): void;
}

/**
 * The shared success path of every sign-in method: persist the session (vault,
 * integration store, or first-run memory), gate Cloud services on vault
 * enrollment, pair the relay, and answer with the new status.
 */
export class CloudSignInCompletion {
  static readonly NOT_READY = 'Sulla is still starting up. Wait a minute, then try again.';

  constructor(
    private readonly sessions: CloudSessionRepository,
    private readonly gate: SignedInSessionGate,
    private readonly status: CloudAuthStatusService,
    private readonly wrap: CloudAccountWrapService,
    private readonly ports: CloudSignInCompletionPorts,
  ) {}

  /** First run cannot assume the vault, Postgres, or Redis exists: keep the session in memory until the vault is ready. */
  keepInMemory(): boolean {
    if (!this.ports.onboardingComplete()) return true;
    return !this.ports.vaultReady();
  }

  forCurrentState(data: CloudSignInResponse, notReadyError: string): Promise<AuthResult> {
    return this.keepInMemory() ? this.completeFirstRun(data) : this.completeWhenReady(data, notReadyError);
  }

  /** Shared success path: persist session, gate vault creation, auto-pair relay, return status. */
  async complete(data: CloudSignInResponse): Promise<AuthResult> {
    const session = CloudSessionRepository.fromSignIn(data);
    try {
      await this.sessions.save(session);
      // A sign-out closed the refresh gate; this new session must refresh again.
      this.gate.adopted();
    } catch (err) {
      if (!this.ports.usesContainerVault()) throw err;
      const error = this.status.vaultSessionError(err, 'sign in');
      this.ports.logger.warn('[SullaCloudAuth] Could not save the Sulla Cloud session:', error);
      return { ok: false, error, status: await this.status.buildOrSignedOut(error) };
    }
    const mayStartCloudServices = await this.enrollmentAllowsCloudServices();
    try {
      // Relay room is the stable userId, not the active contractor — so
      // switching businesses later doesn't drop the mobile connection.
      await this.ports.pairRelay(session.userId);
    } catch (err) {
      this.ports.logger.warn('[SullaCloudAuth] Auto-pair failed:', err);
    }
    if (mayStartCloudServices) try {
      // Always connected while signed in: device registration + secure
      // channel, plus whichever syncs the owner opted into.
      await this.ports.startCloudServices();
    } catch (err) {
      this.ports.logger.warn('[SullaCloudAuth] Failed to start cloud services:', err);
    }
    this.ports.logger.log(`[SullaCloudAuth] Signed in — user=${ session.userId }, active contractor=${ session.activeContractorId }`);
    return { ok: true, status: await this.status.build() };
  }

  // First run cannot assume the vault, Postgres, or Redis exists. Keep the
  // authenticated session only in main-process memory and let the vault
  // lifecycle flush it after the owner creates and unlocks their vault.
  async completeFirstRun(data: CloudSignInResponse): Promise<AuthResult> {
    const session = CloudSessionRepository.fromSignIn(data);
    await this.sessions.queuePending(session);
    this.gate.adopted();
    const mayStartCloudServices = await this.enrollmentAllowsCloudServices();
    try { await this.ports.pairRelay(session.userId) } catch (err) { this.ports.logger.warn('[SullaCloudAuth] Auto-pair failed:', err) }
    if (mayStartCloudServices) try {
      await this.ports.startCloudServices();
    } catch (err) { this.ports.logger.warn('[SullaCloudAuth] Failed to start cloud services:', err) }
    return { ok: true, status: await this.status.buildOrSignedOut() };
  }

  // On first run the VM's Postgres may still be booting, so saving the session
  // can fail for a while. Keep trying for up to ~2 minutes before giving up.
  async completeWhenReady(data: CloudSignInResponse, notReadyError: string): Promise<AuthResult> {
    const deadline = this.ports.now() + 120_000;
    for (let delay = 2_000; ; delay = Math.min(delay * 2, 15_000)) {
      try {
        const result = await this.complete(data);
        if (result.ok) return result;
        if (this.ports.now() + delay > deadline) return { ...result, error: notReadyError };
        await this.ports.sleep(delay);
      } catch (err) {
        if (this.ports.now() + delay > deadline) {
          this.ports.logger.warn('[SullaCloudAuth] Could not save the Sulla Cloud session:', err);
          return { ok: false, error: notReadyError, status: await this.status.build().catch(() => ({} as any)) };
        }
        await this.ports.sleep(delay);
      }
    }
  }

  async needsOldVaultPasswordMigration(sessionInMemory: boolean): Promise<boolean> {
    if (!this.ports.usesContainerVault() || sessionInMemory) return false;
    try {
      const status = await this.ports.containerVaultStatus();
      return status.setupRequired === false && !status.unlocked;
    } catch { return false }
  }

  /** `sulla-cloud:first-run-session`: what the first-run wizard holds in memory. */
  async firstRunSession() {
    let oldVaultLocked = false;
    try {
      const status = await this.ports.containerVaultStatus();
      oldVaultLocked = status.setupRequired === false && !status.unlocked;
    } catch { /* the vault may not be running yet */ }
    const queued = this.sessions.pending();
    return {
      sessionInMemory: !!queued,
      masterKeyRetained: this.wrap.hasPendingKey(),
      email: queued?.values.email || queued?.values.contractors_json && JSON.parse(queued.values.contractors_json || '[]')[0]?.email || undefined,
      oldVaultLocked,
    };
  }

  /** `sulla-cloud:first-run-sign-out`: drop the in-memory session and key. */
  async firstRunSignOut(): Promise<{ ok: true }> {
    await this.sessions.clearPending();
    this.wrap.clear();
    this.ports.trace('account', 'pending first-run Cloud sign-in cleared');
    return { ok: true };
  }

  private async enrollmentAllowsCloudServices(): Promise<boolean> {
    try {
      return await this.checkEnrollment();
    } catch (err) {
      this.ports.logger.error('[SullaCloudAuth] Could not check vault enrollment state; cloud services will not start:', err);
      return false;
    }
  }

  private async checkEnrollment(): Promise<boolean> {
    // This metadata-only gate deliberately has no password/master-key input.
    // Run it before cloud services can wake the local-vault create path.
    const disposition = await this.ports.enrollmentGate();
    if (disposition === 'approval_available' || disposition === 'waiting_for_approver') {
      const message = disposition === 'approval_available'
        ? 'Waiting for your other Sulla to approve this computer.'
        : 'Waiting for a signed-in computer, phone, or Cloud session to approve this computer.';
      this.ports.trace('vault', message);
      await this.ports.showApprovalWait(message);
      return false;
    }
    if (disposition === 'recovery') this.ports.trace('vault', 'the existing Cloud vault needs recovery');
    else if (disposition === 'trusted') this.ports.trace('vault', 'this computer is trusted; waiting for the existing Cloud vault to sync');
    return true;
  }
}
