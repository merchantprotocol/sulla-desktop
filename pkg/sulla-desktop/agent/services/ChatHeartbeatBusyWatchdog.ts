// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { ChatHeartbeatRuntime } from './ChatHeartbeatScheduler';

// How often a paused heartbeat re-checks a renderer "busy" claim against the
// backend, and how long the two may disagree before the claim is dropped.
export const STALE_BUSY_CHECK_MS = 15_000;
export const STALE_BUSY_LIMIT_MS = 60_000;

export interface ChatHeartbeatBusyWatchdogDeps {
  now:         () => number;
  setTimer:    typeof setTimeout;
  clearTimer:  typeof clearTimeout;
  isGraphBusy: (threadId: string) => boolean;
  isCurrent:   (runtime: ChatHeartbeatRuntime) => boolean;
  /** The renderer's busy claim outlived its graph; the scheduler resumes the countdown. */
  onStale:     (runtime: ChatHeartbeatRuntime) => void;
}

/**
 * A turn that dies on an error can leave the renderer claiming "busy"
 * forever, which would pause the heartbeat for good — exactly when the
 * chat most needs waking. The backend graph is the source of truth: once
 * it has had no live turn for STALE_BUSY_LIMIT_MS, drop the stale claim.
 */
export class ChatHeartbeatBusyWatchdog {
  constructor(private readonly deps: ChatHeartbeatBusyWatchdogDeps) {}

  start(runtime: ChatHeartbeatRuntime): void {
    if (runtime.watchdog) return;
    runtime.idleSince = null;
    const check = () => {
      runtime.watchdog = null;
      if (!this.deps.isCurrent(runtime) || !runtime.busy || runtime.config.intervalMinutes === null) {
        runtime.idleSince = null;
        return;
      }
      if (this.deps.isGraphBusy(runtime.threadId)) {
        runtime.idleSince = null;
      } else {
        runtime.idleSince ??= this.deps.now();
        if (this.deps.now() - runtime.idleSince >= STALE_BUSY_LIMIT_MS) {
          console.warn(`[ChatHeartbeat] thread ${ runtime.threadId } reported busy but its graph is idle; resuming heartbeat`);
          runtime.busy = false;
          runtime.idleSince = null;
          this.deps.onStale(runtime);
          return;
        }
      }
      runtime.watchdog = this.deps.setTimer(check, STALE_BUSY_CHECK_MS);
      runtime.watchdog.unref?.();
    };
    runtime.watchdog = this.deps.setTimer(check, STALE_BUSY_CHECK_MS);
    runtime.watchdog.unref?.();
  }

  stop(runtime: ChatHeartbeatRuntime): void {
    if (runtime.watchdog) this.deps.clearTimer(runtime.watchdog);
    runtime.watchdog = null;
    runtime.idleSince = null;
  }
}
