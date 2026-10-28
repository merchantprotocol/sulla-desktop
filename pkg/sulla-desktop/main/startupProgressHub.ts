// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * StartupProgressHub — main-process owner of the unified startup progress.
 *
 * Feeds the pure StartupProgressModel from the backend ProgressTracker
 * (via background.ts) and the ServiceLifecycleManager ('startup:*' events),
 * then broadcasts one `startup-progress` snapshot to renderer windows,
 * coalesced so bursts of events cost one IPC message.
 */

import { getServiceLifecycleManager, type LifecycleBeginEvent, type LifecycleStepEvent } from '@pkg/agent/services/ServiceLifecycleManager';
import { StartupProgressModel, type BackendProgressInput, type StartupProgressSnapshot } from '@pkg/utils/startupProgress';

type Broadcast = (snapshot: StartupProgressSnapshot) => void;

const COALESCE_MS = 80;

export class StartupProgressHub {
  private readonly model: StartupProgressModel;
  private timer:          ReturnType<typeof setTimeout> | null = null;
  private attached = false;

  constructor(private readonly broadcast: Broadcast, now: () => number = Date.now) {
    this.model = new StartupProgressModel(now);
  }

  /** Subscribe to the lifecycle manager once. */
  attachLifecycle(lifecycle: Pick<ReturnType<typeof getServiceLifecycleManager>, 'on' | 'serviceStatuses'> = getServiceLifecycleManager()): void {
    if (this.attached) return;
    this.attached = true;
    lifecycle.on('startup:begin', (e: LifecycleBeginEvent) => this.apply(() => this.model.onLifecycleBegin(e.order, e.alreadyStarted)));
    lifecycle.on('startup:step', (e: LifecycleStepEvent) => this.apply(() => this.model.onLifecycleStep(e)));
    lifecycle.on('all:ready', () => this.apply(() => this.model.onLifecycleAllReady()));
    lifecycle.on('service:status', (status) => this.apply(() => this.model.onServiceStatus(status)));
    for (const status of lifecycle.serviceStatuses()) this.model.onServiceStatus(status);
  }

  onBackendProgress(progress: Readonly<BackendProgressInput>): void {
    this.apply(() => this.model.onBackendProgress({ current: progress.current, max: progress.max, description: progress.description }));
  }

  onBackendState(state: string): void {
    this.apply(() => this.model.onBackendState(String(state)));
  }

  snapshot(): StartupProgressSnapshot {
    return this.model.snapshot();
  }

  private apply(change: () => void): void {
    try {
      change();
    } catch (err) {
      // Progress is cosmetic; never let it break startup.
      console.warn('[StartupProgress] update failed:', err);

      return;
    }
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      try {
        this.broadcast(this.model.snapshot());
      } catch (err) {
        console.warn('[StartupProgress] broadcast failed:', err);
      }
    }, COALESCE_MS);
  }
}

let instance: StartupProgressHub | null = null;

export function getStartupProgressHub(broadcast?: Broadcast): StartupProgressHub {
  if (!instance) {
    instance = new StartupProgressHub(broadcast ?? (() => undefined));
    instance.attachLifecycle();
  }

  return instance;
}
