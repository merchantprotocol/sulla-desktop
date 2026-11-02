// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export class RefreshScheduler {
  readonly refreshAt = new Map<string, number>();
  readonly retryCounts = new Map<string, number>();
  readonly inFlight = new Map<string, Promise<any>>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  get(key: string): NodeJS.Timeout | undefined { return this.timers.get(key) }
  set(key: string, timer: NodeJS.Timeout): void { this.clearTimer(key); this.timers.set(key, timer) }
  clearTimer(key: string): void { const timer = this.timers.get(key); if (timer) clearTimeout(timer); this.timers.delete(key) }
  clear(key: string): void { this.clearTimer(key); this.refreshAt.delete(key); this.retryCounts.delete(key); this.inFlight.delete(key) }
  shutdown(): void { for (const timer of this.timers.values()) clearTimeout(timer); this.timers.clear(); this.refreshAt.clear(); this.retryCounts.clear(); this.inFlight.clear() }
}
