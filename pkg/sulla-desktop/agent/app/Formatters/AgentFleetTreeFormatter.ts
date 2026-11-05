// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { FleetJobView, FleetTaskView } from '../Services/AgentFleetTypes';
import { PullRequestReferenceExtractor } from './PullRequestReferenceExtractor';

export interface FleetTreeLine {
  ref: string;
  parent: string | null;
  depth: number;
  state: string;
  activityAge: string;
  step?: string;
  blockers: number;
  returned: boolean;
  pr?: string;
  label?: string;
  truncated?: true;
}

/** Formats a fleet projection as bounded, structurally nested task lines. */
export class AgentFleetTreeFormatter {
  constructor(private readonly prs: PullRequestReferenceExtractor, private readonly now: () => number = Date.now) {}

  format(jobs: FleetJobView[]): { count: number; tasks: FleetTreeLine[] } {
    const byId = new Map(jobs.map(job => [job.jobId, job]));
    const depth = (job: FleetJobView): number => {
      let value = 0; let cursor: FleetJobView | undefined = job; const seen = new Set<string>();
      while (cursor?.parentJobId && !seen.has(cursor.jobId)) { seen.add(cursor.jobId); value++; cursor = byId.get(cursor.parentJobId); }
      return value;
    };
    const ordered = [...jobs].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.jobId.localeCompare(b.jobId));
    const tasks = ordered.flatMap(job => job.tasks.map(task => this.line(job, task, depth(job))));
    return { count: tasks.length, tasks };
  }

  private line(job: FleetJobView, task: FleetTaskView, depth: number): FleetTreeLine {
    const blockers = task.latestCheckin?.blockers.length ?? 0;
    const line: FleetTreeLine = {
      ref: `${ job.jobId }#${ task.taskIndex }`,
      parent: job.parentJobId === null ? null : `${ job.parentJobId }#${ job.parentTaskIndex }`,
      depth,
      state: task.stranded ? 'stranded' : this.state(job, task, blockers),
      activityAge: this.age(task.lastActivityAt),
      step: task.latestCheckin?.step || undefined,
      blockers,
      returned: task.returned,
      pr: this.prs.extract(task) || undefined,
      label: task.label || task.agentId,
    };
    return this.bound(line);
  }

  private state(job: FleetJobView, task: FleetTaskView, blockers: number): string {
    if (job.status === 'failed' || task.status === 'error') return 'failed';
    if (task.status === 'completed') return 'done';
    if (blockers > 0 || task.status === 'blocked') return 'blocked';
    if (task.status === 'running' && this.now() - Date.parse(task.lastActivityAt) >= 5 * 60_000) return 'quiet';
    return task.status === 'running' ? 'working' : task.status;
  }

  private age(iso: string): string { return `${ Math.max(0, Math.floor((this.now() - Date.parse(iso)) / 1000)) }s`; }

  private bound(line: FleetTreeLine): FleetTreeLine {
    if (this.bytes(line) <= 400) return line;
    const bounded: FleetTreeLine = { ...line, truncated: true };
    for (const key of ['label', 'step', 'pr', 'parent', 'ref', 'activityAge', 'state'] as const) {
      if (this.bytes(bounded) <= 400) break;
      const value = bounded[key];
      if (typeof value !== 'string') continue;
      const symbols = [...value];
      let low = 0; let high = symbols.length;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        bounded[key] = symbols.slice(0, middle).join('');
        if (this.bytes(bounded) <= 400) low = middle; else high = middle - 1;
      }
      bounded[key] = symbols.slice(0, low).join('');
      if (!bounded[key] && ['label', 'step', 'pr'].includes(key)) delete bounded[key];
    }
    return bounded;
  }

  private bytes(line: FleetTreeLine): number { return Buffer.byteLength(JSON.stringify(line), 'utf8'); }
}
