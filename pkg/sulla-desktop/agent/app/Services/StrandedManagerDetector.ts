// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { FleetJobView, FleetTaskView } from './AgentFleetTypes';

export type StrandedReasonKind = 'parked-without-live-children' | 'result-not-woken';
export interface StrandedManagerCandidate {
  managerJobId: string;
  managerTaskIndex: number;
  stateKey: string;
  reason: string;
  reasonKind: StrandedReasonKind;
  detectedAt: number;
  parentChannel: string;
  parentThreadId: string;
  label: string;
}

export interface ManagerActivitySource { isActive(jobId: string, taskIndex: number, task: FleetTaskView, now: number): boolean }

/** Default until #1991 injects authoritative live model/tool activity. */
export class DurableTimestampActivitySource implements ManagerActivitySource {
  isActive(_jobId: string, _taskIndex: number, task: FleetTaskView, now: number): boolean {
    return now - Date.parse(task.lastActivityAt) < 10 * 60_000;
  }
}

/** Pure policy for identifying a stranded manager episode from a fleet snapshot. */
export class StrandedManagerDetector {
  constructor(private readonly now: () => number = Date.now, private readonly activity: ManagerActivitySource = new DurableTimestampActivitySource()) {}

  detect(jobs: FleetJobView[]): StrandedManagerCandidate[] {
    const children = this.childrenByManager(jobs);
    const candidates: StrandedManagerCandidate[] = [];
    for (const job of jobs) for (const task of job.tasks) {
      const descendants = this.descendants(children, this.ref(job.jobId, task.taskIndex));
      if (!descendants.length || task.status !== 'parked' || this.futureWait(task) || this.activity.isActive(job.jobId, task.taskIndex, task, this.now())) continue;
      const candidate = this.classify(job, task, descendants);
      if (candidate) candidates.push(candidate);
    }
    return candidates;
  }

  managerRefs(jobs: FleetJobView[]): Set<string> {
    const refs = new Set<string>();
    for (const job of jobs) if (job.parentJobId !== null && job.parentTaskIndex !== null) refs.add(this.ref(job.parentJobId, job.parentTaskIndex));
    return refs;
  }

  ref(jobId: string, taskIndex: number): string { return `${ jobId }#${ taskIndex }`; }

  private classify(job: FleetJobView, task: FleetTaskView, descendants: FleetTaskView[]): StrandedManagerCandidate | null {
    if (!job.parentThreadId || !job.parentChannel) return null;
    const now = this.now();
    const managerActivity = Date.parse(task.lastActivityAt);
    const live = descendants.some(child => this.live(child, now));
    if (live) return null;
    const unprocessed = descendants.filter(child => (child.returned || child.completion !== undefined) && this.terminalAt(child) !== null && !child.completionDeliveredAt);
    const maxTerminal = Math.max(0, ...unprocessed.map(child => this.terminalAt(child) ?? 0));
    let reasonKind: StrandedReasonKind; let reason: string;
    if (maxTerminal > 0 && now - maxTerminal >= 10 * 60_000 && managerActivity <= maxTerminal) {
      reasonKind = 'result-not-woken';
      reason = `child result remained unprocessed for ${ Math.floor((now - maxTerminal) / 60_000) } minutes`;
    } else if (now - managerActivity >= 30 * 60_000) {
      reasonKind = 'parked-without-live-children';
      reason = `parked with no live children and no activity for ${ Math.floor((now - managerActivity) / 60_000) } minutes`;
    } else return null;
    const childRefs = unprocessed.map(child => `${ child.threadId ?? 'unknown' }#${ child.taskIndex }:${ this.terminalAt(child) }`).sort().join(',');
    const stateKey = `stranded:${ job.jobId }:${ task.taskIndex }:${ reasonKind }:${ managerActivity }:${ maxTerminal }:${ childRefs }`;
    return { managerJobId: job.jobId, managerTaskIndex: task.taskIndex, stateKey, reason, reasonKind,
      detectedAt: now, parentChannel: job.parentChannel, parentThreadId: job.parentThreadId,
      label: task.label || task.agentId };
  }

  private childrenByManager(jobs: FleetJobView[]): Map<string, FleetJobView[]> {
    const output = new Map<string, FleetJobView[]>();
    for (const job of jobs) {
      if (job.parentJobId === null || job.parentTaskIndex === null) continue;
      const key = this.ref(job.parentJobId, job.parentTaskIndex);
      output.set(key, [...(output.get(key) ?? []), job]);
    }
    return output;
  }

  private descendants(children: Map<string, FleetJobView[]>, root: string): FleetTaskView[] {
    const tasks: FleetTaskView[] = []; const queue = [...(children.get(root) ?? [])]; const seen = new Set<string>();
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const job = queue[cursor];
      if (seen.has(job.jobId)) continue;
      seen.add(job.jobId);
      for (const task of job.tasks) { tasks.push(task); queue.push(...(children.get(this.ref(job.jobId, task.taskIndex)) ?? [])); }
    }
    return tasks;
  }

  private live(task: FleetTaskView, now: number): boolean {
    if (['queued', 'running', 'blocked'].includes(task.status)) return true;
    return task.status === 'parked' && !!task.wakeAt && Date.parse(task.wakeAt) > now;
  }
  private futureWait(task: FleetTaskView): boolean { return !!task.wakeAt && Date.parse(task.wakeAt) > this.now(); }
  private terminalAt(task: FleetTaskView): number | null {
    const value = task.returnedAt ?? task.finishedAt;
    return value ? Date.parse(value) : null;
  }
}
