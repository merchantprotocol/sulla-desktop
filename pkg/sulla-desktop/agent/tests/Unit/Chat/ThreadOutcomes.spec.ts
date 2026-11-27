// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, expect, it, vi } from 'vitest';
import { ref } from 'vue';

import SideDock from '@pkg/pages/chat/components/sidedock/SideDock.vue';
import { ChatControllerKey } from '@pkg/pages/chat/controller/useChatController';
import { AGENT_STATE_CLIENT_KEY } from '@pkg/services/agentState/AgentStateInjection';

vi.mock('@pkg/utils/ipcRenderer', () => ({ ipcRenderer: { invoke: vi.fn(() => Promise.resolve([])), on: vi.fn(), removeListener: vi.fn() } }));
vi.mock('@pkg/composables/useDecisions', () => ({ useDecisions: () => ({ records: ref([]), error: ref('') }) }));
afterEach(() => vi.restoreAllMocks());
it('shows returned outcomes and updates live without repeating the agent timeline or questions', async() => {
  const thread = ref({ id: 'a', title: 'Payment safety' }); const owner = ref('a'); const messages = ref<any[]>([]);
  const row = (jobId:string, rootThreadId:string):any => ({ key: jobId + ':0', jobId, taskIndex: 0, rootThreadId, threadId: 'child-' + jobId, label: jobId, state: 'working', endedAt: null, parentJobId: null, parentTaskIndex: null, lastCheckinSummary: 'Checks running' });
  const snapshot = ref({ version: 1, rows: [row('payment', 'a'), row('sender', 'b')] });
  const report = (jobId:string, label:string, outcome:string):any => ({ id: 'report-' + jobId, kind: 'proactive', createdAt: Date.now(), headline: '', body: '', result: { items: [{ jobId, taskIndex: 0, label, status: 'completed', purpose: 'fix', verdict: 'Done', tone: 'ok', outcome, report: outcome, endedAt: Date.now(), threadId: 'child-' + jobId, links: [{ label: 'PR #123', url: 'https://github.com/example/repo/pull/123' }] }] } });
  const wrapper = mount(SideDock, { global: { provide: { [ChatControllerKey as symbol]: { thread, messages, isRunning: ref(false), artifacts: ref({ list: [] }) }, [AGENT_STATE_CLIENT_KEY as symbol]: { snapshot, error: ref(''), resync: vi.fn(async() => {}) }, 'chat:activity-context': { backendThreadId: owner } } } });
  expect(wrapper.find('.work-outcome').exists()).toBe(false); expect(wrapper.find('select').exists()).toBe(false);
  messages.value = [report('payment', 'Payment review', 'Confirm review of #123 at head abc1234: CHANGES_REQUESTED.')];
  await flushPromises();
  const payment = wrapper.get('[data-job-key="payment:0"]');
  expect(payment.text()).toContain('1 report');
  await payment.trigger('click');
  expect(wrapper.find('.outcome-verdict').text()).toBe('Changes requested'); expect(wrapper.text()).toContain('Payment review'); expect(wrapper.text()).toContain('PR #123');
  expect(wrapper.get('.work-outcome').text()).not.toContain('Checks running'); expect(wrapper.text()).not.toContain('sender'); expect(wrapper.text()).not.toContain('Needs your answer');
  messages.value = [report('payment', 'Payment review', 'Updated PR #123 with the validation fix.')]; await flushPromises();
  expect(wrapper.find('.outcome-verdict').text()).toBe('Branch updated');
  owner.value = 'b'; thread.value = { id: 'b', title: 'Sender names' }; messages.value = []; await flushPromises();
  expect(wrapper.text()).not.toContain('Payment review'); expect(wrapper.find('.work-outcome').exists()).toBe(false); wrapper.unmount();
});
