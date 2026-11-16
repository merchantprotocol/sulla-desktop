// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/** Anything that prunes Automerge snapshots past retention (AutomergeSnapshotRetention). */
export interface SnapshotPruning { prune():Promise<unknown> }

/** Runs snapshot retention once a minute in the background: started once, stoppable, never keeps the process alive. */
export class AutomergeSnapshotPruner {
  private timer?:NodeJS.Timeout;

  constructor(
    private readonly retention:SnapshotPruning,
    private readonly intervalMs = 60_000,
    private readonly warn:(message:string, error:unknown) => void = (message, error) => console.warn(message, error),
  ) {}

  get running():boolean { return Boolean(this.timer) }

  start():void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.retention.prune().catch(error => this.warn('[SullaFiles] Automerge snapshot retention failed:', error)); }, this.intervalMs);
    this.timer.unref();
  }

  stop():void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
