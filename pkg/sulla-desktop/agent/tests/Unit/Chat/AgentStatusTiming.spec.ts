// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { computed, nextTick, ref } from 'vue';

import ThreadStatusLine from '@pkg/pages/chat/components/composer/ThreadStatusLine.vue';
import AgentLanes from '@pkg/pages/chat/components/sidedock/AgentLanes.vue';
import { ChatControllerKey } from '@pkg/pages/chat/controller/useChatController';
import { AGENT_STATE_CLIENT_KEY } from '@pkg/services/agentState/AgentStateInjection';

vi.mock('@pkg/utils/ipcRenderer', () => ({ ipcRenderer: { invoke: vi.fn(() => Promise.resolve([])), send: vi.fn(), on: vi.fn(), removeListener: vi.fn() } }));
vi.mock('@pkg/pages/chat/composables/useChatDecisions', () => ({ ChatDecisions: { useChatDecisions: () => ({ openCount: ref(0), show: vi.fn() }) } }));

describe('the two agent status views', () => {
  it('uses last activity rather than launch time and follows the same snapshot update', async() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-16T23:00:00Z'));
    const row = { key: 'timing:0', jobId: 'timing', taskIndex: 0, parentJobId: null, parentTaskIndex: null, rootThreadId: 'timing-thread', threadId: 'timing-child', depth: 0, agentId: 'codex-sol-worker', label: 'Timing QA', visibility: 'hidden', state: 'quiet', stateReason: null, killedByHuman: false, waitingOnChildren: 0, startedAt: new Date(Date.now() - 600_000).toISOString(), endedAt: null, lastActivityAt: new Date(Date.now() - 38_000).toISOString(), lastCheckinAt: null, lastCheckinSummary: null, runtimeAlive: false, canMessage: true, canStop: true, canOpen: true };
    const client = { snapshot: ref({ version: 1, generatedAt: '', rows: [row] }), apply: vi.fn() };
    const controller = { messages: computed(() => []), isRunning: computed(() => false), heartbeat: ref({ intervalMinutes: null }) };
    const global = { provide: { [ChatControllerKey as symbol]: controller, [AGENT_STATE_CLIENT_KEY as symbol]: client, 'chat:activity-context': { tabId: 'timing-tab', backendThreadId: ref('timing-thread') } } };
    const lanes = mount(AgentLanes, { global });
    const line = mount(ThreadStatusLine, { global });
    try {
      await line.find('.ta-line').trigger('click');
      expect(lanes.get('.ln-time time').attributes('datetime')).toBe(row.lastActivityAt);
      expect(line.get('.ta-when time').attributes('datetime')).toBe(row.lastActivityAt);
      expect(lanes.get('.ln-time time').text()).toBe(line.get('.ta-when time').text());
      expect(lanes.find('.ln-sum').text()).toContain('No progress');
      expect(line.find('.ta-line').text()).toContain('No progress');
      client.snapshot.value = { version: 2, generatedAt: '', rows: [{ ...row, state: 'working', lastActivityAt: new Date().toISOString() }] };
      await nextTick();
      expect(lanes.get('.ln-time time').attributes('datetime')).toBe(new Date().toISOString());
      expect(line.get('.ta-when time').attributes('datetime')).toBe(new Date().toISOString());
      expect(lanes.find('.ln-sum').text()).not.toContain('No progress');
      expect(lanes.find('.ln-sum b').text()).toBe('Working');
      expect(line.find('.ta-line').text()).toContain('Working');
      client.snapshot.value = { version: 3, generatedAt: '', rows: [] };
      controller.heartbeat.value.intervalMinutes = 20 as any;
      await nextTick();
      expect(lanes.find('.ln-sum b').text()).toBe('Waiting');
      expect(line.find('.ta-line').text()).toContain('Waiting');
      expect(lanes.find('.ln-sum').text()).toContain('20');
      expect(line.find('.ta-line').text()).not.toContain('No progress');
    } finally { lanes.unmount(); line.unmount(); vi.useRealTimers() }
  });
});
