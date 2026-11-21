// SPDX-License-Identifier: GPL-2.0-or-later

import { AgentWorkTree, type AgentWorkNode } from './AgentWorkTree';
import { ThreadGoalProgress, type ThreadWorkstream } from './ThreadGoalProgress';
import { agentCountSummary, parkedActivity } from './threadActivity';

import { AgentModelStatus, type AgentModelStatusValue } from '@pkg/shared/agentState/AgentModelStatus';
import type { AgentStateRow } from '@pkg/shared/agentState/AgentStateSnapshot';
import type { WorkflowRunRow } from '@pkg/shared/productOwnerWorkflow';

export interface AgentLaneSection {
  key: string; title: string; summary: string; nodes: AgentWorkNode[]; map: boolean; defaultOpen: boolean;
}

interface WorkGroup { key: string; title: string; linked: boolean; nodes: AgentWorkNode[] }
interface JobPlacement { node: AgentWorkNode; section: AgentLaneSection }

export class AgentLaneProjection {
  historyRow(row: WorkflowRunRow): AgentStateRow {
    return {
      ...row, visibility: 'hidden', depth: 0, threadId: null, killedByHuman: false,
      waitingOnChildren: 0, lastActivityAt: row.endedAt ?? row.startedAt ?? '',
      lastCheckinAt: null, lastCheckinSummary: null, canMessage: false, canStop: false, canOpen: false,
    };
  }

  chatLeadRow(
    id: string | undefined,
    rows: readonly AgentStateRow[],
    activeKeys: ReadonlySet<string>,
    message?: { createdAt: number; by?: { agent?: string; modelStatus?: AgentModelStatusValue } },
  ): AgentStateRow | undefined {
    if (!id || !rows.length) return undefined;
    const response = message?.by?.modelStatus;
    const at = rows.map(row => row.startedAt ?? row.lastActivityAt).filter(Boolean).sort()[0] ??
      (message?.createdAt ? new Date(message.createdAt).toISOString() : '');
    const active = rows.some(row => activeKeys.has(row.key));
    return {
      key: `chat-lead-${ id }:0`, jobId: `chat-lead-${ id }`, taskIndex: 0,
      parentJobId: null, parentTaskIndex: null, rootThreadId: id, threadId: id, depth: 0,
      agentId: message?.by?.agent ?? 'Sulla', label: 'Chat lead', visibility: 'tab',
      state: active ? 'working' : 'done', stateReason: null, killedByHuman: false,
      waitingOnChildren: activeKeys.size, startedAt: at,
      endedAt: active ? null : (message?.createdAt ? new Date(message.createdAt).toISOString() : at),
      lastActivityAt: message?.createdAt ? new Date(message.createdAt).toISOString() :
        rows.map(row => row.endedAt ?? row.lastActivityAt).filter(Boolean).sort().at(-1) ?? at,
      lastCheckinAt: null, lastCheckinSummary: active ? 'Coordinating this work' : null,
      responseModels: response?.source === 'resolved' ? [response] : undefined, modelStatus: response,
      canMessage: false, canStop: false, canOpen: false,
    };
  }

  sections(groups: WorkGroup[], finished: AgentStateRow[]): AgentLaneSection[] {
    const list: AgentLaneSection[] = [];
    for (const group of groups) {
      if (group.linked) {
        const layout = AgentWorkTree.layout(group.nodes);
        const agents = group.nodes.filter(node => !node.row.key.startsWith('chat-lead-')).map(node => node.row);
        const count = agents.filter(row => row.state === 'done').length;
        list.push({ ...group, map: layout.style !== 'list', summary: [agentCountSummary(agents), count ? `${ count } returned` : ''].filter(Boolean).join(' · '), defaultOpen: true });
        continue;
      }
      const oldestFirst = [...group.nodes].sort((a, b) => Date.parse(a.row.lastActivityAt) - Date.parse(b.row.lastActivityAt));
      const buckets = [
        { title: 'Quiet', nodes: oldestFirst.filter(({ row }) => row.state === 'quiet') },
        { title: 'Waiting', nodes: group.nodes.filter(({ row }) => row.state === 'parked' || row.state === 'blocked') },
        { title: 'Working', nodes: group.nodes.filter(({ row }) => row.state === 'queued' || row.state === 'working') },
      ].filter(bucket => bucket.nodes.length);
      for (const bucket of buckets) list.push({ ...bucket, key: `unlinked-${ bucket.title }`, title: `${ bucket.title } · unlinked`, summary: String(bucket.nodes.length), map: false, defaultOpen: bucket.title !== 'Working' || (buckets.length === 1 && bucket.nodes.length <= 4) });
    }
    if (finished.length) list.push({ key: 'finished', title: 'Finished', summary: String(finished.length), nodes: finished.map(row => ({ row, links: [] })), map: false, defaultOpen: false });
    return list;
  }

  placements(outcomes: ThreadWorkstream[], jobs: Map<string, JobPlacement>) {
    const byJob = new Map<string, ThreadWorkstream>();
    const bySection = new Map<string, ThreadWorkstream[]>();
    const recent: ThreadWorkstream[] = [];
    const targets = new Map<string, { section?: string; job?: string }>();
    for (const outcome of outcomes) {
      const remaining = outcome.steps.filter(step => {
        const entry = jobs.get(step.key);
        if (!step.report || !entry || entry.section.key === 'finished' || ThreadGoalProgress.key(step.report) !== step.key) return true;
        byJob.set(step.key, { ...outcome, key: step.key, steps: [step] });
        targets.set(step.key, { section: entry.section.key, job: step.key });
        return false;
      });
      if (!remaining.some(step => step.report)) continue;
      const context = new Set(outcome.steps.map(step => jobs.get(step.key)?.section)
        .filter(section => section && section.key !== 'finished' && !section.key.startsWith('unlinked-')).map(section => section!.key));
      const section = context.size === 1 ? [...context][0] : undefined;
      const group = { ...outcome, steps: remaining };
      if (section) bySection.set(section, [...bySection.get(section) ?? [], group]); else recent.push(group);
      for (const step of remaining) if (step.report) targets.set(step.key, { section });
    }
    return { byJob, bySection, recent, targets };
  }

  jobState(row: AgentStateRow): string {
    if (row.key.startsWith('chat-lead-') && row.state === 'working') return 'Coordinating';
    if (row.state === 'parked') return parkedActivity(row).state === 'idle' ? 'Idle' : 'Waiting';
    if (row.state === 'quiet' && row.runtimeAlive === false) return 'No progress';
    return { queued: 'Queued', working: 'Working', quiet: 'Quiet', blocked: 'Blocked', done: 'Returned', failed: 'Failed', lost: 'Unreachable', stopped: 'Stopped' }[row.state];
  }

  responseFor(row: AgentStateRow): AgentModelStatusValue | undefined {
    return row.responseModels?.filter(response => response.model && response.source === 'resolved').at(-1);
  }

  formatModel(model?: AgentModelStatusValue): string {
    return model ? AgentModelStatus.label({ ...model, mapping: undefined, source: 'resolved' }) : '';
  }

  selectionSource(row: AgentStateRow): string {
    return row.modelStatus?.mapping ?? (row.modelStatus?.source === 'requested' ? 'Requested model' : 'Selected model');
  }

  modelCaption(row: AgentStateRow): string {
    const response = this.responseFor(row);
    if (response) return `Response · ${ this.formatModel(response) }`;
    if (row.modelStatus?.model) return `${ this.selectionSource(row) } · ${ this.formatModel(row.modelStatus) }`;
    return 'Model output unavailable';
  }
}
