// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { Service } from '@sulla/foundation';
import type { AgentJob } from '../../tools/agents/jobRegistry';
export class JobRuntimeRegistry extends Service {
  static readonly DEFAULT_TERMINAL_CACHE_LIMIT = 100;
  readonly jobs = new Map<string, AgentJob>();
  readonly abortControllers = new Map<string, AbortController>();
  readonly watchers = new Map<string, () => void>();
  private started = false;
  start(): void { this.started = true; }
  stop(): void { for (const value of this.abortControllers.values()) value.abort(); for (const stop of this.watchers.values()) stop(); this.reset(); this.started = false; }
  reset(): void { this.jobs.clear(); this.abortControllers.clear(); this.watchers.clear(); }
  isStarted(): boolean { return this.started; }

  /** Bounds only settled cache entries; durable rows remain available for rehydration. */
  evictSettledTerminalJobs(limit = JobRuntimeRegistry.DEFAULT_TERMINAL_CACHE_LIMIT): string[] {
    const candidates = Array.from(this.jobs.values())
      .filter(job => job.status !== 'running'
        && !job.tasks.some(task => ['queued', 'running'].includes(task.status))
        && (job.status !== 'completed' || job.tasks.every(task => task.returnedAt || ['stopped', 'error'].includes(task.status))))
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(Math.max(0, limit));
    for (const job of candidates) {
      this.jobs.delete(job.jobId);
      this.abortControllers.delete(job.jobId);
      this.watchers.get(job.jobId)?.();
      this.watchers.delete(job.jobId);
    }
    return candidates.map(job => job.jobId);
  }
}
