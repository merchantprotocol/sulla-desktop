// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Creates (or moves to the Cloud password) the container vault once the
 * first-run sign-in has derived the Cloud key, then keeps the rest of Desktop
 * in step with the container's real lock state.
 *
 * Why this is its own class: the old inline loop in sullaCloudAuth waited for
 * the lifecycle 'vault' SERVICE to be 'ready'. That service only starts after
 * postgres → redis → database-manager (migrations, seeds, skills warm-up) and
 * the whole managed-services reconcile, none of which the vault container or
 * its approval API need. On a slow or upgraded Mac the service stayed not-ready
 * while the container was up and answering, so the vault was never created,
 * stayed locked, and Files never got its mount capability. Each attempt here
 * asks the container itself, is bounded in time, and retries on a timer and on
 * every readiness event, so a missed event can never strand the key.
 */

export type VaultCreationDisposition = 'create' | 'trusted' | 'adopted' | 'approval_available' | 'waiting_for_approver' | 'recovery';

export interface ContainerVaultStatus {
  unlocked:       boolean;
  setupRequired?: boolean;
}

export interface FirstRunVaultCreationDependencies {
  /** The first-run sign-in still holds credentials only in memory and must not touch the vault yet. */
  readonly holdUntilWizardCloses: () => boolean;
  /** True while the Cloud-derived vault key is held in memory. */
  readonly hasPendingKey: () => boolean;
  /** The container's own status. Throws when the container is not answering yet. */
  readonly containerStatus: () => Promise<ContainerVaultStatus>;
  /** Lifecycle view of the lock state (what chat, Files and integrations wait on). */
  readonly lifecycleUnlocked: () => boolean;
  /** Cloud enrollment: is there already a Cloud vault for this account? */
  readonly enrollmentGate: () => Promise<VaultCreationDisposition>;
  /** Wait for another signed-in device to approve this computer. */
  readonly enrollmentComplete: () => Promise<VaultCreationDisposition>;
  /** Create the vault from the Cloud key (or re-key an unlocked one) and publish the unlock. */
  readonly createOrRewrap: () => Promise<void>;
  /** Publish the container's unlocked state to the lifecycle (refresh the auto-unlock cache too). */
  readonly publishUnlocked: () => Promise<void>;
  /** Drop the in-memory key once an existing Cloud vault was adopted. */
  readonly zeroKey: () => void;
  readonly trace: (message: string, detail?: Record<string, unknown>) => void;
  readonly logError: (message: string) => void;
}

export interface FirstRunVaultCreationTiming {
  /** Steady poll while a key is pending; also the safety net for missed readiness events. */
  readonly pollMs:           number;
  /** Upper bound for the status and Cloud lookup steps of one attempt. */
  readonly stepTimeoutMs:    number;
  readonly retryInitialMs:   number;
  readonly retryMaxMs:       number;
  /** After a creation, how long a stale 'locked' publication is corrected. */
  readonly staleLockWindowMs: number;
}

export const DEFAULT_FIRST_RUN_VAULT_TIMING: FirstRunVaultCreationTiming = {
  pollMs:         5_000,
  stepTimeoutMs:  30_000,
  retryInitialMs: 2_000,
  retryMaxMs:     60_000,
  staleLockWindowMs: 120_000,
};

class StepTimeoutError extends Error {}

export class FirstRunVaultCreation {
  private running = false;
  private lastWait = '';
  private retryMs: number;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private reconciling = false;
  private createdAt = 0;

  constructor(
    private readonly deps: FirstRunVaultCreationDependencies,
    private readonly timing: FirstRunVaultCreationTiming = DEFAULT_FIRST_RUN_VAULT_TIMING,
  ) {
    this.retryMs = timing.retryInitialMs;
  }

