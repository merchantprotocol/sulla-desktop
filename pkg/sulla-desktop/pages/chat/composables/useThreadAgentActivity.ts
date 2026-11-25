// SPDX-License-Identifier: GPL-2.0-or-later
import { computed, getCurrentScope, onScopeDispose, ref, watch, type ComputedRef, type InjectionKey, type Ref } from 'vue';

import type { DecisionRecord } from '@pkg/shared/decisions';
import type { AgentStateSnapshot } from '@pkg/shared/agentState/AgentStateSnapshot';
import type { AgentTraceHistoryData } from '@pkg/agent/app/Services/AgentTraceHistory';
import {
  ThreadAgentActivityPresenter,
  type PresentedThreadAgent,
  type ThreadAgentActivityNode,
  type ThreadAgentActivityProjection,
} from '@pkg/services/agentState/ThreadAgentActivityPresenter';
import type { StatusRollupItem, StatusRollupKind } from '../components/composer/StatusRollupQueue';
import { DetailedTraceProjection } from '../components/transcript/DetailedTraceProjection';
import type { TraceRow } from '../components/transcript/traceTypes';
import type { Message } from '../models/Message';
import type { WorkerChartAgent, WorkerChartState } from '../components/workerChart/workerChartModel';

export interface ThreadAgentActivitySources {
  readonly snapshot: Readonly<Ref<AgentStateSnapshot>>;
  readonly threadId: Readonly<Ref<string | undefined>>;
  readonly decisions?: Readonly<Ref<readonly DecisionRecord[]>>;
  readonly now?: () => number;
  /** This chat's own transcript (ChatController.messages): primary-agent trace rows. */
  readonly transcript?: Readonly<Ref<readonly Message[]>>;
  /** Display name of this chat's primary agent (persona name, or "Sulla"). */
  readonly primaryAgentName?: Readonly<Ref<string>>;
  /** Existing thread-authorized trace-history IPC: full check-ins and messages sent to each task. */
  readonly traceHistory?: (parentThreadId: string, jobId: string, taskIndex: number) => Promise<AgentTraceHistoryData | null>;
}

/** Reactive view-model shared by ChatPage, the composer status line, and WorkerChart. */
export interface ThreadAgentActivity {
  readonly projection: ComputedRef<ThreadAgentActivityProjection>;
  /** Lossless event stream for this chat's own transcript and proven sub-agent tree, oldest first. */
  readonly checkIns: ComputedRef<StatusRollupItem[]>;
  readonly rootFallback: ComputedRef<StatusRollupItem | null>;
  readonly chartRoot: ComputedRef<WorkerChartAgent | null>;
}

export const THREAD_AGENT_ACTIVITY_KEY: InjectionKey<ThreadAgentActivity> = Symbol('ThreadAgentActivity');

/** Adapts the detailed transcript, scoped live snapshots, and authorized trace history into line events. */
class ThreadAgentActivityMapper {
  private readonly traceProjection = new DetailedTraceProjection();

  checkins(projection: ThreadAgentActivityProjection, threadId: string): StatusRollupItem[] {
    return projection.agents.flatMap(agent => agent.checkins.flatMap(checkin => {
      const observedAt = Date.parse(checkin.at);
      if (!Number.isFinite(observedAt)) return [];
      return [this.statusItem(agent, threadId, this.checkinText('', checkin.summary), observedAt,
        `agent-checkin:${threadId}:${agent.row.key}:${checkin.at}:${checkin.summary}`, 'agent')];
    }));
  }

  primaryTrace(messages: readonly Message[], threadId: string, agentName: string, now: number): StatusRollupItem[] {
    const byId = new Map(messages.map(message => [String(message.id), message]));
    const rows = this.traceProjection.project(messages, []).flatMap(turn => turn.rows);
    const items = rows.map(row => this.traceItem(row, byId, threadId, agentName, now));
    for (const message of messages) {
      if (message.kind === 'streaming') {
        items.push({
          key: `reply-start:${threadId}:${String(message.id)}`,
          threadId,
          agentId: `chat:${threadId}`,
          agentName: agentName.trim() || 'Sulla',
          kind: 'reply',
          text: 'Writing a reply',
          observedAt: message.startedAt || message.createdAt,
          urgency: 'normal',
          role: 'root',
        });
      } else if (message.kind === 'subagent_exchange' && message.direction === 'to_agent') {
        items.push({
          key: `agent-brief:${threadId}:${String(message.id)}`,
          threadId,
          agentId: message.jobId ? `${message.jobId}:${message.taskIndex ?? 0}` : message.agentId,
          agentName: message.label || message.agentId,
          kind: 'agent',
          text: `Brief sent${message.summary ? `: ${message.summary}` : ''}`,
          observedAt: message.createdAt,
          urgency: 'normal',
          role: 'worker',
        });
      }
    }
    return items.sort((left, right) => left.observedAt - right.observedAt);
  }

