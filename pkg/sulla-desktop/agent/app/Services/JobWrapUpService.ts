// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { Service } from '@sulla/foundation';
import type { StopPrincipalValue } from '../ValueObjects/StopPrincipal';
import type { JobStopService } from './JobStopService';

type TimerHandle = ReturnType<typeof setTimeout>;
export interface JobWrapUpTimer {
  schedule(delayMs: number, callback: () => void): TimerHandle;
  cancel(handle: TimerHandle): void;
}

export class SystemJobWrapUpTimer implements JobWrapUpTimer {
  schedule(delayMs: number, callback: () => void): TimerHandle {
    const handle = setTimeout(callback, delayMs);
    (handle as TimerHandle & { unref?: () => void }).unref?.();
    return handle;
  }
  cancel(handle: TimerHandle): void { clearTimeout(handle); }
}

export interface JobWrapUpMessageSender {
  send(input: { jobId: string; taskIndex?: number; message: string }): Promise<unknown>;
}

export class JobWrapUpService extends Service {
  private readonly timers = new Map<string, TimerHandle>();

  constructor(
    private readonly stops: JobStopService,
    private readonly messages: JobWrapUpMessageSender,
    private readonly timer: JobWrapUpTimer = new SystemJobWrapUpTimer(),
  ) { super(); }

  private key(jobId: string, taskIndex: number): string { return `${ jobId }:${ taskIndex }`; }

  async request(
    jobId: string,
    taskIndexes: number[],
    principal: StopPrincipalValue,
    reason: string,
    gracePeriodSeconds: number,
    message: string,
    skipMessage = false,
  ): Promise<void> {
    for (const taskIndex of taskIndexes) {
      const key = this.key(jobId, taskIndex);
      if (this.timers.has(key)) continue;
      if(!skipMessage)await this.messages.send({ jobId, taskIndex, message });
      const delayMs = Math.max(1, gracePeriodSeconds || 120) * 1_000;
      const handle = this.timer.schedule(delayMs, () => {
        this.timers.delete(key);
        void this.stops.stopTask(jobId, taskIndex, principal, reason);
      });
      this.timers.set(key, handle);
    }
  }

  /** Called by job lifecycle settlement paths; a returned/settled task wins the grace race. */
  taskSettled(jobId: string, taskIndex: number): void {
    const key = this.key(jobId, taskIndex);
    const handle = this.timers.get(key);
    if (!handle) return;
    this.timer.cancel(handle);
    this.timers.delete(key);
  }

  /** A whole job settlement invalidates every outstanding grace timer. */
  jobSettled(jobId: string): void {
    for (const [key, handle] of this.timers) {
      if (key.startsWith(`${ jobId }:`)) {
        this.timer.cancel(handle);
        this.timers.delete(key);
      }
    }
  }
}
