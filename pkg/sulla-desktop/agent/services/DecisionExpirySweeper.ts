// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export interface ExpiryReconciler {
  reconcileExpired(): Promise<void>;
}

export interface SweepTimer {
  every(intervalMs: number, tick: () => void): () => void;
}

/** The process clock; its interval never keeps the app alive on its own. */
export class NodeSweepTimer implements SweepTimer {
  every(intervalMs: number, tick: () => void): () => void {
    const handle = setInterval(tick, intervalMs);
    handle.unref?.();
    return () => clearInterval(handle);
  }
}

/**
 * Expires overdue decisions when the app starts and on a coarse interval after that.
 * Durable requests (a Files publish approval lasts 7 days) have no in-memory timer
 * after a restart, so without this their expiry would wait for someone to open Decide.
 */
export class DecisionExpirySweeper {
  static readonly DEFAULT_INTERVAL_MS = 5 * 60_000;
  private cancel?: () => void;
  private sweeping = false;

  constructor(
    private readonly decisions: ExpiryReconciler,
    private readonly timer: SweepTimer = new NodeSweepTimer(),
    private readonly reportFailure: (message: string, error: unknown) => void = () => undefined,
    private readonly intervalMs = DecisionExpirySweeper.DEFAULT_INTERVAL_MS,
  ) {}

  start(): void {
    if (this.cancel) return;
    this.cancel = this.timer.every(this.intervalMs, () => { void this.sweep() });
    void this.sweep();
  }

  /** One pass. A failed pass (database not ready yet) is reported and retried on the next tick. */
  async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      await this.decisions.reconcileExpired();
    } catch (error) {
      this.reportFailure('Expiring overdue decisions failed:', error);
    } finally {
      this.sweeping = false;
    }
  }

  dispose(): void {
    this.cancel?.();
    this.cancel = undefined;
  }
}