  /** Start the safety-net poll. Readiness events should also call {@link poke}. */
  start(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => { void this.poke() }, this.timing.pollMs);
    this.pollTimer.unref?.();
  }

  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.pollTimer = undefined;
    this.retryTimer = undefined;
  }

  /**
   * The lifecycle published a lock. If the container is in fact unlocked (a
   * stale 'locked' from a start-up read that raced the creation), publish the
   * truth again so chat, Files and integrations do not stay gated forever.
   * Only right after this class created the vault: a lock the owner asks for
   * later is never undone.
   */
  async onLifecycleLocked(): Promise<void> {
    if (this.reconciling || !this.createdAt || Date.now() - this.createdAt > this.timing.staleLockWindowMs) return;
    this.reconciling = true;
    try {
      const status = await this.withTimeout(this.deps.containerStatus(), 'vault status');
      if (status.unlocked && !this.deps.lifecycleUnlocked()) {
        this.deps.trace('container vault is unlocked but Desktop recorded it as locked; publishing the unlock again');
        await this.deps.publishUnlocked();
      }
    } catch { /* the container is not answering; the next poke or event retries */ } finally {
      this.reconciling = false;
    }
  }

  /** One attempt. Safe to call from timers and events; concurrent calls collapse. */
  async poke(): Promise<void> {
    if (!this.deps.hasPendingKey() || this.running) return;
    if (this.deps.holdUntilWizardCloses()) {
      // Never silent: this hold once hid a stranded key for a whole first run.
      this.wait('the earlier first-run sign-in expired; waiting for a fresh sign-in');
      return;
    }
    this.running = true;
    try {
      await this.attempt();
      this.retryMs = this.timing.retryInitialMs;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.deps.logError(`[SullaCloudAuth] Account-password vault migration failed; retrying: ${ message }`);
      this.deps.trace('vault creation failed; will retry', { error: message, retryInMs: this.retryMs });
      this.lastWait = '';
      this.scheduleRetry();
    } finally {
      this.running = false;
    }
  }

  private async attempt(): Promise<void> {
    let status: ContainerVaultStatus;
    try {
      status = await this.withTimeout(this.deps.containerStatus(), 'vault status');
    } catch {
      this.wait('vault service not ready yet');
      return;
    }
    // A vault that is already unlocked only moves to the account password.
    let creating = false;
    if (!status.unlocked && !this.deps.lifecycleUnlocked()) {
      if (!status.setupRequired) {
        this.wait('a vault from an earlier install exists and is locked; it must be unlocked with its old password or recovery key');
        return;
      }
      let disposition = await this.withTimeout(this.deps.enrollmentGate(), 'Cloud vault lookup');
      if (disposition === 'approval_available' || disposition === 'waiting_for_approver') {
        this.wait('Waiting for your other Sulla to approve this computer. Approval has to come from a signed-in computer, phone, or Cloud session.');
        disposition = await this.deps.enrollmentComplete();
      }
      if (disposition === 'approval_available' || disposition === 'waiting_for_approver') {
        this.wait('Waiting for your other Sulla to approve this computer. Approval has to come from a computer, phone, or Cloud session that is signed in.');
        return;
      }
      if (disposition === 'recovery') { this.wait('the existing Cloud vault needs recovery'); return }
      if (disposition === 'trusted') { this.wait('this computer is trusted; waiting for the existing Cloud vault to sync'); return }
      if (disposition === 'adopted') {
        this.deps.zeroKey();
        this.deps.trace('existing Cloud vault adopted and unlocked');
        return;
      }
      creating = true;
    }
    this.lastWait = '';
    this.deps.trace(creating ? 'no Cloud vault exists; creating it from the Cloud key' : 'vault is unlocked; moving it to the Cloud password');
    await this.deps.createOrRewrap();
    this.createdAt = Date.now();
    this.deps.trace(creating ? 'vault created and unlocked' : 'vault now uses the Cloud password');
  }

  private wait(reason: string): void {
    if (reason === this.lastWait) return;
    this.lastWait = reason;
    this.deps.trace(`vault creation waiting: ${ reason }`);
  }

  private scheduleRetry(): void {
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.poke();
    }, this.retryMs);
    this.retryTimer.unref?.();
    this.retryMs = Math.min(this.retryMs * 2, this.timing.retryMaxMs);
  }

  private async withTimeout<T>(work: Promise<T>, step: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new StepTimeoutError(`${ step } did not answer within ${ this.timing.stepTimeoutMs / 1000 }s`)), this.timing.stepTimeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