  history(agent: PresentedThreadAgent, history: AgentTraceHistoryData, threadId: string): StatusRollupItem[] {
    const items: StatusRollupItem[] = [
      ...history.checkins.map(checkin => this.statusItem(agent, threadId,
        this.checkinText(checkin.step, checkin.summary), checkin.createdAt,
        `agent-checkin:${threadId}:${agent.row.key}:${new Date(checkin.createdAt).toISOString()}:${checkin.summary}`, 'agent')),
      ...history.messages.map(message => this.statusItem(agent, threadId, `Message sent: ${message.message}`, message.createdAt,
        `agent-message:${threadId}:${agent.row.key}:${message.createdAt}:${message.message}`, 'agent')),
    ];
    return items.filter(item => Number.isFinite(item.observedAt)).sort((left, right) => left.observedAt - right.observedAt);
  }

  state(agent: PresentedThreadAgent, threadId: string, at: number, key: string): StatusRollupItem {
    const { row } = agent;
    const label = this.stateLabel(agent.state);
    const detail = row.stateReason?.trim();
    return this.statusItem(agent, threadId, detail && ['blocked', 'failed', 'lost', 'stopped'].includes(agent.state)
      ? `${label}: ${detail}` : label, at, key, 'agent');
  }

  tool(agent: PresentedThreadAgent, threadId: string, name: string, at: number, key: string, phase: 'started' | 'finished' | 'failed', correlationId: string): StatusRollupItem {
    const kind = this.toolKind(name);
    const item = this.statusItem(agent, threadId, `${phase === 'started' ? 'Running' : phase === 'failed' ? 'Failed' : 'Finished'} ${name}`,
      at, key, kind);
    return {
      ...item,
      phase: phase === 'started' ? 'start' : 'result',
      correlationId,
      ...(phase === 'failed' ? { urgency: 'failed' as const } : {}),
    };
  }

  liveActivity(agent: PresentedThreadAgent, threadId: string, at: number, key: string): StatusRollupItem {
    return this.statusItem(agent, threadId, agent.row.stateReason?.trim() || this.stateLabel(agent.state), at, key, 'status');
  }

