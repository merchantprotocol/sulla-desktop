// SPDX-License-Identifier: GPL-2.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';

import { DetailedTraceProjection } from '@pkg/pages/chat/components/transcript/DetailedTraceProjection';

import { StatusRollupQueue, type StatusRollupItem } from '@pkg/pages/chat/components/composer/StatusRollupQueue';
import { ThreadAgentEventBuffer, ThreadAgentEventProjectionDiff, ThreadAgentHistoryCursor, useThreadAgentActivity } from '@pkg/pages/chat/composables/useThreadAgentActivity';
import type { AgentStateRow, AgentStateSnapshot } from '@pkg/shared/agentState/AgentStateSnapshot';
import type { WorkerChartAgent } from '@pkg/pages/chat/components/workerChart/workerChartModel';
import type { Message } from '@pkg/pages/chat/models/Message';

class RowFactory {
  create(key: string, rootThreadId: string, threadId: string | null, parentKey: string | null = null): AgentStateRow {
    const [jobId, task = '0'] = key.split(':');
    const [parentJobId, parentTask = ''] = parentKey?.split(':') ?? [];
    return {
      key,
      jobId,
      taskIndex: Number(task),
      parentJobId: parentJobId || null,
      parentTaskIndex: parentJobId ? Number(parentTask) : null,
      rootThreadId,
      threadId,
      depth: parentKey ? 1 : 0,
      agentId: `agent-${jobId}`,
      label: key,
      visibility: 'hidden',
      state: 'working',
      stateReason: null,
      killedByHuman: false,
      waitingOnChildren: 0,
      startedAt: '2026-11-23T17:00:00.000Z',
      endedAt: null,
      lastActivityAt: '2026-11-23T17:01:30.000Z',
      lastCheckinAt: '2026-11-23T17:01:00.000Z',
      lastCheckinSummary: `check-in ${key}`,
      canMessage: true,
      canStop: true,
      canOpen: true,
    };
  }
}

function flatten(root: WorkerChartAgent | null): string[] {
  if (!root) return [];
  return [root.id, ...(root.children ?? []).flatMap(child => flatten(child))];
}

