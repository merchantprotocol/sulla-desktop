// SPDX-License-Identifier: GPL-2.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';
vi.mock('@pkg/utils/ipcRenderer', () => ({ ipcRenderer: { invoke: vi.fn(async() => ({ success: false })) } }));
import { ThreadAgentActivityPresenter } from '@pkg/services/agentState/ThreadAgentActivityPresenter';
import { ThreadAgentEventBuffer, useThreadAgentActivity } from '@pkg/pages/chat/composables/useThreadAgentActivity';
import type { AgentTraceHistoryData } from '@pkg/agent/app/Services/AgentTraceHistory';
import type { AgentStateRow, AgentStateSnapshot } from '@pkg/shared/agentState/AgentStateSnapshot';
import type { WorkerChartAgent } from '@pkg/pages/chat/components/workerChart/workerChartModel';
import type { Message } from '@pkg/pages/chat/models/Message';

class RowFactory {
  create(key: string, rootThreadId: string, threadId: string | null, parentKey: string | null = null): AgentStateRow {
    const [jobId, task = '0'] = key.split(':');
    const [parentJobId, parentTask = ''] = parentKey?.split(':') ?? [];
    return {
      key, jobId, taskIndex: Number(task), parentJobId: parentJobId || null,
      parentTaskIndex: parentJobId ? Number(parentTask) : null, rootThreadId, threadId,
      depth: parentKey ? 1 : 0, agentId: `agent-${jobId}`, label: key,
      visibility: 'hidden', state: 'working', stateReason: null, killedByHuman: false,
      waitingOnChildren: 0, startedAt: '2026-11-23T17:00:00.000Z', endedAt: null,
      lastActivityAt: '2026-11-23T17:01:30.000Z', lastCheckinAt: null, lastCheckinSummary: null,
      canMessage: true, canStop: true, canOpen: true,
    };
  }
}

function iso(at: number): string { return new Date(at).toISOString(); }

function flatten(root: WorkerChartAgent | null): string[] {
  if (!root) return [];
  return [root.id, ...(root.children ?? []).flatMap(child => flatten(child))];
}

const useActivityWithConsumer = (sources: Parameters<typeof useThreadAgentActivity>[0]) => {
  const activity = useThreadAgentActivity(sources);
  activity.attachConsumer();
  return activity;
};

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await nextTick();
}

