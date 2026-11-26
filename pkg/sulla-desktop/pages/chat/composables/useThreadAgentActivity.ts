// SPDX-License-Identifier: GPL-2.0-or-later
import { computed, getCurrentScope, onScopeDispose, ref, shallowRef, watch, type ComputedRef, type InjectionKey, type Ref } from 'vue';

import type { DecisionRecord } from '@pkg/shared/decisions';
import type { AgentStateSnapshot } from '@pkg/shared/agentState/AgentStateSnapshot';
import type { AgentTraceHistoryData } from '@pkg/agent/app/Services/AgentTraceHistory';
import {
  ThreadAgentActivityPresenter,
  type PresentedThreadAgent,
  type ThreadAgentActivityProjection,
} from '@pkg/services/agentState/ThreadAgentActivityPresenter';
import { BoundedThreadKeyLedger, type StatusRollupItem, type StatusRollupShownEvent } from '../components/composer/StatusRollupQueue';
import { DetailedTraceProjection } from '../components/transcript/DetailedTraceProjection';
import type { Message } from '../models/Message';
import type { WorkerChartSnippetTick, WorkerChartAgent } from '../components/workerChart/WorkerChartController';
import { ThreadAgentActivityMapper } from './ThreadAgentActivityMapper';
import { ThreadAgentEventBuffer, ThreadAgentEventProjectionDiff, ThreadAgentHistoryCursor } from './ThreadAgentActivityEvents';

export { ThreadAgentEventBuffer, ThreadAgentEventProjectionDiff, ThreadAgentHistoryCursor } from './ThreadAgentActivityEvents';

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
  /** At most the newest live event for this chat's own transcript/sub-agent tree. */
  readonly checkIns: ComputedRef<StatusRollupItem[]>;
  /** Authorized full check-in history for each scoped task, shared with Detailed's inline trace. */
  readonly traceHistories: ComputedRef<ReadonlyMap<string, AgentTraceHistoryData>>;
  /** Starts a fresh timestamp-bounded status-line subscription. */
  attachConsumer(): void;
  /** Stops delivery and discards any transient event when the status-rollup unmounts. */
  detachConsumer(): void;
  /** Removes the transient event after the line has consumed it. */
  consumeCheckIns(): void;
  readonly rootFallback: ComputedRef<StatusRollupItem | null>;
  readonly chartRoot: ComputedRef<WorkerChartAgent | null>;
  readonly snippetTick: Readonly<Ref<WorkerChartSnippetTick | null>>;
  /** Relays each newly shown status snippet as a sequenced chart marker tick. */
  statusItemShown(event: StatusRollupShownEvent): void;
}

export const THREAD_AGENT_ACTIVITY_KEY: InjectionKey<ThreadAgentActivity> = Symbol('ThreadAgentActivity');

