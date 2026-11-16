// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

/**
 * Bounded backoff for retrying a legacy vault migration the vault reported as
 * `migration_failed` (for example a transient database connect error). The
 * budget is per process: a few spaced attempts, never a tight loop. The next
 * app start gets a fresh budget.
 */
export class VaultMigrationRetry {
  static readonly DELAYS_MS: readonly number[] = [5_000, 15_000, 45_000];

  private attempts = 0;
  private dueAt: number | undefined;

  constructor(
    private readonly delaysMs: readonly number[] = VaultMigrationRetry.DELAYS_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** Call when the vault reports `migration_failed`. True when a retry may start now. */
  due(): boolean {
    if (this.attempts >= this.delaysMs.length) return false;
    this.dueAt ??= this.now() + this.delaysMs[this.attempts];
    return this.now() >= this.dueAt;
  }

  /**
   * Call when a retry starts. The next retry is due the following delay after
   * this start, so the schedule doesn't drift with when the next refresh happens.
   */
  started(): void {
    this.attempts++;
    this.dueAt = this.attempts < this.delaysMs.length ? this.now() + this.delaysMs[this.attempts] : undefined;
  }

  /** The vault no longer reports a failed migration: a later failure waits its full delay again. */
  cleared(): void {
    this.dueAt = undefined;
  }

  exhausted(): boolean {
    return this.attempts >= this.delaysMs.length;
  }
}
