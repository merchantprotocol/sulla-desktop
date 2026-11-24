// SPDX-License-Identifier: GPL-2.0-or-later
import { computed, type ComputedRef, type InjectionKey, type Ref } from 'vue';

import type { DecisionRecord } from '@pkg/shared/decisions';
import type { AgentStateSnapshot } from '@pkg/shared/agentState/AgentStateSnapshot';
import {
  ThreadAgentActivityPresenter,
  type PresentedThreadAgent,
  type ThreadAgentActivityNode,
  type ThreadAgentActivityProjection,
} from '@pkg/services/agentState/ThreadAgentActivityPresenter';
import type { StatusRollupItem } from '../components/composer/StatusRollupQueue';
import type { WorkerChartAgent, WorkerChartState } from '../components/workerChart/workerChartModel';

export interface ThreadAgentActivitySources {
  readonly snapshot: Readonly<Ref<AgentStateSnapshot>>;
  readonly threadId: Readonly<Ref<string | undefined>>;
  readonly decisions?: Readonly<Ref<readonly DecisionRecord[]>>;
  readonly now?: () => number;
}

/** Reactive view-model shared by ChatPage, the composer status line, and WorkerChart. */
export interface ThreadAgentActivity {
  readonly projection: ComputedRef<ThreadAgentActivityProjection>;
  readonly checkIns: ComputedRef<StatusRollupItem[]>;
  readonly rootFallback: ComputedRef<StatusRollupItem | null>;
  readonly chartRoot: ComputedRef<WorkerChartAgent | null>;
}

export const THREAD_AGENT_ACTIVITY_KEY: InjectionKey<ThreadAgentActivity> = Symbol('ThreadAgentActivity');

/** Adapts one already thread-scoped presenter projection into the two chat surfaces. */
class ThreadAgentActivityMapper {
  checkIns(projection: ThreadAgentActivityProjection, threadId: string | undefined): StatusRollupItem[] {
    if (!threadId) return [];
    return projection.agents.flatMap(agent => agent.checkins.flatMap((checkin, index) => {
      const observedAt = Date.parse(checkin.at);
      if (!Number.isFinite(observedAt)) return [];
      return [this.statusItem(agent, threadId, checkin.summary, observedAt, `${agent.row.key}:${checkin.at}:${index}`)];
    }));
  }

  rootFallback(projection: ThreadAgentActivityProjection, threadId: string | undefined, now: number): StatusRollupItem | null {
    if (!threadId || projection.scope === 'empty') return null;
    const ownRows = projection.agents.filter(agent => agent.row.threadId === threadId);
    // A fallback is only safe when the active thread identifies exactly one of its own agent rows.
    if (ownRows.length !== 1) return null;
    const ownRoot = ownRows[0];
    const lastText = ownRoot.row.lastCheckinSummary?.trim() || ownRoot.row.stateReason?.trim() || this.stateText(ownRoot.row.state);
    const observedAt = this.timestamp(ownRoot.row.lastCheckinAt ?? ownRoot.row.lastActivityAt, now) ?? now;
    return this.statusItem(ownRoot, threadId, lastText, observedAt, `${ownRoot.row.key}:fallback`, 'root');
  }

  chartRoot(projection: ThreadAgentActivityProjection, threadId: string | undefined): WorkerChartAgent | null {
    if (!threadId || projection.scope === 'empty' || !projection.roots.length) return null;

    const roots = projection.roots.map(node => this.chartNode(node));
    if (projection.scope === 'child' && roots.length === 1) return roots[0];

    // A root chat can launch several independent top-level jobs. Keep every
    // scoped tree visible under the chat's virtual root instead of dropping siblings.
    return {
      id: `chat:${threadId}`,
      name: 'Sulla',
      initials: 'S',
      state: this.aggregateState(roots),
      children: roots,
    };
  }

  private statusItem(
    agent: PresentedThreadAgent,
    threadId: string,
    text: string,
    observedAt: number,
    key: string,
    role: StatusRollupItem['role'] = 'worker',
  ): StatusRollupItem {
    return {
      key,
      threadId,
      agentId: agent.row.key,
      agentName: agent.row.label?.trim() || agent.row.agentId || 'Agent',
      lane: agent.lane,
      text,
      observedAt,
      urgency: agent.urgency,
      role,
    };
  }

  private chartNode(node: ThreadAgentActivityNode): WorkerChartAgent {
    const { agent } = node;
    const row = agent.row;
    const latestCheckin = agent.checkins[agent.checkins.length - 1];
    return {
      id: row.key,
      name: row.label?.trim() || row.agentId || 'Agent',
      initials: agent.initials,
      lane: agent.lane,
      state: this.chartState(agent),
      model: row.modelStatus?.model ?? null,
      task: row.stateReason || row.lastCheckinSummary || undefined,
      startedAt: this.timestamp(row.startedAt),
      finishedAt: this.timestamp(row.endedAt),
      lastCheckIn: latestCheckin ? { timestamp: this.timestamp(latestCheckin.at)!, text: latestCheckin.summary } : null,
      activity: agent.activity.flatMap(value => {
        const timestamp = this.timestamp(value);
        return timestamp === null ? [] : [{ timestamp, value: 1 }];
      }),
      children: node.children.map(child => this.chartNode(child)),
    };
  }

  private chartState(agent: PresentedThreadAgent): WorkerChartState {
    if (agent.urgency === 'failed' || agent.state === 'lost') return 'failed';
    if (agent.urgency === 'needs-you') return 'needs-you';
    if (agent.state === 'parked') return 'parked';
    if (agent.state === 'done' || agent.state === 'stopped') return 'done';
    return 'working';
  }

  private aggregateState(roots: readonly WorkerChartAgent[]): WorkerChartState {
    const states = roots.map(root => root.state);
    if (states.includes('failed')) return 'failed';
    if (states.includes('needs-you')) return 'needs-you';
    if (states.includes('working')) return 'working';
    if (states.includes('parked')) return 'parked';
    return 'done';
  }

  private timestamp(value: string | null | undefined, fallback?: number): number | null {
    if (!value) return fallback ?? null;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : fallback ?? null;
  }

  private stateText(state: PresentedThreadAgent['state']): string {
    switch (state) {
      case 'queued': return 'Starting';
      case 'working': return 'Working';
      case 'parked': return 'Parked';
      case 'quiet': return 'Quiet';
      case 'blocked': return 'Needs you';
      case 'failed': return 'Failed';
      case 'lost': return 'Not reporting';
      case 'stopped': return 'Stopped';
      case 'done': return 'Complete';
    }
  }
}

export function useThreadAgentActivity(sources: ThreadAgentActivitySources): ThreadAgentActivity {
  const presenter = new ThreadAgentActivityPresenter();
  const mapper = new ThreadAgentActivityMapper();
  const now = sources.now ?? Date.now;
  const projection = computed(() => presenter.project(
    sources.snapshot.value,
    sources.threadId.value,
    now(),
    sources.decisions?.value ?? [],
  ));

  return {
    projection,
    checkIns: computed(() => mapper.checkIns(projection.value, sources.threadId.value)),
    rootFallback: computed(() => mapper.rootFallback(projection.value, sources.threadId.value, now())),
    chartRoot: computed(() => mapper.chartRoot(projection.value, sources.threadId.value)),
  };
}
