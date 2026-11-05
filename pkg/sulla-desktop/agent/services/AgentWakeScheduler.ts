// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { AgentTaskWait, AgentTaskWaitRepository } from '../app/Repositories/AgentTaskWaitRepository';

export class AgentWakeScheduler {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private started = false;
  constructor(private readonly waits: AgentTaskWaitRepository, private readonly wake: (wait: AgentTaskWait) => Promise<void>, private readonly now = () => Date.now()) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    for (const wait of await this.waits.scheduled()) this.schedule(wait);
  }

  schedule(wait: AgentTaskWait): void {
    const key = `${ wait.jobId }:${ wait.taskIndex }`;
    const prior = this.timers.get(key);
    if (prior) clearTimeout(prior);
    const timer = setTimeout(() => void this.fire(wait.jobId, wait.taskIndex), Math.max(0, wait.wakeAt.getTime() - this.now()));
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
    this.cancel(jobId, taskIndex);
    const claimed = await this.waits.claim(jobId, taskIndex);
    if (claimed) await this.wake(claimed);
  }
}
