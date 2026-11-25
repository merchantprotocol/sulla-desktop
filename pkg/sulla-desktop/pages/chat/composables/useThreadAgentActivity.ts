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
import type { Message } from '../models/Message';
import type { WorkerChartAgent, WorkerChartRole, WorkerChartState } from '../components/workerChart/workerChartModel';

export interface ThreadAgentActivitySources {
  readonly snapshot: Readonly<Ref<AgentStateSnapshot>>;
  readonly threadId: Readonly<Ref<string | undefined>>;
  readonly decisions?: Readonly<Ref<readonly DecisionRecord[]>>;
  readonly now?: () => number;
  /** This chat's own transcript (ChatController.messages): the primary agent's tool calls and steps. */
  readonly transcript?: Readonly<Ref<readonly Message[]>>;
  /** Display name of this chat's primary agent (persona name, or "Sulla"). */
  readonly primaryAgentName?: Readonly<Ref<string>>;
}

/** Reactive view-model shared by ChatPage, the composer status line, and WorkerChart. */
export interface ThreadAgentActivity {
  readonly projection: ComputedRef<ThreadAgentActivityProjection>;
  /** Every activity item in this chat, oldest first: primary-agent transcript steps plus sub-agent check-ins and live tools. */
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

  /** Sub-agent live activity beyond explicit check-ins: tools in flight and activity samples. */
  liveActivity(projection: ThreadAgentActivityProjection, threadId: string | undefined): StatusRollupItem[] {
    if (!threadId) return [];
    return projection.agents.flatMap(agent => {
      const items: StatusRollupItem[] = [];
      const tool = agent.row.toolInFlight;
      const toolAt = this.timestamp(tool?.since);
      if (tool?.name?.trim() && toolAt !== null) {
        items.push(this.statusItem(agent, threadId, `Running ${tool.name.trim()}`, toolAt, `${agent.row.key}:tool:${tool.since}:${tool.name}`));
      }
      // A check-in or tool start also bumps lastActivityAt. Only the newest sample that is
      // later than everything already shown says something new ("still working since then").
      const latestShown = Math.max(
        toolAt ?? Number.NEGATIVE_INFINITY,
        ...agent.checkins.map(checkin => this.timestamp(checkin.at) ?? Number.NEGATIVE_INFINITY),
      );
      const latestAt = agent.activity[agent.activity.length - 1];
      const observedAt = this.timestamp(latestAt);
      if (latestAt && observedAt !== null && observedAt > latestShown) {
        const text = agent.row.stateReason?.trim() || this.stateText(agent.state);
        items.push(this.statusItem(agent, threadId, text, observedAt, `${agent.row.key}:activity:${latestAt}`));
      }
      return items;
    });
  }

  /** The primary agent's own steps, read from this chat's transcript. Keys are message ids, so each step appears once. */
  primaryActivity(messages: readonly Message[], threadId: string | undefined, agentName: string): StatusRollupItem[] {
    if (!threadId) return [];
    const recent = messages.slice(-ThreadAgentActivityMapper.transcriptWindow);
    return recent.flatMap(message => {
      const step = this.transcriptStep(message);
      if (!step) return [];
      return [{
        key: `transcript:${threadId}:${String(message.id)}`,
        threadId,
        agentId: `chat:${threadId}`,
        agentName: agentName.trim() || 'Sulla',
        text: step.text,
        observedAt: step.at,
        urgency: 'normal' as const,
        role: 'root' as const,
      }];
    });
  }

  private static readonly transcriptWindow = 40;

  private transcriptStep(message: Message): { text: string; at: number } | null {
    switch (message.kind) {
      case 'tool': {
        // desc is the readable tool-card description ("Reading X"); never the raw input JSON.
        const text = message.desc?.trim() || message.tool?.trim();
        return text ? { text, at: message.createdAt } : null;
      }
      case 'thinking': {
        // Only published status/tool activity; private reasoning thoughts stay out of the status line.
        if (!message.reportingActivity) return null;
        const text = message.summary?.trim() || message.thoughts[message.thoughts.length - 1]?.trim();
        return text ? { text, at: message.startedAt || message.createdAt } : null;
      }
      case 'streaming':
        return { text: 'Writing a reply', at: message.startedAt || message.createdAt };
      default:
        return null;
    }
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
    if (projection.scope === 'child' && roots.length === 1) return { ...roots[0], role: 'main' };

    // A root chat can launch several independent top-level jobs. Keep every
    // scoped tree visible under the chat's virtual root instead of dropping siblings.
    return {
      id: `chat:${threadId}`,
      name: 'Sulla',
      initials: 'S',
      role: 'main',
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
      role: this.chartRole(agent),
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

  private chartRole(agent: PresentedThreadAgent): WorkerChartRole {
    const identity = `${agent.row.agentId ?? ''} ${agent.row.label} ${agent.row.modelStatus?.model ?? ''}`.toLowerCase();
    if (identity.includes('opus') || identity.includes('review')) return 'rev';
    if (identity.includes('manager')) return 'mgr';
    return 'wrk';
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
    checkIns: computed(() => {
      const threadId = sources.threadId.value;
      const items = [
        ...mapper.primaryActivity(sources.transcript?.value ?? [], threadId, sources.primaryAgentName?.value ?? 'Sulla'),
        ...mapper.checkIns(projection.value, threadId),
        ...mapper.liveActivity(projection.value, threadId),
      ];
      const seen = new Set<string>();
      return items
        .filter(item => !seen.has(item.key) && (seen.add(item.key), true))
        .sort((left, right) => left.observedAt - right.observedAt);
    }),
    rootFallback: computed(() => mapper.rootFallback(projection.value, sources.threadId.value, now())),
    chartRoot: computed(() => mapper.chartRoot(projection.value, sources.threadId.value)),
  };
}
