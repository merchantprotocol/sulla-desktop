// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
import { mount, flushPromises } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, ref, nextTick } from 'vue';

import { useResultActivity } from '@pkg/pages/chat/composables/useResultActivity';
import { ChatControllerKey } from '@pkg/pages/chat/controller/useChatController';
import { AGENT_STATE_CLIENT_KEY } from '@pkg/services/agentState/AgentStateInjection';
import type { AgentResultItem } from '@pkg/shared/agentResults/AgentResultCard';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@pkg/utils/ipcRenderer', () => ({ ipcRenderer: { invoke } }));
vi.mock('@pkg/composables/useDecisions', () => ({ useDecisions: () => ({ records: ref([]), error: ref('') }) }));
const item = { jobId: 'old', taskIndex: 0, status: 'blocked', tone: 'warn', label: 'Old result' } as AgentResultItem;
const wrappers: { unmount(): void }[] = [];
afterEach(() => { wrappers.splice(0).forEach(wrapper => wrapper.unmount()); vi.useRealTimers(); invoke.mockReset() });
function fixture(owner: string) {
  const snapshot = ref({ version: 1, rows: [] });
  const ownerThread = ref<string | undefined>(owner);
  const Card = defineComponent({ setup() { const { activity } = useResultActivity(); return () => h('p', activity(item).label) } });
  const wrapper = mount(Card, { global: { provide: { [ChatControllerKey as symbol]: { messages: ref([]) }, [AGENT_STATE_CLIENT_KEY as symbol]: { snapshot, error: ref('') }, 'chat:activity-context': { backendThreadId: ownerThread } } } });
  wrappers.push(wrapper);
  return { wrapper, snapshot, ownerThread };
}
describe('result correlation subscription', () => {
  it('shares and coalesces history reads across card consumers and activity bursts', async() => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-15T12:00:00Z'));
    invoke.mockResolvedValue([{ jobId: 'new', taskIndex: 0, status: 'completed', followUpOf: { jobId: 'old', taskIndex: 0 } }]);
    const one = fixture('reader-one'); const two = fixture('reader-one');
    await vi.advanceTimersByTimeAsync(0); await flushPromises();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(one.wrapper.text()).toBe('Follow-up completed');
    expect(two.wrapper.text()).toBe('Follow-up completed');
    for (let version = 2; version <= 40; version++) { one.snapshot.value = { version, rows: [] }; two.snapshot.value = { version, rows: [] } }
    await nextTick(); await vi.advanceTimersByTimeAsync(1999);
    expect(invoke).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); await flushPromises();
    expect(invoke).toHaveBeenCalledTimes(2);
  });
  it('does not reuse another owner and recovers a failed read on focus', async() => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-15T13:00:00Z'));
    invoke.mockRejectedValueOnce(new Error('offline'));
    const { wrapper, ownerThread } = fixture('reader-two');
    await vi.advanceTimersByTimeAsync(0); await flushPromises();
    expect(wrapper.text()).toBe('Status not confirmed');
    invoke.mockResolvedValue([{ jobId: 'new', taskIndex: 0, status: 'completed', followUpOf: { jobId: 'old', taskIndex: 0 } }]);
    window.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(2000); await flushPromises();
    expect(wrapper.text()).toBe('Follow-up completed');
    invoke.mockResolvedValue([]);
    ownerThread.value = 'reader-three';
    await nextTick(); await vi.advanceTimersByTimeAsync(0); await flushPromises();
    expect(invoke).toHaveBeenLastCalledWith('agents:result-tracking', 'reader-three');
    expect(wrapper.text()).toBe('Status not confirmed');
  });
});
