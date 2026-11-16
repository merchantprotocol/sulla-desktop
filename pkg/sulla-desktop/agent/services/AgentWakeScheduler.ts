// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { AgentTaskWait, AgentTaskWaitRepository } from '../app/Repositories/AgentTaskWaitRepository';

/**
 * Wake callback result: true (or void) when the wake was delivered or there
 * is nothing left to wake; false when it could not be delivered yet and the
 * claimed wait must be retried rather than dropped.
 */
export type AgentWakeHandler = (wait: AgentTaskWait) => Promise<boolean | void>;

export class AgentWakeScheduler {
  static readonly RETRY_DELAY_MS = 30_000;
  static readonly MAX_ATTEMPTS = 5;

  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly failedAttempts = new Map<string, number>();
  private started = false;
  constructor(private readonly waits: AgentTaskWaitRepository, private readonly wake: AgentWakeHandler, private readonly now = () => Date.now()) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    for (const wait of await this.waits.scheduled()) this.schedule(wait);
  }

  schedule(wait: AgentTaskWait): void {
    const key = `${ wait.jobId }:${ wait.taskIndex }`;
    const prior = this.timers.get(key);
    if (prior) clearTimeout(prior);
    const timer = setTimeout(() => {
      this.fire(wait.jobId, wait.taskIndex).catch(err => console.error(`[AgentWakeScheduler] Wake for ${ key } failed:`, err));
    }, Math.max(0, wait.wakeAt.getTime() - this.now()));
    timer.unref?.();
    this.timers.set(key, timer);
  }

  cancel(jobId: string, taskIndex: number): void {
    const key = `${ jobId }:${ taskIndex }`;
    const timer = this.timers.get(key);
    if (timer) clearTimeout(timer);
    this.timers.delete(key);
  }

  private async fire(jobId: string, taskIndex: number): Promise<void> {
    const key = `${ jobId }:${ taskIndex }`;
    this.cancel(jobId, taskIndex);
    const claimed = await this.waits.claim(jobId, taskIndex);
    if (!claimed) return;
    let delivered = false;
    try {
      delivered = (await this.wake(claimed)) !== false;
    } catch (error) {
      console.warn(`[AgentWakeScheduler] Wake for ${ key } threw; releasing it for retry:`, error);
    }
    if (delivered) {
      this.failedAttempts.delete(key);
      return;
    }
    // A claimed wake that was not delivered must go back on the schedule;
    // keeping it claimed strands the parked task with nothing left to wake it.
    const attempts = (this.failedAttempts.get(key) ?? 0) + 1;
    const retryAt = new Date(this.now() + AgentWakeScheduler.RETRY_DELAY_MS * attempts);
    const released = await this.waits.release(jobId, taskIndex, retryAt);
    if (attempts >= AgentWakeScheduler.MAX_ATTEMPTS) {
      // Stop retrying in this process, but leave the wait scheduled so the
      // next app start tries again instead of losing it.
      this.failedAttempts.delete(key);
      console.error(`[AgentWakeScheduler] Wake for ${ key } undelivered after ${ attempts } attempts; left scheduled for the next app start.`);
      return;
    }
    this.failedAttempts.set(key, attempts);
    if (released) this.schedule(released);
  }
}
