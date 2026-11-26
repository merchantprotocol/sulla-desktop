// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, ref } from 'vue';

import { ChatDecisions, type ChatDecisionStore } from '@pkg/pages/chat/composables/useChatDecisions';
const f = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@pkg/utils/ipcRenderer', () => ({ ipcRenderer: { invoke: (...args: unknown[]) => f.invoke(...args), on: vi.fn(), removeListener: vi.fn() } }));
let wrapper: ReturnType<typeof mount>;
let store: ChatDecisionStore;
const owner = ref('qa');
function start() {
  wrapper = mount(defineComponent({ setup() { store = ChatDecisions.provide(owner); return () => h('div') } }));
}
beforeEach(() => { vi.useFakeTimers(); f.invoke.mockReset(); owner.value = 'qa' });
afterEach(() => { wrapper?.unmount(); vi.useRealTimers() });
describe('Decide interrupted reads', () => {
  it('recovers automatically without losing loaded requests or drafts', async() => {
    const question = { id: 'q', conversationId: 'qa', kind: 'question', status: 'pending', attention: 'active', createdAt: 1, questions: [{ question: 'Continue?', options: [{ label: 'Yes' }] }] } as any;
    f.invoke.mockResolvedValueOnce([question]); start(); await flushPromises();
    store.draft(question).other[0] = 'My answer';
    f.invoke.mockRejectedValueOnce(Error('Connection terminated due to connection timeout')).mockResolvedValue([question]);
    await store.refresh(); expect(store.error.value).toContain('Reconnecting');
    expect(store.decisions.value).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000); await flushPromises();
    expect(store.error.value).toBe(''); expect(store.draft(question).other[0]).toBe('My answer');
    expect(f.invoke.mock.calls.every(([name]) => name === 'decisions:conversation')).toBe(true);
  });
  it('stops after three retries and cancels retry on unmount', async() => {
    f.invoke.mockRejectedValue(Error('Connection terminated unexpectedly')); start(); await flushPromises();
    await vi.advanceTimersByTimeAsync(7000); await flushPromises();
    expect(f.invoke).toHaveBeenCalledTimes(4); expect(store.error.value).toContain('temporarily unavailable');
    await vi.advanceTimersByTimeAsync(30000); expect(f.invoke).toHaveBeenCalledTimes(4);
    await store.refresh(); wrapper.unmount(); await vi.advanceTimersByTimeAsync(10000); expect(f.invoke).toHaveBeenCalledTimes(5);
  });
  it('never retries a denied or malformed request', async() => {
    f.invoke.mockRejectedValue(Error('Untrusted caller')); start(); await flushPromises();
    await vi.advanceTimersByTimeAsync(10000); expect(f.invoke).toHaveBeenCalledTimes(1); expect(store.error.value).toBe('Untrusted caller');
  });
});