describe('useThreadAgentActivity', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it('keeps chart, status items, and root fallback inside the active thread', async() => {
    // risk: cross-thread agent/check-in disclosure
    const rows = new RowFactory();
    const rootA = rows.create('job-a:0', 'thread-a', 'thread-a');
    const childA = rows.create('job-a-child:0', 'thread-a', null, rootA.key);
    const rootB = rows.create('job-b:0', 'thread-b', null);
    const snapshot = ref<AgentStateSnapshot>({
      version: 1,
      generatedAt: '2026-11-23T17:02:00.000Z',
      rows: [rootA, childA, rootB],
    });
    const threadId = ref<string | undefined>('thread-a');
    // Each chat's transcript belongs to its own controller; switching threads swaps the transcript too.
    const transcripts: Record<string, Message[]> = {
      'thread-a': [{ id: 'tool-a' as Message['id'], kind: 'tool', createdAt: Date.parse('2026-11-23T17:01:45.000Z'), tool: 'Read', desc: 'Reading ChatPage.vue', status: 'running', input: '{"path":"secret-a"}' } as Message],
      'thread-b': [{ id: 'tool-b' as Message['id'], kind: 'tool', createdAt: Date.parse('2026-11-23T17:01:50.000Z'), tool: 'Edit', desc: 'Editing thread-b file', status: 'running' } as Message],
    };
    const transcript = ref<readonly Message[]>(transcripts['thread-a']);
    const activity = useThreadAgentActivity({ snapshot, threadId, transcript, primaryAgentName: ref('Sulla'), now: () => Date.parse('2026-11-23T17:02:00.000Z') });
    const texts = () => activity.checkIns.value.map(item => item.text);

    expect(activity.projection.value.agents.map(agent => agent.row.key)).toEqual(['job-a:0', 'job-a-child:0']);
    expect(flatten(activity.chartRoot.value)).toEqual(['chat:thread-a', 'job-a:0', 'job-a-child:0']);
    expect(activity.checkIns.value.every(item => item.threadId === 'thread-a')).toBe(true);
    expect(texts()).toEqual(expect.arrayContaining(['check-in job-a:0', 'check-in job-a-child:0']));
    // risk: privacy — the primary agent's tool step shows with its readable description, never raw input.
    const primary = activity.checkIns.value.filter(item => item.role === 'root');
    expect(primary.map(item => [item.agentName, item.kind, item.text])).toEqual([['Sulla', 'read', 'Reading ChatPage.vue']]);
    expect(texts().some(text => text.includes('secret-a'))).toBe(false);
    expect(texts()).not.toContain('Editing thread-b file');
    expect(activity.rootFallback.value?.key).toBe('job-a:0:fallback');
    expect(activity.rootFallback.value?.text).toBe('check-in job-a:0');

    threadId.value = 'thread-b';
    transcript.value = transcripts['thread-b'];
    await nextTick();
    expect(activity.projection.value.agents.map(agent => agent.row.key)).toEqual(['job-b:0']);
    expect(flatten(activity.chartRoot.value)).toEqual(['chat:thread-b', 'job-b:0']);
    expect(activity.checkIns.value.every(item => item.threadId === 'thread-b')).toBe(true);
    expect(texts()).toContain('check-in job-b:0');
    expect(texts()).not.toContain('Reading ChatPage.vue');
    expect(texts()).not.toContain('check-in job-a:0');
    expect(activity.rootFallback.value).toBeNull();

    threadId.value = undefined;
    expect(activity.checkIns.value).toEqual([]);
    expect(activity.rootFallback.value).toBeNull();
  });

  it('keeps a grandchild snapshot check-in when authorized history returns null', async() => {
    // risk: availability — grandchildren with another agent as their parent still surface their latest check-in.
    const rows = new RowFactory();
    const root = rows.create('root-job:0', 'thread-a', 'thread-a');
    const child = rows.create('child-job:0', 'thread-a', null, root.key);
    const grandchild = rows.create('grandchild-job:0', 'thread-a', null, child.key);
    const snapshot = ref<AgentStateSnapshot>({
      version: 1,
      generatedAt: '2026-11-23T17:02:00.000Z',
      rows: [root, child, grandchild],
    });
    const threadId = ref<string | undefined>('thread-a');
    const activity = useThreadAgentActivity({
      snapshot,
      threadId,
      traceHistory: async(_parentThreadId, jobId) => jobId === 'grandchild-job' ? null : { checkins: [], messages: [] },
      now: () => Date.parse('2026-11-23T17:02:00.000Z'),
    });

    await Promise.resolve();
    await nextTick();
    expect(activity.checkIns.value).toEqual(expect.arrayContaining([
      expect.objectContaining({ agentId: 'grandchild-job:0', text: 'check-in grandchild-job:0', threadId: 'thread-a' }),
    ]));
  });

  it('clears the previous thread queue and history before observing the next thread', () => {
    // risk: stale cross-thread status remains visible after switching chats
    const rows = new RowFactory();
    const rootA = rows.create('job-a:0', 'thread-a', 'thread-a');
    const snapshot = ref<AgentStateSnapshot>({
      version: 1,
      generatedAt: '2026-11-23T17:02:00.000Z',
      rows: [
        rootA,
        rows.create('job-a-child:0', 'thread-a', null, rootA.key),
        rows.create('job-b:0', 'thread-b', null),
      ],
    });
    const threadId = ref<string | undefined>('thread-a');
    const activity = useThreadAgentActivity({ snapshot, threadId, now: () => Date.parse('2026-11-23T17:02:00.000Z') });
    const queue = new StatusRollupQueue();
    const now = Date.parse('2026-11-23T17:01:01.000Z');

    queue.observe(activity.checkIns.value, 'thread-a', now);
    queue.pump(now);
    expect(queue.history.length).toBeGreaterThan(0);
    expect(queue.history.every(item => item.threadId === 'thread-a')).toBe(true);
    expect(queue.pending.length).toBeGreaterThan(0);

    threadId.value = 'thread-b';
    queue.reset('thread-b');
    expect(queue.current).toBeNull();
    expect(queue.pending).toEqual([]);
    expect(queue.history).toEqual([]);

    queue.observe(activity.checkIns.value, 'thread-b', now + 1);
    expect(queue.history.length).toBeGreaterThan(0);
    expect(queue.history.every(item => item.threadId === 'thread-b')).toBe(true);
    expect(queue.pending.every(item => item.threadId === 'thread-b')).toBe(true);
  });

  // risk: memory lifecycle — after leaving the visible trail, a displayed event is held by neither buffer nor queue.
  it('releases a shown event after it falls out of the visible trail', () => {
    const buffer = new ThreadAgentEventBuffer();
    const queue = new StatusRollupQueue();
    const items = Array.from({ length: StatusRollupQueue.historyLimit + 2 }, (_, index) => ({
      key: `event-${index}`, threadId: 'thread-a', agentId: 'agent-a', agentName: 'Agent A',
      text: `Event ${index}`, observedAt: index,
    }));
    items.forEach(item => buffer.append(item));

    queue.observe(buffer.items.value, 'thread-a', 0);
    buffer.consume();
    expect(buffer.items.value).toEqual([]);

    const shown: string[] = [];
    for (let now = 0; now <= 3_000; now += 250) shown.push(...queue.pumpDue(now).map(item => item.key));

    expect(shown).toEqual(items.map(item => item.key));
    expect(queue.current?.key).toBe(`event-${items.length - 1}`);
    expect(queue.pending).toEqual([]);
    expect(queue.history.map(item => item.key)).not.toContain('event-0');
  });

  // risk: memory lifecycle — a cursor retains only the keys in its current projection, never keys from old projections.
  it('keeps thousands of events lossless while retaining only current projection keys', () => {
    const projection = new ThreadAgentEventProjectionDiff();
    const historyCursor = new ThreadAgentHistoryCursor();
    const buffer = new ThreadAgentEventBuffer();
    const queue = new StatusRollupQueue();
    const source = Array.from({ length: 3_000 }, (_, index) => ({
      key: `event-${index}`, threadId: 'thread-a', agentId: 'agent-a', agentName: 'Agent A',
      text: `Event ${index}`, observedAt: index,
    }));

    const selected = source.flatMap((_, index) => {
      const start = Math.max(0, index - 39);
      return projection.diff(source.slice(start, index + 1));
    });
    expect(selected).toHaveLength(3_000);
    expect(projection.retainedKeyCount).toBe(40);
    expect(historyCursor.select(source)).toHaveLength(3_000);
    expect(historyCursor.select(source)).toEqual([]);
    expect(historyCursor.retainedKeyCount).toBe(1);
    selected.forEach(item => buffer.append(item));
    queue.observe(buffer.items.value, 'thread-a', 0);
    buffer.consume();

    expect(buffer.items.value).toEqual([]);
    expect(queue.pending).toHaveLength(3_000);

    const shown: string[] = [];
    for (let now = 0; now <= 3_000; now += 1) shown.push(...queue.pumpDue(now).map(item => item.key));

    expect(shown).toEqual(source.map(item => item.key));
    expect(queue.pending).toEqual([]);
    expect(queue.current?.key).toBe('event-2999');
    expect(queue.history).toHaveLength(StatusRollupQueue.historyLimit);
    expect(queue.history.some(item => item.key === 'event-0')).toBe(false);
    expect(projection.retainedKeyCount).toBe(40);
    expect(historyCursor.retainedKeyCount).toBe(1);
  });

  // risk: availability — transcript and snapshot projections repeat old rows, but a source cursor must not enqueue them again.
  it('does not requeue re-projected transcript or snapshot check-ins', async() => {
    vi.useFakeTimers();
    const rows = new RowFactory();
    const originalRow = {
      ...rows.create('job-a:0', 'thread-a', 'thread-a'),
      lastCheckinAt: '2026-11-23T17:01:00.000Z',
      lastCheckinSummary: 'First check-in',
    };
    const snapshot = ref<AgentStateSnapshot>({ version: 1, generatedAt: '2026-11-23T17:02:00.000Z', rows: [originalRow] });
    const threadId = ref<string | undefined>('thread-a');
    const agentName = ref('Sulla');
    const transcript = ref<readonly Message[]>([
      { id: 'tool-a' as Message['id'], kind: 'tool', createdAt: Date.parse('2026-11-23T17:01:45.000Z'), tool: 'Read', desc: 'Read file', status: 'running' } as Message,
    ]);
    const activity = useThreadAgentActivity({ snapshot, threadId, transcript, primaryAgentName: agentName, now: () => Date.parse('2026-11-23T17:02:00.000Z') });
    const queue = new StatusRollupQueue();

    expect(activity.checkIns.value).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: expect.stringContaining('agent-checkin:'), text: 'First check-in' }),
      expect.objectContaining({ text: 'Read file' }),
    ]));
    queue.observe(activity.checkIns.value, 'thread-a', 0);
    activity.consumeCheckIns();

    const secondRow = { ...originalRow, lastCheckinAt: '2026-11-23T17:01:30.000Z', lastCheckinSummary: 'Second check-in' };
    snapshot.value = {
      version: 2,
      generatedAt: '2026-11-23T17:02:01.000Z',
      rows: [secondRow],
    };
    await nextTick();
    expect(activity.checkIns.value).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: 'Second check-in' }),
    ]));
    queue.observe(activity.checkIns.value, 'thread-a', 1);
    activity.consumeCheckIns();
    const pendingCount = queue.pending.length;

    // Re-project the same transcript and snapshot under new wrapper metadata; event keys stay unchanged.
    agentName.value = 'Assistant';
    snapshot.value = { version: 3, generatedAt: '2026-11-23T17:02:02.000Z', rows: [secondRow] };
    await nextTick();
    await vi.advanceTimersByTimeAsync(100);
    await nextTick();

    expect(activity.checkIns.value).toEqual([]);
    queue.observe(activity.checkIns.value, 'thread-a', 2);
    expect(queue.pending).toHaveLength(pendingCount);
  });

  // risk: event throughput — rapid streamed revisions must share one expensive trace projection per coalesce window.
  it('coalesces rapid transcript changes into one trace projection', async() => {
    vi.useFakeTimers();
    const createdAt = Date.parse('2026-11-23T17:01:00.000Z');
    const original: Message = {
      id: 'thought-coalesced' as Message['id'],
      kind: 'thinking',
      createdAt,
      thoughts: ['Initial thought'],
      startedAt: createdAt,
      completed: false,
    };
    const transcript = ref<readonly Message[]>([original]);
    const project = vi.spyOn(DetailedTraceProjection.prototype, 'project');
    const activity = useThreadAgentActivity({
      snapshot: ref<AgentStateSnapshot>({ version: 1, generatedAt: new Date(createdAt).toISOString(), rows: [] }),
      threadId: ref<string | undefined>('thread-a'),
      transcript,
      now: () => createdAt,
    });
    expect(project).toHaveBeenCalledTimes(1);
    project.mockClear();

    for (let index = 0; index < 8; index++) {
      transcript.value = [{ ...original, thoughts: [`Streaming thought revision ${index}`] } as Message];
      await nextTick();
    }
    expect(project).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(100);
    await nextTick();
    expect(project).toHaveBeenCalledTimes(1);
    expect(activity.checkIns.value.find(item => item.kind === 'thought')?.text).toBe('Streaming thought revision 7');
  });

  // risk: data accuracy — a streaming thought must update one stable status event rather than freeze or flood duplicates.
  it('updates the existing thought event when its streaming text changes', async() => {
    vi.useFakeTimers();
    const createdAt = Date.parse('2026-11-23T17:01:00.000Z');
    const original: Message = {
      id: 'thought-1' as Message['id'],
      kind: 'thinking',
      createdAt,
      thoughts: ['Checking the first possibility'],
      startedAt: createdAt,
      completed: false,
    };
    const transcript = ref<readonly Message[]>([original]);
    const activity = useThreadAgentActivity({
      snapshot: ref<AgentStateSnapshot>({ version: 1, generatedAt: new Date(createdAt).toISOString(), rows: [] }),
      threadId: ref<string | undefined>('thread-a'),
      transcript,
      now: () => createdAt,
    });

    const originalThought = activity.checkIns.value.find(item => item.kind === 'thought');
    expect(originalThought?.text).toBe('Checking the first possibility');

    transcript.value = [{
      ...original,
      thoughts: ['Checking the second possibility'],
    } as Message];
    await nextTick();
    await vi.advanceTimersByTimeAsync(100);
    await nextTick();

    const thoughts = activity.checkIns.value.filter(item => item.kind === 'thought');
    expect(thoughts).toHaveLength(1);
    expect(thoughts[0]?.key).toBe(originalThought?.key);
    expect(thoughts[0]?.text).toBe('Checking the second possibility');
  });

  // risk: streaming updates — an older thought's stable key still revises its queued/visible text without replaying it.
  it('updates an active thought while diffing a source projection that also contains a later event', () => {
    const projection = new ThreadAgentEventProjectionDiff();
    const buffer = new ThreadAgentEventBuffer();
    const queue = new StatusRollupQueue();
    const thought = {
      key: 'thought', threadId: 'thread-a', agentId: 'agent-a', agentName: 'Agent A',
      kind: 'thought' as const, text: 'First thought text', observedAt: 0,
    };
    const later = { key: 'later', threadId: 'thread-a', agentId: 'agent-a', agentName: 'Agent A', text: 'Later event', observedAt: 10 };
    const accept = (items: readonly StatusRollupItem[]): void => {
      projection.diff(items).forEach(value => buffer.append(value));
      queue.observe(buffer.items.value, 'thread-a', items.at(-1)?.observedAt ?? 0);
      buffer.consume();
    };

    accept([thought]);
    queue.pump(0);
    accept([thought, later]);
    accept([{ ...thought, text: 'Updated thought text' }, later]);

    expect(queue.current?.text).toBe('Updated thought text');
    expect(queue.pending.map(item => item.key)).toEqual(['later']);
    expect(buffer.items.value).toEqual([]);
  });

  // risk: status-line accuracy — a late tool result must balance its start instead of disappearing behind a newer tool timestamp.
  it('emits an older tool result exactly once after a newer tool starts without changing the newer tool', async() => {
    vi.useFakeTimers();
    const firstAt = Date.parse('2026-11-23T17:01:00.000Z');
    const secondAt = Date.parse('2026-11-23T17:02:00.000Z');
    const toolA: Message = { id: 'tool-a' as Message['id'], kind: 'tool', createdAt: firstAt, tool: 'Read', desc: 'Reading A', status: 'running' } as Message;
    const toolB: Message = { id: 'tool-b' as Message['id'], kind: 'tool', createdAt: secondAt, tool: 'Edit', desc: 'Editing B', status: 'running' } as Message;
    const snapshot = ref<AgentStateSnapshot>({ version: 1, generatedAt: new Date(secondAt).toISOString(), rows: [] });
    const threadId = ref<string | undefined>('thread-a');
    const agentName = ref('Sulla');
    const transcript = ref<readonly Message[]>([toolA]);
    const activity = useThreadAgentActivity({ snapshot, threadId, transcript, primaryAgentName: agentName, now: () => secondAt });
    const queue = new StatusRollupQueue();
    const transfer = () => {
      const items = [...activity.checkIns.value];
      queue.observe(items, 'thread-a', secondAt);
      activity.consumeCheckIns();
      return items;
    };

    const startA = transfer();
    expect(startA).toHaveLength(1);
    expect(startA[0]).toMatchObject({ phase: 'start', correlationId: 'primary:thread-a:tool-a', observedAt: firstAt });

    transcript.value = [toolA, toolB];
    await nextTick();
    await vi.advanceTimersByTimeAsync(100);
    await nextTick();
    const startB = transfer();
    expect(startB).toHaveLength(1);
    expect(startB[0]).toMatchObject({ phase: 'start', correlationId: 'primary:thread-a:tool-b', observedAt: secondAt });

    transcript.value = [{ ...toolA, status: 'ok' } as Message, toolB];
    await nextTick();
    await vi.advanceTimersByTimeAsync(100);
    await nextTick();
    const finishA = transfer();
    expect(finishA).toHaveLength(1);
    expect(finishA[0]).toMatchObject({ phase: 'result', correlationId: 'primary:thread-a:tool-a', observedAt: firstAt });

    // Force another projection after the result; A must not replay and B must remain pending exactly once.
    agentName.value = 'Assistant';
    await nextTick();
    await vi.advanceTimersByTimeAsync(100);
    await nextTick();

    expect(activity.checkIns.value).toEqual([]);
    expect(queue.pending.map(item => [item.correlationId, item.phase])).toEqual([
      ['primary:thread-a:tool-a', 'start'],
      ['primary:thread-a:tool-b', 'start'],
      ['primary:thread-a:tool-a', 'result'],
    ]);
  });
});
