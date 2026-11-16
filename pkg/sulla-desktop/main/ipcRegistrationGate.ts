// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * IpcRegistrationGate — lets startup hold the first window until the
 * main-process IPC handlers exist.
 *
 * background.ts is an ES module with a top-level `await onMainProxyLoad()`.
 * While that await is pending the event loop keeps running, so the
 * `whenReady` handler can open the first-run or main window before the
 * handlers registered inside onMainProxyLoad (vault:*, browser-tab-view:*,
 * accounts:*, lifecycle:status, ...) and every module-level handler after it
 * in background.ts (first-run-state:get, startup-progress, sulla-settings:*,
 * settings-write, ...) exist. A renderer that invokes one of them early gets
 * "No handler registered for '<channel>'".
 *
 * The module marks the gate once its last handler is registered; startup
 * awaits it before opening any window. The wait is bounded so a hung
 * registration can never keep the app windowless.
 */

export type IpcRegistrationOutcome =
  | { state: 'registered' }
  | { state: 'failed'; error: unknown }
  | { state: 'timed-out' };

type Scheduler = {
  setTimeout:   (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

const defaultScheduler: Scheduler = {
  setTimeout:   (callback, ms) => setTimeout(callback, ms),
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class IpcRegistrationGate {
  private outcome: IpcRegistrationOutcome | null = null;
  private readonly settled: Promise<IpcRegistrationOutcome>;
  private settle!: (outcome: IpcRegistrationOutcome) => void;

  constructor(private readonly scheduler: Scheduler = defaultScheduler) {
    this.settled = new Promise((resolve) => {
      this.settle = resolve;
    });
  }

  /** Every startup IPC handler is registered. Later calls are ignored. */
  markRegistered(): void {
    this.finish({ state: 'registered' });
  }

  /** Registration threw; waiters stop waiting instead of hitting the timeout. */
  markFailed(error: unknown): void {
    this.finish({ state: 'failed', error });
  }

  get isRegistered(): boolean {
    return this.outcome?.state === 'registered';
  }

  /**
   * Resolve once registration finished or failed, or after `timeoutMs`.
   * Never rejects: the caller opens its window either way.
   */
  wait(timeoutMs: number): Promise<IpcRegistrationOutcome> {
    if (this.outcome) {
      return Promise.resolve(this.outcome);
    }

    return new Promise((resolve) => {
      const timer = this.scheduler.setTimeout(() => resolve({ state: 'timed-out' }), timeoutMs);

      void this.settled.then((outcome) => {
        this.scheduler.clearTimeout(timer);
        resolve(outcome);
      });
    });
  }

  private finish(outcome: IpcRegistrationOutcome): void {
    if (this.outcome) {
      return;
    }
    this.outcome = outcome;
    this.settle(outcome);
  }
}
