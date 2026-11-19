// SPDX-License-Identifier: GPL-2.0-or-later

import type { AgentResultItem, ResultActivityRecord } from '@pkg/shared/agentResults/AgentResultCard';
import type { AgentStateRow } from '@pkg/shared/agentState/AgentStateSnapshot';

import type { ResultEntry } from './sideDock';

export interface ThreadMilestone {
  key:        string;
  title:      string;
  row?:       AgentStateRow;
  report?:    AgentResultItem;
  messageId?: string;
  parent?:    string;
}
export interface ThreadWorkstream {
  key:     string;
  title:   string;
  steps:   ThreadMilestone[];
  current: boolean;
  at:      number;
}

/** Presentation of exact thread/job/task relationships. No project lookup, title matching or dispatch. */
export class ThreadGoalProgress {
  static key(ref: { jobId: string; taskIndex: number }): string { return `${ ref.jobId }:${ ref.taskIndex }` }
  static active(row?: AgentStateRow): boolean {
    return !!row && !row.endedAt && (['queued', 'working', 'parked', 'quiet', 'lost'].includes(row.state) || (row.state === 'blocked' && (row.canMessage || row.canStop)));
  }

  static scope(threadId: string | undefined, rows: readonly AgentStateRow[], entries: readonly ResultEntry[]): AgentStateRow[] {
    if (!threadId) return [];
    const included = new Set(rows.filter(row => row.rootThreadId === threadId).map(row => row.key));
    const parents = new Set(rows.filter(row => row.threadId === threadId).map(row => row.key));
    const reported = new Set(entries.map(entry => this.key(entry.item)));
    for (const row of rows) if (reported.has(row.key)) included.add(row.key);
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of rows) {
        const parent = row.parentJobId !== null && row.parentTaskIndex !== null ? `${ row.parentJobId }:${ row.parentTaskIndex }` : '';
        if (!included.has(row.key) && (included.has(parent) || parents.has(parent))) { included.add(row.key); changed = true }
      }
    }
    return rows.filter(row => included.has(row.key));
  }

  static build(threadId: string | undefined, rows: readonly AgentStateRow[], entries: readonly ResultEntry[], records: readonly ResultActivityRecord[] = []): ThreadWorkstream[] {
    const nodes = new Map<string, ThreadMilestone>();
    for (const entry of entries) {
      const key = this.key(entry.item);
      if (!nodes.has(key)) nodes.set(key, { key, title: entry.item.label, report: entry.item, messageId: entry.messageId });
    }
    for (const row of this.scope(threadId, rows, entries)) {
      const previous = nodes.get(row.key);
      nodes.set(row.key, { ...previous, key: row.key, title: row.label || previous?.title || 'Delegated task', row });
    }
    const links = new Map(records.map(record => [this.key(record), record]));
    for (const node of nodes.values()) {
      const follow = node.row?.followUpOf ?? links.get(node.key)?.followUpOf ?? node.report?.followUpOf;
      const parent = follow ? this.key(follow) : node.row?.parentJobId !== null && node.row?.parentJobId !== undefined && node.row?.parentTaskIndex !== null && node.row?.parentTaskIndex !== undefined ? `${ node.row.parentJobId }:${ node.row.parentTaskIndex }` : undefined;
      if (parent && parent !== node.key && nodes.has(parent)) node.parent = parent;
    }
    const roots = new Map<string, ThreadMilestone[]>();
    for (const node of nodes.values()) {
      const visited = new Set([node.key]);
      let root = node;
      while (root.parent && nodes.has(root.parent) && !visited.has(root.parent)) { root = nodes.get(root.parent)!; visited.add(root.key) }
      if (root.parent && visited.has(root.parent)) root = node; // Malformed cycles cannot hide work.
      const steps = roots.get(root.key) ?? [];
      steps.push(node); roots.set(root.key, steps);
    }
    return [...roots].map(([key, steps]) => {
      const at = (node: ThreadMilestone) => node.report?.endedAt ?? (Date.parse(node.row?.lastActivityAt ?? '') || 0);
      steps.sort((a, b) => Number(this.active(b.row)) - Number(this.active(a.row)) || at(a) - at(b) || a.key.localeCompare(b.key));
      return { key, title: nodes.get(key)!.title, steps, current: steps.some(step => this.active(step.row)), at: Math.max(...steps.map(at)) };
    }).sort((a, b) => Number(b.current) - Number(a.current) || b.at - a.at || a.key.localeCompare(b.key));
  }

  static label(step: ThreadMilestone): string {
    const state = step.row?.state;
    if (this.active(step.row)) return ({ queued: 'Queued', working: 'Working', parked: 'Waiting', quiet: 'Status needs checking', lost: 'Status needs checking', blocked: 'Reported blocker' } as Record<string, string>)[state!] ?? 'Status needs checking';
    if (step.report) return step.report.verdict ? `Reported: ${ step.report.verdict }` : 'Result reported';
    return state === 'done' ? 'Result returned' : state === 'failed' ? 'Execution failed' : state === 'stopped' ? 'Stopped' : 'Earlier task';
  }

  static detail(step: ThreadMilestone): string {
    if (this.active(step.row)) return step.row!.waitReason || step.row!.lastCheckinSummary || step.row!.stateReason || 'Waiting for the next agent update.';
    return step.report?.outcome || step.row?.lastCheckinSummary || step.row?.stateReason || 'No outcome report is recorded here.';
  }
}