  rootFallback(projection: ThreadAgentActivityProjection, threadId: string | undefined, now: number): StatusRollupItem | null {
    if (!threadId || projection.scope === 'empty') return null;
    const ownRows = projection.agents.filter(agent => agent.row.threadId === threadId);
    // A fallback is only safe when the active thread identifies exactly one of its own agent rows.
    if (ownRows.length !== 1) return null;
    const ownRoot = ownRows[0];
    const lastText = ownRoot.row.lastCheckinSummary?.trim() || ownRoot.row.stateReason?.trim() || this.stateLabel(ownRoot.row.state);
    const observedAt = this.timestamp(ownRoot.row.lastCheckinAt ?? ownRoot.row.lastActivityAt, now) ?? now;
    return this.statusItem(ownRoot, threadId, lastText, observedAt, `${ownRoot.row.key}:fallback`, 'status', 'root');
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

  private traceItem(row: TraceRow, byId: ReadonlyMap<string, Message>, threadId: string, agentName: string, now: number): StatusRollupItem {
    const message = byId.get(String(row.id));
    const agentRow = row.kind === 'subagent' ? row.subagent : undefined;
    const name = row.kind === 'subagent' ? row.target : agentName.trim() || 'Sulla';
    const kind = this.traceKind(row, message);
    const text = this.traceText(row, message);
    const at = Number.isFinite(row.at) ? row.at! : now;
    const state = row.status;
    const urgency = state === 'failed' ? 'failed' : state === 'blocked' || state === 'waiting' ? 'needs-you' : 'normal';
    return {
      key: `trace:${threadId}:${row.id}:${state}:${row.verb}:${row.target}`,
      threadId,
      agentId: agentRow?.jobId ? `${agentRow.jobId}:${agentRow.taskIndex ?? 0}` : `chat:${threadId}`,
      agentName: name,
      kind,
      text,
      observedAt: at,
      urgency,
      role: agentRow ? 'worker' : 'root',
      ...(row.kind === 'tool' ? { phase: state === 'running' ? 'start' as const : 'result' as const, correlationId: `primary:${threadId}:${row.id}` } : {}),
    };
  }

  private traceKind(row: TraceRow, message?: Message): StatusRollupKind {
    if (row.kind === 'thought') return 'thought';
    if (row.kind === 'activity' || row.kind === 'approval' || row.kind === 'heartbeat') return 'status';
    if (row.kind === 'source') return 'read';
    if (row.kind === 'tool' && message?.kind === 'tool') return this.toolKind(message.recordedToolName ?? message.tool);
    if (row.kind === 'subagent') return 'agent';
    return row.kind === 'memory' ? 'edit' : 'status';
  }

  private traceText(row: TraceRow, message?: Message): string {
    switch (row.kind) {
      case 'tool': {
        if (message?.kind !== 'tool') return `${row.verb} ${row.target}`;
        return message.desc?.trim() || message.recordedToolName || message.tool;
      }
      case 'thought': return row.target;
      case 'activity': return row.target;
      case 'source': return `${row.verb}: ${row.target}`;
      case 'approval': {
        const reason = message?.kind === 'tool_approval' ? message.reason : row.target;
        return `${row.status === 'waiting' ? 'Needs you' : 'Approval'}: ${reason}`;
      }
      case 'subagent': return `${row.status}${row.note ? `: ${row.note}` : ''}`;
      case 'heartbeat': return `${row.verb}: ${row.target}`;
      case 'memory': return `${row.verb}: ${row.target}`;
      default: return `${row.verb}: ${row.target}`;
    }
  }

  private statusItem(
    agent: PresentedThreadAgent,
    threadId: string,
    text: string,
    observedAt: number,
    key: string,
    kind: StatusRollupKind,
    role?: StatusRollupItem['role'],
  ): StatusRollupItem {
    return {
      key,
      threadId,
      agentId: agent.row.key,
      agentName: agent.row.label?.trim() || agent.row.agentId || 'Agent',
      lane: agent.lane,
      kind,
      text,
      observedAt,
      urgency: agent.urgency,
      role: role ?? (agent.row.waitingOnChildren > 0 ? 'manager' : 'worker'),
    };
  }

  private checkinText(step: string, summary: string): string {
    return step && step !== summary ? `${step}: ${summary}` : summary;
  }

  private toolKind(name: string): StatusRollupKind {
    if (/^(?:Read|Glob|Grep|LS|Search|Fetch|Browser)/i.test(name)) return 'read';
    if (/^(?:Edit|Write|Patch|Replace)/i.test(name)) return 'edit';
    if (/^(?:Bash|exec|run|shell)/i.test(name)) return 'run';
    return 'tool';
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

  private stateLabel(state: PresentedThreadAgent['state']): string {
    switch (state) {
      case 'queued': return 'Starting';
      case 'working': return 'Working';
      case 'parked': return 'Working';
      case 'quiet': return 'Quiet';
      case 'blocked': return 'Needs you';
      case 'failed': return 'Failed';
      case 'lost': return 'Not reporting';
      case 'stopped': return 'Stopped';
      case 'done': return 'Returned';
    }
  }

  timestamp(value: string | null | undefined, fallback?: number): number | null {
    if (!value) return fallback ?? null;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : fallback ?? null;
  }
}

export function useThreadAgentActivity(sources: ThreadAgentActivitySources): ThreadAgentActivity {
  const presenter = new ThreadAgentActivityPresenter();
  const eventPresenter = new ThreadAgentActivityPresenter();
  const mapper = new ThreadAgentActivityMapper();
  const now = sources.now ?? Date.now;
  const projection = computed(() => presenter.project(
    sources.snapshot.value,
    sources.threadId.value,
    now(),
    sources.decisions?.value ?? [],
  ));
  const eventItems = ref<StatusRollupItem[]>([]);
  const seenEventKeys = new Set<string>();
  const previousRows = new Map<string, PresentedThreadAgent>();
  const historySeen = new Map<string, Set<string>>();
  const historyPrimed = new Set<string>();
  const historyPending = new Set<string>();
  const historyRefreshQueued = new Set<string>();
  let activeThreadId: string | undefined;
  let snapshotPrimed = false;
  let transcriptPrimed = false;
  let historyTimer: ReturnType<typeof setInterval> | undefined;

  const resetThread = (threadId: string | undefined): void => {
    if (activeThreadId === threadId) return;
    if (historyTimer !== undefined) clearInterval(historyTimer);
    historyTimer = undefined;
    activeThreadId = threadId;
    eventItems.value = [];
    seenEventKeys.clear();
    previousRows.clear();
    historySeen.clear();
    historyPrimed.clear();
    historyPending.clear();
    historyRefreshQueued.clear();
    snapshotPrimed = false;
    transcriptPrimed = false;
  };

  const append = (item: StatusRollupItem): void => {
    if (!activeThreadId || item.threadId !== activeThreadId || seenEventKeys.has(item.key)) return;
    seenEventKeys.add(item.key);
    eventItems.value = [...eventItems.value, item].sort((left, right) => left.observedAt - right.observedAt);
  };

  const stateEvent = (agent: PresentedThreadAgent, threadId: string, version: number, at: number): StatusRollupItem =>
    mapper.state(agent, threadId, at, `agent-state:${threadId}:${agent.row.key}:${version}:${agent.state}`);

  const observeSnapshot = (snapshot: AgentStateSnapshot, threadId: string): PresentedThreadAgent[] => {
    const view = eventPresenter.project(snapshot, threadId, now(), sources.decisions?.value ?? []);
    const currentRows = new Map<string, PresentedThreadAgent>();
    const snapshotAt = mapper.timestamp(snapshot.generatedAt, now()) ?? now();

    for (const agent of view.agents) {
      const { row } = agent;
      const previous = previousRows.get(row.key);
      const tool = row.toolInFlight;
      const previousTool = previous?.row.toolInFlight;
      const checkinChanged = !previous || row.lastCheckinAt !== previous.row.lastCheckinAt || row.lastCheckinSummary !== previous.row.lastCheckinSummary;
      const toolChanged = Boolean(previousTool) !== Boolean(tool) || Boolean(previousTool && tool &&
        (previousTool.name !== tool.name || previousTool.since !== tool.since));
      const stateChanged = !previous || previous.state !== agent.state;

      if (!snapshotPrimed || !previous) {
        append(stateEvent(agent, threadId, snapshot.version, mapper.timestamp(row.lastActivityAt, snapshotAt) ?? snapshotAt));
        if (tool?.name?.trim()) append(mapper.tool(agent, threadId, tool.name.trim(), mapper.timestamp(tool.since, snapshotAt) ?? snapshotAt,
          `agent-tool-start:${threadId}:${row.key}:${tool.since}:${tool.name}:${snapshot.version}`, 'started', `agent:${threadId}:${row.key}:${tool.since}:${tool.name}`));
      } else {
        if (stateChanged) append(stateEvent(agent, threadId, snapshot.version, snapshotAt));
        if (toolChanged) {
          if (previousTool?.name?.trim()) {
            append(mapper.tool(previous, threadId, previousTool.name.trim(), mapper.timestamp(row.lastActivityAt, snapshotAt) ?? snapshotAt,
              `agent-tool-finish:${threadId}:${row.key}:${previousTool.since}:${previousTool.name}:${snapshot.version}`,
              agent.state === 'failed' ? 'failed' : 'finished', `agent:${threadId}:${row.key}:${previousTool.since}:${previousTool.name}`));
          }
          if (tool?.name?.trim()) append(mapper.tool(agent, threadId, tool.name.trim(), mapper.timestamp(tool.since, snapshotAt) ?? snapshotAt,
            `agent-tool-start:${threadId}:${row.key}:${tool.since}:${tool.name}:${snapshot.version}`, 'started', `agent:${threadId}:${row.key}:${tool.since}:${tool.name}`));
        }
        if (!sources.traceHistory && checkinChanged && row.lastCheckinAt && row.lastCheckinSummary?.trim()) {
          append(mapper.checkins({ ...view, agents: [{ ...agent, checkins: [{ at: row.lastCheckinAt, summary: row.lastCheckinSummary.trim() }] }] }, threadId)[0]);
        }
        if (!stateChanged && !toolChanged && !checkinChanged && row.lastActivityAt !== previous.row.lastActivityAt) {
          append(mapper.liveActivity(agent, threadId, mapper.timestamp(row.lastActivityAt, snapshotAt) ?? snapshotAt,
            `agent-activity:${threadId}:${row.key}:${row.lastActivityAt}`));
        }
      }

      if (!sources.traceHistory && row.lastCheckinAt && row.lastCheckinSummary?.trim()) {
        for (const item of mapper.checkins({ ...view, agents: [{ ...agent, checkins: [{ at: row.lastCheckinAt, summary: row.lastCheckinSummary.trim() }] }] }, threadId)) append(item);
      }
      currentRows.set(row.key, agent);
    }

    previousRows.clear();
    for (const [key, agent] of currentRows) previousRows.set(key, agent);
    snapshotPrimed = true;
    return view.agents as PresentedThreadAgent[];
  };

  const historyEvents = (agent: PresentedThreadAgent, data: AgentTraceHistoryData, threadId: string): void => {
    const key = `${agent.row.jobId}:${agent.row.taskIndex}`;
    const items = mapper.history(agent, data, threadId);
    let known = historySeen.get(key);
    const firstRead = !historyPrimed.has(key);
    if (!known) { known = new Set<string>(); historySeen.set(key, known); }
    if (firstRead) {
      const latest = items[items.length - 1];
      for (const item of items) {
        known.add(item.key);
        if (item === latest) append(item);
        else seenEventKeys.add(item.key);
      }
      historyPrimed.add(key);
      return;
    }
    for (const item of items) {
      if (known.has(item.key)) continue;
      known.add(item.key);
      append(item);
    }
  };

  const loadHistory = (agent: PresentedThreadAgent, threadId: string): void => {
    const load = sources.traceHistory;
    if (!load) return;
    const key = `${agent.row.jobId}:${agent.row.taskIndex}`;
    if (historyPending.has(key)) { historyRefreshQueued.add(key); return; }
    historyPending.add(key);
    void load(threadId, agent.row.jobId, agent.row.taskIndex).then(data => {
      if (!data || activeThreadId !== threadId) return;
      historyEvents(agent, data, threadId);
    }).catch(() => {
      // The live snapshot and transcript remain usable if the optional history IPC is unavailable.
    }).finally(() => {
      historyPending.delete(key);
      if (!historyRefreshQueued.delete(key) || activeThreadId !== threadId) return;
      const latest = eventPresenter.project(sources.snapshot.value, threadId, now(), sources.decisions?.value ?? [])
        .agents.find(candidate => `${candidate.row.jobId}:${candidate.row.taskIndex}` === key);
      if (latest) loadHistory(latest, threadId);
    });
  };

  const refreshHistory = (agents: readonly PresentedThreadAgent[], threadId: string): void => {
    for (const agent of agents) loadHistory(agent, threadId);
  };

  const setHistoryTimer = (agents: readonly PresentedThreadAgent[], threadId: string): void => {
    if (!sources.traceHistory || !getCurrentScope()) return;
    const hasLiveAgent = agents.some(agent => !['done', 'failed', 'lost', 'stopped'].includes(agent.state));
    if (hasLiveAgent && historyTimer === undefined) {
      historyTimer = setInterval(() => {
        if (activeThreadId !== threadId) return;
        const latest = eventPresenter.project(sources.snapshot.value, threadId, now(), sources.decisions?.value ?? []);
        refreshHistory(latest.agents, threadId);
      }, 1_500);
    } else if (!hasLiveAgent && historyTimer !== undefined) {
      clearInterval(historyTimer);
      historyTimer = undefined;
    }
  };

  watch(() => [sources.threadId.value, sources.snapshot.value] as const, ([threadId, snapshot]) => {
    resetThread(threadId);
    if (!threadId) return;
    const agents = observeSnapshot(snapshot, threadId);
    refreshHistory(agents, threadId);
    setHistoryTimer(agents, threadId);
  }, { immediate: true, flush: 'sync' });

  watch(() => [sources.threadId.value, sources.transcript?.value ?? [], sources.primaryAgentName?.value ?? 'Sulla'] as const,
    ([threadId, messages, agentName]) => {
      resetThread(threadId);
      if (!threadId || !messages.length) return;
      const items = mapper.primaryTrace(messages, threadId, agentName, now());
      if (!transcriptPrimed) {
        const latest = items[items.length - 1];
        for (const item of items) {
          if (item === latest) append(item);
          else seenEventKeys.add(item.key);
        }
        transcriptPrimed = true;
        return;
      }
      items.forEach(append);
    }, { immediate: true, deep: true, flush: 'pre' });

  if (getCurrentScope()) onScopeDispose(() => {
    if (historyTimer !== undefined) clearInterval(historyTimer);
    historyTimer = undefined;
  });

  return {
    projection,
    checkIns: computed(() => eventItems.value),
    rootFallback: computed(() => mapper.rootFallback(projection.value, sources.threadId.value, now())),
    chartRoot: computed(() => mapper.chartRoot(projection.value, sources.threadId.value)),
  };
}
