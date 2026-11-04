// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { agentJobProvider } from '../app/Providers/AgentJobServiceProvider';
import { parkJobTask, resumeParkedJob } from '../tools/agents/jobRegistry';

interface ParkedWaiter { resolve: () => void; }
export interface ChildDependencyCounter { openChildrenForThread(threadId: string): Promise<number>; }

/** Owns the running -> parked -> running lifecycle for hidden delegated managers. */
export class AgentJobLifecycleService {
  private readonly waiters = new Map<string, ParkedWaiter>();
  private readonly pendingWakes = new Set<string>();

  constructor(
    private readonly children: ChildDependencyCounter,
    private readonly parkTask: (jobId: string, taskIndex: number, waitingOnChildren: number) => Promise<void>,
    private readonly resumeTask: (jobId: string, taskIndex: number) => Promise<void>,
  ) {}

  async parkWhenWaiting(jobId: string, taskIndex: number, threadId: string): Promise<boolean> {
    const openChildren = await this.children.openChildrenForThread(threadId);
    if (openChildren === 0) return false;
    await this.parkTask(jobId, taskIndex, openChildren);
    return true;
  }

  async waitForWake(threadId: string, signal?: AbortSignal): Promise<void> {
    if (this.pendingWakes.delete(threadId)) return;
    await new Promise<void>((resolve) => {
      const finish = () => {
        this.waiters.delete(threadId);
        signal?.removeEventListener('abort', finish);
        resolve();
      };
      this.waiters.set(threadId, { resolve: finish });
      signal?.addEventListener('abort', finish, { once: true });
    });
  }

  /** Returns true when a live parked runner accepted the wake. */
  wake(threadId: string): boolean {
    const waiter = this.waiters.get(threadId);
    if (!waiter) {
      this.pendingWakes.add(threadId);
      return false;
    }
    waiter.resolve();
    return true;
  }

  async resume(jobId: string, taskIndex: number): Promise<void> {
    await this.resumeTask(jobId, taskIndex);
  }
}

export const agentJobLifecycle = new AgentJobLifecycleService(
  agentJobProvider.jobs,
  parkJobTask,
  resumeParkedJob,
);
