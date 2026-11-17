// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/** Coalesces committed version notifications per collection before waking Cloud sync. */
export class CloudSyncCommitWakeup {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly committedAt = new Map<string, number>();

  constructor(private readonly wake:(collectionId:string, committedAt:number)=>void, private readonly debounceMs = 350) {}

  notify(collectionId:string):void {
    const timestamp = Date.now();
    this.committedAt.set(collectionId, timestamp);
    const pending = this.timers.get(collectionId);
    if (pending) clearTimeout(pending);
    const timer = setTimeout(() => {
      this.timers.delete(collectionId);
      const committedAt = this.committedAt.get(collectionId);
      this.committedAt.delete(collectionId);
      if (committedAt !== undefined) this.wake(collectionId, committedAt);
    }, this.debounceMs);
    timer.unref();
    this.timers.set(collectionId, timer);
  }

  close():void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.committedAt.clear();
  }
}