export function useThreadAgentActivity(sources: ThreadAgentActivitySources): ThreadAgentActivity {
  const presenter = new ThreadAgentActivityPresenter();
  const eventPresenter = new ThreadAgentActivityPresenter();
  const mapper = new ThreadAgentActivityMapper(new DetailedTraceProjection());
  const now = sources.now ?? Date.now;
  const projection = computed(() => presenter.project(
    sources.snapshot.value,
    sources.threadId.value,
    now(),
    sources.decisions?.value ?? [],
  ));
  const eventBuffer = new ThreadAgentEventBuffer();
  const eventItems = eventBuffer.items;
  const previousRows = new Map<string, PresentedThreadAgent>();
  const snapshotCheckinDiffs = new Map<string, ThreadAgentEventProjectionDiff>();
  const historyCursors = new Map<string, ThreadAgentHistoryCursor>();
  const traceHistoryData = shallowRef<ReadonlyMap<string, AgentTraceHistoryData>>(new Map());
  const traceHistories = computed(() => traceHistoryData.value);
  const historyPrimed = new Set<string>();
  const historyAvailable = new Set<string>();
  const historyPending = new Set<string>();
  const historyRefreshQueued = new Set<string>();
  const transcriptProjection = new ThreadAgentEventProjectionDiff();
  let consumerAttached = false;
  let activeThreadId: string | undefined;
  let subscribedAt = Number.POSITIVE_INFINITY;
  let snapshotPrimed = false;
  let transcriptPrimed = false;
  let historyTimer: ReturnType<typeof setInterval> | undefined;
  let transcriptTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingTranscript: { threadId: string; messages: readonly Message[]; agentName: string } | undefined;
  let snippetSequence = 0;
  const snippetTick = ref<WorkerChartSnippetTick | null>(null);
  const shownKeysByThread = new BoundedThreadKeyLedger();

  const rememberShown = (threadId: string, key: string): void => {
    shownKeysByThread.remember(threadId, key);
  };

  const resetThread = (threadId: string | undefined): void => {
    if (activeThreadId === threadId) return;
    if (historyTimer !== undefined) clearInterval(historyTimer);
    historyTimer = undefined;
    if (transcriptTimer !== undefined) clearTimeout(transcriptTimer);
    transcriptTimer = undefined;
    pendingTranscript = undefined;
    activeThreadId = threadId;
    subscribedAt = consumerAttached ? now() : Number.POSITIVE_INFINITY;
    eventBuffer.clear();
    snippetTick.value = null;
    previousRows.clear();
    snapshotCheckinDiffs.clear();
    historyCursors.clear();
    traceHistoryData.value = new Map();
    historyPrimed.clear();
    historyAvailable.clear();
    historyPending.clear();
    historyRefreshQueued.clear();
    transcriptProjection.clear();
    snapshotPrimed = false;
    transcriptPrimed = false;
  };

  const append = (item: StatusRollupItem): void => {
    if (!consumerAttached || !activeThreadId || item.threadId !== activeThreadId || item.observedAt <= subscribedAt) return;
    if (shownKeysByThread.has(item.threadId, item.key)) return;
    eventBuffer.append(item);
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
      const activityAt = mapper.timestamp(row.lastActivityAt) ?? mapper.timestamp(row.endedAt);
      const toolAt = mapper.timestamp(tool?.since) ?? activityAt;

      if (!snapshotPrimed || !previous) {
        if (activityAt !== null) append(stateEvent(agent, threadId, snapshot.version, activityAt));
        if (tool?.name?.trim() && toolAt !== null) append(mapper.tool(agent, threadId, tool.name.trim(), toolAt,
          `agent-tool-start:${threadId}:${row.key}:${tool.since}:${tool.name}:${snapshot.version}`, 'started', `agent:${threadId}:${row.key}:${tool.since}:${tool.name}`));
      } else {
        if (stateChanged && activityAt !== null) append(stateEvent(agent, threadId, snapshot.version, activityAt));
        if (toolChanged) {
          if (previousTool?.name?.trim() && activityAt !== null) {
            append(mapper.tool(previous, threadId, previousTool.name.trim(), activityAt,
              `agent-tool-finish:${threadId}:${row.key}:${previousTool.since}:${previousTool.name}:${snapshot.version}`,
              agent.state === 'failed' ? 'failed' : 'finished', `agent:${threadId}:${row.key}:${previousTool.since}:${previousTool.name}`));
          }
          if (tool?.name?.trim() && toolAt !== null) append(mapper.tool(agent, threadId, tool.name.trim(), toolAt,
            `agent-tool-start:${threadId}:${row.key}:${tool.since}:${tool.name}:${snapshot.version}`, 'started', `agent:${threadId}:${row.key}:${tool.since}:${tool.name}`));
        }
        if (!stateChanged && !toolChanged && !checkinChanged && row.lastActivityAt !== previous.row.lastActivityAt && activityAt !== null) {
          append(mapper.liveActivity(agent, threadId, activityAt,
            `agent-activity:${threadId}:${row.key}:${row.lastActivityAt}`));
        }
      }

      const historyKey = `${row.jobId}:${row.taskIndex}`;
      const useSnapshotCheckin = (!sources.traceHistory || !historyAvailable.has(historyKey)) &&
        row.lastCheckinAt && row.lastCheckinSummary?.trim();
      const item = useSnapshotCheckin ? mapper.snapshotCheckin(agent, threadId) : null;
      let diff = snapshotCheckinDiffs.get(row.key);
      if (!diff) { diff = new ThreadAgentEventProjectionDiff(); snapshotCheckinDiffs.set(row.key, diff); }
      diff.diff(item ? [item] : []).forEach(append);
      currentRows.set(row.key, agent);
    }

    for (const key of snapshotCheckinDiffs.keys()) {
      if (!currentRows.has(key)) snapshotCheckinDiffs.delete(key);
    }
    previousRows.clear();
    for (const [key, agent] of currentRows) previousRows.set(key, agent);
    snapshotPrimed = true;
    return view.agents as PresentedThreadAgent[];
  };

  const historyEvents = (agent: PresentedThreadAgent, data: AgentTraceHistoryData, threadId: string): void => {
    const key = `${agent.row.jobId}:${agent.row.taskIndex}`;
    const items = mapper.history(agent, data, threadId);
    let cursor = historyCursors.get(key);
    if (!cursor) { cursor = new ThreadAgentHistoryCursor(); historyCursors.set(key, cursor); }
    const firstRead = !historyPrimed.has(key);
    if (firstRead) {
      const latest = items[items.length - 1];
      cursor.prime(items);
      if (latest && !snapshotCheckinDiffs.get(agent.row.key)?.has(latest.key)) append(latest);
      historyPrimed.add(key);
      return;
    }
    cursor.select(items).forEach(append);
  };

  const loadHistory = (agent: PresentedThreadAgent, threadId: string): void => {
    const load = sources.traceHistory;
    if (!load) return;
    const key = `${agent.row.jobId}:${agent.row.taskIndex}`;
    if (historyPending.has(key)) { historyRefreshQueued.add(key); return; }
    historyPending.add(key);
    void load(threadId, agent.row.jobId, agent.row.taskIndex).then(data => {
      if (activeThreadId !== threadId) return;
      if (data === null) {
        if (traceHistoryData.value.has(key)) {
          const histories = new Map(traceHistoryData.value);
          histories.delete(key);
          traceHistoryData.value = histories;
        }
        const latest = eventPresenter.project(sources.snapshot.value, threadId, now(), sources.decisions?.value ?? [])
          .agents.find(candidate => `${candidate.row.jobId}:${candidate.row.taskIndex}` === key);
        const item = latest && mapper.snapshotCheckin(latest, threadId);
        if (item && latest) {
          let diff = snapshotCheckinDiffs.get(latest.row.key);
          if (!diff) { diff = new ThreadAgentEventProjectionDiff(); snapshotCheckinDiffs.set(latest.row.key, diff); }
          diff.diff([item]).forEach(append);
        }
        return;
      }
      historyAvailable.add(key);
      const current = traceHistoryData.value.get(key);
      const previousCheckin = current?.checkins.at(-1);
      const nextCheckin = data.checkins.at(-1);
      const previousMessage = current?.messages.at(-1);
      const nextMessage = data.messages.at(-1);
      const changed = !current || current.checkins.length !== data.checkins.length || current.messages.length !== data.messages.length ||
        previousCheckin?.createdAt !== nextCheckin?.createdAt || previousCheckin?.summary !== nextCheckin?.summary ||
        previousMessage?.createdAt !== nextMessage?.createdAt || previousMessage?.message !== nextMessage?.message;
      if (changed) {
        const histories = new Map(traceHistoryData.value);
        histories.set(key, data);
        traceHistoryData.value = histories;
      }
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

  const applyTranscript = (pending: { threadId: string; messages: readonly Message[]; agentName: string }): void => {
    if (activeThreadId !== pending.threadId || !pending.messages.length) return;
    const items = mapper.primaryTrace(pending.messages, pending.threadId, pending.agentName, now());
    if (!transcriptPrimed) {
      if (!items.length) return;
      const latest = items[items.length - 1];
      transcriptProjection.prime(items);
      if (latest) append(latest);
      transcriptPrimed = true;
      return;
    }
    transcriptProjection.diff(items).forEach(append);
  };

  const flushTranscript = (): void => {
    transcriptTimer = undefined;
    const pending = pendingTranscript;
    pendingTranscript = undefined;
    if (pending) applyTranscript(pending);
  };

  watch(() => {
    const threadId = sources.threadId.value;
    const agentName = sources.primaryAgentName?.value ?? 'Sulla';
    const messages = (sources.transcript?.value ?? []).slice(-40);
    const messageStates = messages.map(message => [
      String(message.id), message.kind,
      'status' in message ? String(message.status) : 'decision' in message ? String(message.decision) : '',
    ]);
    const last = messages[messages.length - 1];
    const lastTextLength = last && 'text' in last && typeof last.text === 'string' ? last.text.length : 0;
    const thoughtText = last?.kind === 'thinking' ? last.thoughts.join('\u0000') : '';
    const thoughtCompleted = last?.kind === 'thinking' ? last.completed : false;
    return JSON.stringify([threadId, agentName, messageStates, lastTextLength, thoughtText, thoughtCompleted]);
  }, () => {
    const threadId = sources.threadId.value;
    resetThread(threadId);
    if (!threadId) return;
    const pending = {
      threadId,
      messages: (sources.transcript?.value ?? []).slice(-40),
      agentName: sources.primaryAgentName?.value ?? 'Sulla',
    };
    if (!transcriptPrimed) {
      applyTranscript(pending);
      return;
    }
    pendingTranscript = pending;
    if (transcriptTimer === undefined) transcriptTimer = setTimeout(flushTranscript, 100);
  }, { immediate: true, flush: 'pre' });

  if (getCurrentScope()) onScopeDispose(() => {
    if (historyTimer !== undefined) clearInterval(historyTimer);
    historyTimer = undefined;
    if (transcriptTimer !== undefined) clearTimeout(transcriptTimer);
    transcriptTimer = undefined;
    pendingTranscript = undefined;
  });

  return {
    projection,
    checkIns: computed(() => eventItems.value),
    traceHistories,
    attachConsumer: () => {
      if (consumerAttached) return;
      eventBuffer.clear();
      consumerAttached = true;
      subscribedAt = now();
    },
    detachConsumer: () => {
      consumerAttached = false;
      eventBuffer.clear();
    },
    consumeCheckIns: () => eventBuffer.consume(),
    rootFallback: computed(() => mapper.rootFallback(projection.value, sources.threadId.value, now())),
    chartRoot: computed(() => mapper.chartRoot(projection.value, sources.threadId.value)),
    snippetTick,
    statusItemShown: (event: StatusRollupShownEvent) => {
      if (!event.agentId || event.threadId !== sources.threadId.value) return;
      rememberShown(event.threadId, event.key);
      snippetTick.value = { agentId: event.agentId, sequence: ++snippetSequence };
    },
  };
}
