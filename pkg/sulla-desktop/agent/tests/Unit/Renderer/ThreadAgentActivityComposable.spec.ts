// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';
import { ref } from 'vue';

import { StatusRollupQueue } from '@pkg/pages/chat/components/composer/StatusRollupQueue';
import { useThreadAgentActivity } from '@pkg/pages/chat/composables/useThreadAgentActivity';
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
  it('keeps chart, status items, and root fallback inside the active thread', () => {
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
    expect(primary.map(item => [item.agentName, item.text])).toEqual([['Sulla', 'Reading ChatPage.vue']]);
    expect(texts().some(text => text.includes('secret-a'))).toBe(false);
    expect(texts()).not.toContain('Editing thread-b file');
    expect(activity.rootFallback.value?.key).toBe('job-a:0:fallback');
    expect(activity.rootFallback.value?.text).toBe('check-in job-a:0');

    threadId.value = 'thread-b';
    transcript.value = transcripts['thread-b'];
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
});