describe('useThreadAgentActivity', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  // risk: burst replay — a source burst replaces the transient handoff value instead of building a backlog.
  it('keeps only the newest event in the mounted handoff buffer', () => {
    const buffer = new ThreadAgentEventBuffer();
    for (let index = 0; index < 60; index += 1) {
      buffer.append({
        key: `event-${index}`, threadId: 'thread-a', agentId: 'agent-a', agentName: 'Agent A',
        text: `Action ${index}`, observedAt: index + 1,
      });
    }

    expect(buffer.items.value).toHaveLength(1);
    expect(buffer.items.value[0]?.key).toBe('event-59');
  });

  // risk: stale status replay — snapshot, transcript and authorized history present before mount stay silent after attach.
  it('does not deliver the current snapshot, transcript, or first history read after subscribing', async() => {
    const now = Date.parse('2026-11-26T12:00:00.000Z');
    const row = {
      ...new RowFactory().create('worker-job:0', 'thread-a', null),
      lastActivityAt: iso(now - 30_000), lastCheckinAt: iso(now - 60_000), lastCheckinSummary: 'Cached check-in',
    };
    const history: AgentTraceHistoryData = {
      checkins: [{ step: '', summary: 'Cached history', filesTouched: [], blockers: [], createdAt: now - 20_000 }],
      messages: [],
    };
    const transcript = ref<readonly Message[]>([{
      id: 'old-tool' as Message['id'], kind: 'tool', createdAt: now - 10_000, tool: 'Read', desc: 'Cached transcript step', status: 'running',
    } as Message]);
    const activity = useThreadAgentActivity({
      snapshot: ref<AgentStateSnapshot>({ version: 1, generatedAt: iso(now), rows: [row] }),
      threadId: ref<string | undefined>('thread-a'), transcript,
      traceHistory: async() => history,
      now: () => now,
    });
    await settle();

    activity.attachConsumer();
    await settle();
    expect(activity.checkIns.value).toEqual([]);
  });

  // risk: delayed historical hydration — a first IPC response cannot replay the last old check-in, but a later live row can.
  it('filters old first-read history and accepts a history event created after subscription', async() => {
    const subscribedAt = 1_000_000;
    let history: AgentTraceHistoryData = {
      checkins: [{ step: '', summary: 'Old check-in', filesTouched: [], blockers: [], createdAt: subscribedAt - 100 }],
      messages: [],
    };
    let resolveFirst!: (data: AgentTraceHistoryData | null) => void;
    let first = true;
    const row = new RowFactory().create('worker-job:0', 'thread-a', null);
    const snapshot = ref<AgentStateSnapshot>({ version: 1, generatedAt: iso(subscribedAt), rows: [row] });
    const activity = useThreadAgentActivity({
      snapshot, threadId: ref<string | undefined>('thread-a'), now: () => subscribedAt,
      traceHistory: () => first
        ? (first = false, new Promise(resolve => { resolveFirst = resolve; }))
        : Promise.resolve(history),
    });
    activity.attachConsumer();
    resolveFirst(history);
    await settle();
    expect(activity.traceHistories.value.get('worker-job:0')).toEqual(history);
    expect(activity.checkIns.value).toEqual([]);

    history = {
      checkins: [...history.checkins, {
        step: 'verify', summary: 'Live check-in', filesTouched: [], blockers: [], createdAt: subscribedAt + 1,
      }],
      messages: [],
    };
    snapshot.value = { ...snapshot.value, version: 2, generatedAt: iso(subscribedAt + 2) };
    await settle();

    expect(activity.checkIns.value.map(item => item.text)).toEqual(['verify: Live check-in']);
    expect(activity.checkIns.value[0]?.observedAt).toBe(subscribedAt + 1);
  });

  // risk: source freshness — a check-in is surfaced immediately when its snapshot timestamp advances beyond the subscription.
  it('accepts a newly observed snapshot check-in without including the existing row history', async() => {
    let clock = 2_000_000;
    const oldRow = {
      ...new RowFactory().create('worker-job:0', 'thread-a', null),
      lastActivityAt: iso(clock - 10), lastCheckinAt: iso(clock - 20), lastCheckinSummary: 'Old status',
    };
    const snapshot = ref<AgentStateSnapshot>({ version: 1, generatedAt: iso(clock), rows: [oldRow] });
    const activity = useThreadAgentActivity({ snapshot, threadId: ref<string | undefined>('thread-a'), now: () => clock });
    activity.attachConsumer();
    expect(activity.checkIns.value).toEqual([]);

    clock += 10;
    const liveAt = clock + 1;
    snapshot.value = {
      version: 2, generatedAt: iso(liveAt),
      rows: [{ ...oldRow, lastActivityAt: iso(liveAt), lastCheckinAt: iso(liveAt), lastCheckinSummary: 'Live check-in' }],
    };
    await nextTick();

    expect(activity.checkIns.value.map(item => item.text)).toContain('Live check-in');
    expect(activity.checkIns.value.some(item => item.text === 'Old status')).toBe(false);
    expect(activity.checkIns.value.every(item => item.observedAt > clock - 10)).toBe(true);
  });

  // risk: transcript replay — a historical tool row shown after mount cannot appear, while a new tool row does.
  it('primes old transcript rows and emits only later live transcript deltas', async() => {
    vi.useFakeTimers();
    const now = 3_000_000;
    const oldTool = { id: 'old' as Message['id'], kind: 'tool', createdAt: now - 1, tool: 'Read', desc: 'Old tool', status: 'running' } as Message;
    const transcript = ref<readonly Message[]>([oldTool]);
    const activity = useThreadAgentActivity({
      snapshot: ref<AgentStateSnapshot>({ version: 1, generatedAt: iso(now), rows: [] }),
      threadId: ref<string | undefined>('thread-a'), transcript, now: () => now,
    });
    await nextTick();
    activity.attachConsumer();
    await settle();
    expect(activity.checkIns.value).toEqual([]);

    const liveTool = { id: 'live' as Message['id'], kind: 'tool', createdAt: now + 1, tool: 'Edit', desc: 'Live tool', status: 'running' } as Message;
    transcript.value = [oldTool, liveTool];
    await nextTick();
    await vi.advanceTimersByTimeAsync(100);
    await nextTick();
    expect(activity.checkIns.value.map(item => item.text)).toEqual(['Live tool']);
  });

  // risk: detached replay — events arriving while no status line is mounted are discarded, not retained for a later mount.
  it('discards events while detached and does not deliver them after reattachment', async() => {
    vi.useFakeTimers();
    let clock = 4_000_000;
    const transcript = ref<readonly Message[]>([]);
    const activity = useActivityWithConsumer({
      snapshot: ref<AgentStateSnapshot>({ version: 1, generatedAt: iso(clock), rows: [] }),
      threadId: ref<string | undefined>('thread-a'), transcript, now: () => clock,
    });
    activity.detachConsumer();
    clock += 100;
    transcript.value = [{ id: 'detached' as Message['id'], kind: 'tool', createdAt: clock, tool: 'Read', desc: 'Detached event', status: 'running' } as Message];
    await nextTick();
    await vi.advanceTimersByTimeAsync(100);
    await nextTick();
    expect(activity.checkIns.value).toEqual([]);

    activity.attachConsumer();
    await settle();
    expect(activity.checkIns.value).toEqual([]);
  });

  // risk: thread isolation and replay — switching to another conversation or back never seeds its last historical action.
  it('clears live events on thread changes and shows only a source timestamp newer than each thread subscription', async() => {
    let clock = 5_000_000;
    const rows = new RowFactory();
    const threadId = ref<string | undefined>('thread-a');
    const snapshot = ref<AgentStateSnapshot>({ version: 0, generatedAt: iso(clock), rows: [] });
    const activity = useActivityWithConsumer({ snapshot, threadId, now: () => clock });
    const liveA = { ...rows.create('job-a:0', 'thread-a', null), lastActivityAt: iso(clock + 1) };
    snapshot.value = { version: 1, generatedAt: iso(clock + 1), rows: [liveA] };
    await nextTick();
    expect(activity.checkIns.value[0]?.threadId).toBe('thread-a');
    activity.consumeCheckIns();
    activity.statusItemShown({ key: activity.projection.value.agents[0]?.row.key ?? '', agentId: 'job-a:0', threadId: 'thread-a' });

    clock += 1_000;
    const oldB = { ...rows.create('job-b:0', 'thread-b', null), lastActivityAt: iso(clock - 1) };
    threadId.value = 'thread-b';
    snapshot.value = { version: 2, generatedAt: iso(clock), rows: [liveA, oldB] };
    await nextTick();
    expect(activity.checkIns.value).toEqual([]);

    threadId.value = 'thread-a';
    snapshot.value = { version: 3, generatedAt: iso(clock + 1), rows: [liveA, oldB] };
    await nextTick();
    expect(activity.checkIns.value).toEqual([]);
  });

  // risk: stale status replay — a shown status remains remembered after the 512th check-in in that thread.
  it('keeps old shown keys suppressed for long-running threads', async() => {
    let clock = Date.parse('2026-11-26T12:00:00.000Z');
    const rows = new RowFactory();
    const oldAt = iso(clock - 100);
    const initialRow = {
      ...rows.create('job-a:0', 'thread-a', null),
      lastCheckinAt: oldAt,
      lastCheckinSummary: 'Old check-in',
      lastActivityAt: oldAt,
    };
    const snapshot = ref<AgentStateSnapshot>({ version: 1, generatedAt: iso(clock), rows: [initialRow] });
    const activity = useActivityWithConsumer({ snapshot, threadId: ref<string | undefined>('thread-a'), now: () => clock });
    clock += 1_000;
    const liveAt = iso(clock + 1);
    const targetKey = `agent-checkin:thread-a:${initialRow.key}:${liveAt}:Old check-in`;
    activity.statusItemShown({ key: targetKey, agentId: 'job-a:0', threadId: 'thread-a' });
    for (let index = 0; index < 520; index += 1) {
      activity.statusItemShown({ key: `shown-${index}`, agentId: 'job-a:0', threadId: 'thread-a' });
    }

    snapshot.value = {
      version: 2, generatedAt: liveAt,
      rows: [{ ...initialRow, lastCheckinAt: liveAt, lastCheckinSummary: 'Old check-in', lastActivityAt: liveAt }],
    };
    await nextTick();

    expect(activity.checkIns.value).toEqual([]);
  });

  // risk: scope correctness — chart projections and root fallback remain restricted to the active thread tree.
  it('keeps chart and root fallback inside the active thread', async() => {
    const rows = new RowFactory();
    const rootA = rows.create('job-a:0', 'thread-a', 'thread-a');
    const childA = rows.create('job-a-child:0', 'thread-a', null, rootA.key);
    const rootB = rows.create('job-b:0', 'thread-b', null);
    const activity = useActivityWithConsumer({
      snapshot: ref<AgentStateSnapshot>({ version: 1, generatedAt: '2026-11-23T17:02:00.000Z', rows: [rootA, childA, rootB] }),
      threadId: ref<string | undefined>('thread-a'),
      now: () => Date.parse('2026-11-23T17:02:00.000Z'),
    });

    expect(flatten(activity.chartRoot.value)).toEqual(['chat:thread-a', 'job-a:0', 'job-a-child:0']);
    expect(activity.checkIns.value).toEqual([]);
    expect(activity.rootFallback.value?.key).toBe('job-a:0:fallback');
  });

  // risk: chart role accuracy — task capability, not a model name, determines manager/reviewer roles.
  it('uses child and launch metadata for stable chart roles', async() => {
    const rows = new RowFactory();
    const worker = { ...rows.create('worker:0', 'thread-a', null), label: 'Worker task' };
    const childManager = { ...rows.create('manager:0', 'thread-a', null), canLaunchAgents: false };
    const managerChild = rows.create('manager-child:0', 'thread-a', null, childManager.key);
    const capableManager = { ...rows.create('capable:0', 'thread-a', null), canLaunchAgents: true };
    const reviewer = { ...rows.create('review:0', 'thread-a', null), label: 'Review changes' };
    const activity = useActivityWithConsumer({
      snapshot: ref<AgentStateSnapshot>({ version: 1, generatedAt: '2026-11-23T17:02:00.000Z', rows: [worker, childManager, managerChild, capableManager, reviewer] }),
      threadId: ref('thread-a'),
    });
    const agents = new Map(activity.chartRoot.value?.children?.map(agent => [agent.id, agent]));
    expect(agents.get(worker.key)?.role).toBe('wrk');
    expect(agents.get(childManager.key)?.role).toBe('mgr');
    expect(agents.get(capableManager.key)?.role).toBe('mgr');
    expect(agents.get(reviewer.key)?.role).toBe('rev');
  });

  // risk: chart data accuracy — an active time window retains all current buckets and rejects samples outside it.
  it('retains visible activity samples and prunes only older chart rows', () => {
    const presenter = new ThreadAgentActivityPresenter();
    const now = Date.parse('2026-11-23T17:02:00.000Z');
    const row = { ...new RowFactory().create('activity-job:0', 'thread-a', null), lastActivityAt: iso(now - 153_999) };
    const current = presenter.project({ version: 1, generatedAt: iso(now), rows: [row] }, 'thread-a', now);
    expect(current.agents[0]?.activity).toContain(row.lastActivityAt);
    const next = presenter.project({ version: 2, generatedAt: iso(now), rows: [{ ...row, lastActivityAt: iso(now - 154_001) }] }, 'thread-a', now);
    expect(next.agents[0]?.activity).toContain(row.lastActivityAt);
    expect(next.agents[0]?.activity).not.toContain(iso(now - 154_001));
  });

  // risk: live feedback — each visible status event ticks the matching chart agent exactly once per display.
  it('publishes thread-scoped status snippets as monotonic chart ticks', async() => {
    const threadId = ref<string | undefined>('thread-a');
    const activity = useThreadAgentActivity({
      snapshot: ref<AgentStateSnapshot>({ version: 0, generatedAt: iso(Date.now()), rows: [] }), threadId,
    });
    activity.statusItemShown({ key: 'one', agentId: 'job-one:0', threadId: 'thread-a' });
    expect(activity.snippetTick.value).toEqual({ agentId: 'job-one:0', sequence: 1 });
    activity.statusItemShown({ key: 'two', agentId: 'job-two:0', threadId: 'thread-a' });
    expect(activity.snippetTick.value).toEqual({ agentId: 'job-two:0', sequence: 2 });
    activity.statusItemShown({ key: 'stale', agentId: 'job-old:0', threadId: 'thread-old' });
    expect(activity.snippetTick.value).toEqual({ agentId: 'job-two:0', sequence: 2 });
    threadId.value = 'thread-b';
    await nextTick();
    expect(activity.snippetTick.value).toBeNull();
  });
});
