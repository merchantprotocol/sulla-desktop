// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { FleetJobView, FleetTaskView } from './AgentFleetTypes';

export interface AgentTeamRollup {
  states: Record<string, number>;
  oldestQuietAgeMs: number | null;
  openBlockers: number;
  unprocessedResults: number;
  workerCount: number;
}

/** Aggregates descendants beneath each direct child task from one fleet snapshot. */
export class AgentTeamRollupProjector {
  constructor(private readonly now: () => number = Date.now) {}

  project(jobs: FleetJobView[]): Map<string, AgentTeamRollup> {
    const children = new Map<string, FleetJobView[]>();
    for (const job of jobs) {
      if (job.parentJobId === null || job.parentTaskIndex === null) continue;
      const key = this.key(job.parentJobId, job.parentTaskIndex);
      children.set(key, [...(children.get(key) ?? []), job]);
    }
    const direct = jobs.filter(job => job.parentJobId === null);
    const output = new Map<string, AgentTeamRollup>();
    for (const job of direct) for (const task of job.tasks) {
      const descendants = this.descendants(children, this.key(job.jobId, task.taskIndex));
      if (descendants.length === 0) continue;
      output.set(this.key(job.jobId, task.taskIndex), this.aggregate(descendants));
    }
    return output;
  }

  key(jobId: string, taskIndex: number): string { return `${ jobId }#${ taskIndex }`; }

  private descendants(children: Map<string, FleetJobView[]>, root: string): FleetTaskView[] {
    const tasks: FleetTaskView[] = []; const queue = [...(children.get(root) ?? [])]; const seen = new Set<string>();
    while (queue.length) {
      const job = queue.shift()!;
      if (seen.has(job.jobId)) continue;
      seen.add(job.jobId);
      for (const task of job.tasks) {
        tasks.push(task);
        queue.push(...(children.get(this.key(job.jobId, task.taskIndex)) ?? []));
      }
    }
    return tasks;
  }

  private aggregate(tasks: FleetTaskView[]): AgentTeamRollup {
    const states: Record<string, number> = {};
    let oldestQuietAgeMs: number | null = null; let openBlockers = 0; let unprocessedResults = 0;
    for (const task of tasks) {
      const blockers = task.latestCheckin?.blockers.length ?? 0;
      const state = this.state(task, blockers);
      states[state] = (states[state] ?? 0) + 1;
      openBlockers += blockers;
      if (state === 'quiet') oldestQuietAgeMs = Math.max(oldestQuietAgeMs ?? 0, this.now() - Date.parse(task.lastActivityAt));
      if ((task.returned || task.completion) && !task.completionDeliveredAt) unprocessedResults++;
    }
    return { states, oldestQuietAgeMs, openBlockers, unprocessedResults, workerCount: tasks.length };
  }

  private state(task: FleetTaskView, blockers: number): string {
    if (task.status === 'error') return 'failed';
    if (task.status === 'completed') return 'done';
    if (blockers || task.status === 'blocked') return 'blocked';
    if (task.status === 'running' && this.now() - Date.parse(task.lastActivityAt) >= 5 * 60_000) return 'quiet';
    return task.status === 'running' ? 'working' : task.status;
  }
}
