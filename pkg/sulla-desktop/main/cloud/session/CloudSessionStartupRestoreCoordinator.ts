// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { VaultNotReadyError } from './CloudSessionStartupRestorer';

export interface StartupRestoredIdentity { userId: string }

export interface CloudSessionRestoreLifecycle {
  on(event: 'vault:state', listener: (unlocked: boolean) => void): void;
  on(event: 'service:ready', listener: (name: string) => void): void;
  off(event: 'vault:state', listener: (unlocked: boolean) => void): void;
  off(event: 'service:ready', listener: (name: string) => void): void;
}

export interface CloudSessionStartupRestoreDependencies {
  lifecycle: CloudSessionRestoreLifecycle;
  restoreIdentity(): Promise<StartupRestoredIdentity | null>;
  pairRelay(userId: string): Promise<void>;
  startCloudServices(): Promise<void>;
  trace(message: string, metadata?: Record<string, unknown>): void;
  logger: { log(message: string): void; warn(message: string, error?: unknown): void };
  setLastError(message: string): void;
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  cancel?: (timer: ReturnType<typeof setTimeout>) => void;
}

/** Owns the retry/wake lifecycle for Cloud session restoration during app startup. */
export class CloudSessionStartupRestoreCoordinator {
  private running = false;
  private restoreWakeVersion = 0;
  private wakeRestore: (() => void) | undefined;
  private readonly now: () => number;
  private readonly schedule: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  private readonly cancel: (timer: ReturnType<typeof setTimeout>) => void;

  constructor(private readonly dependencies: CloudSessionStartupRestoreDependencies) {
    this.now = dependencies.now ?? Date.now;
    this.schedule = dependencies.schedule ?? ((callback, delay) => setTimeout(callback, delay));
    this.cancel = dependencies.cancel ?? clearTimeout;
  }

  signal(): void {
    if (!this.running) {
      void this.start();
      return;
    }
    this.restoreWakeVersion++;
    this.wakeRestore?.();
    this.wakeRestore = undefined;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const { lifecycle, logger, trace, pairRelay, restoreIdentity, startCloudServices, setLastError } = this.dependencies;
    let restoreWakeVersion = this.restoreWakeVersion;
    const onVaultState = (unlocked: boolean) => { if (unlocked) this.signal(); };
    const onServiceReady = (name: string) => { if (name === 'vault') this.signal(); };
    lifecycle.on('vault:state', onVaultState);
    lifecycle.on('service:ready', onServiceReady);

    try {
      const retryBaseMs = 2_000;
      const retryMaxMs = 60_000;
      const retryGiveUpMs = 10 * 60_000;
      const startedAt = this.now();
      let delay = retryBaseMs;

      while (true) {
        const attemptWakeVersion = restoreWakeVersion;
        try {
          const identity = await restoreIdentity();
          if (identity) {
            await pairRelay(identity.userId);
            try {
              await startCloudServices();
            } catch (error) {
              logger.warn('[SullaCloudAuth] Failed to start cloud services on restore:', error);
              throw new VaultNotReadyError(`cloud services unavailable: ${ (error as Error)?.message || error }`);
            }
            logger.log(`[SullaCloudAuth] Restored session: user=${ identity.userId }`);
            trace('startup restore: Cloud session found in the vault', { userId: identity.userId });
          } else {
            logger.log('[SullaCloudAuth] Startup restore: no signed-in session');
            trace('startup restore: no Cloud session in the vault');
          }
          return;
        } catch (error) {
          const giveUp = !(error instanceof VaultNotReadyError) && (this.now() - startedAt) >= retryGiveUpMs;
          if (!this.isTransient(error) || giveUp) {
            logger.warn('[SullaCloudAuth] Startup restore failed (giving up):', error);
            trace('startup restore gave up', { error });
            setLastError(`Sulla Cloud restore stopped: ${ (error as Error)?.message || error }`);
            return;
          }
          logger.log(`[SullaCloudAuth] Startup restore not ready yet (${ (error as Error)?.message || error }); retrying in ${ delay }ms or on vault readiness`);
          if (this.restoreWakeVersion === attemptWakeVersion) await this.waitForWake(delay, attemptWakeVersion);
          restoreWakeVersion = this.restoreWakeVersion;
          delay = Math.min(delay * 2, retryMaxMs);
        }
      }
    } finally {
      this.running = false;
      this.wakeRestore = undefined;
      lifecycle.off('vault:state', onVaultState);
      lifecycle.off('service:ready', onServiceReady);
    }
  }

  private isTransient(error: unknown): boolean {
    if (error instanceof VaultNotReadyError) return true;
    const err = error as { code?: string; cause?: { code?: string }; message?: string };
    const code = err?.code ?? err?.cause?.code;
    if (['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNRESET'].includes(code ?? '')) return true;
    const message = String(err?.message || error || '').toLowerCase();
    return /econnrefused|etimedout|enotfound|econnreset|connect.*failed|pool.*shutting down|database.*not ready/.test(message);
  }

  private waitForWake(delay: number, attemptWakeVersion: number): Promise<void> {
    return new Promise(resolve => {
      const timer = this.schedule(() => {
        if (this.wakeRestore === wake) this.wakeRestore = undefined;
        resolve();
      }, delay);
      const wake = () => {
        this.cancel(timer);
        resolve();
      };
      this.wakeRestore = wake;
      if (this.restoreWakeVersion !== attemptWakeVersion) wake();
    });
  }
}

/** Owns the startup coordinator instance for main-process service registration. */
export class CloudSessionStartupRestoreServiceProvider {
  private coordinator: CloudSessionStartupRestoreCoordinator | undefined;

  start(dependencies: CloudSessionStartupRestoreDependencies): Promise<void> {
    this.coordinator = new CloudSessionStartupRestoreCoordinator(dependencies);
    return this.coordinator.start();
  }

  signal(): void {
    this.coordinator?.signal();
  }
}

export const cloudSessionStartupRestoreProvider = new CloudSessionStartupRestoreServiceProvider();
