// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick, ref } from 'vue';

import ForYouPanel from '@pkg/pages/chat/components/sidedock/ForYouPanel.vue';
import { ChatDecisions, type ChatDecisionStore } from '@pkg/pages/chat/composables/useChatDecisions';
import { ChatControllerKey } from '@pkg/pages/chat/controller/useChatController';
const f = vi.hoisted(() => ({ records: [] as any[], listeners: new Map<string, any>(), invoke: vi.fn() }));
vi.mock('@pkg/utils/ipcRenderer', () => ({ ipcRenderer: { invoke: (...args:any[]) => f.invoke(...args), on: (name:string, fn:any) => f.listeners.set(name, fn), removeListener: (name:string) => f.listeners.delete(name) } }));
const question = (id = 'q', extra:any = {}): any => ({ id, conversationId: 'a', channel: 'channel', title: 'Choose an environment', kind: 'question', status: 'expired', attention: 'active', createdAt: 10, expiresAt: 1, questions: [{ header: 'Environment', question: 'Which environment?', options: [{ label: 'Staging', description: 'Use the safe test environment' }, { label: 'Production' }] }], ...extra });
const mounted: any[] = [];
beforeEach(() => {
  f.records = [question()]; f.listeners.clear(); f.invoke.mockReset(); f.invoke.mockImplementation(async(name:string, ...args:any[]) => {
    await Promise.resolve();
    if (name === 'decisions:conversation') return structuredClone(f.records.filter(record => record.conversationId === args[0]));
    if (name === 'decisions:resolve') { const response = args[0]; f.records = f.records.map(record => record.id === response.id ? { ...record, attention: 'answered', answers: response.answers, answerDelivery: 'queued' } : record); return { settled: true, late: true } }
    if (name === 'decisions:dismiss') { f.records = f.records.map(record => record.id === args[0] ? { ...record, attention: 'dismissed' } : record); return { settled: true } }
    return [];
  });
});
afterEach(() => { mounted.splice(0).forEach(wrapper => wrapper.unmount()); vi.useRealTimers() });
async function fixture() {
  const owner = ref<string | undefined>('a'); const visible = ref(true); let store!:ChatDecisionStore;
  const component = defineComponent({ setup() { store = ChatDecisions.provide(owner); return () => visible.value ? h(ForYouPanel) : h('div') } });
  const wrapper = mount(component, { global: { provide: { [ChatControllerKey as symbol]: { thread: ref({ id: 'ui-a' }), messages: ref([]) }, 'chat:activity-context': { backendThreadId: owner } } } }); mounted.push(wrapper); await flushPromises(); return { wrapper, store, owner, visible };
}
describe('For You requests', () => {
  it('loads saved requests when opening the panel after an update was missed', async() => {
    f.records = [];
    const v = await fixture();
    v.visible.value = false;
    await nextTick();

    f.records = [question('recovered')];
    expect(v.store.openCount.value).toBe(0);
    v.visible.value = true;
    await flushPromises();

    expect(v.store.openCount.value).toBe(1);
    expect(v.wrapper.get('.fy-request').attributes('data-decision-id')).toBe('recovered');
  });

  it('does not ask again when submitting the newer copy of an expired duplicate', async() => {
    f.records = [question('old'), question('new', { createdAt: 20 })];
    const v = await fixture();
    const newer = v.store.decisions.value.find(record => record.id === 'new')!;
    await v.store.resolve(newer, 'answered', [{ question: 'Which environment?', selected: ['Staging'] }]);
    await flushPromises();
    expect(v.store.openCount.value).toBe(0);
    expect(v.wrapper.text()).toContain('Duplicate request');
    expect(v.wrapper.text()).toContain('does not need another answer');
    expect(v.wrapper.find('.fy-past').attributes('open')).toBeUndefined();
    expect(f.records.find(record => record.id === 'old').attention).toBe('active');
    expect(f.records.find(record => record.id === 'old').answers).toBeUndefined();
    expect(f.invoke.mock.calls.filter(call => call[0] === 'decisions:resolve')).toHaveLength(1);
    await v.store.refresh();
    expect(v.store.openCount.value).toBe(0);
  });
  it('keeps an expired waiter answerable, preserves its draft across tab mounts, and moves a confirmed answer to Past', async() => {
    const v = await fixture(); expect(v.store.openCount.value).toBe(1); expect(v.wrapper.text()).not.toContain('Expires in');
    await v.wrapper.findAll('[role=radio]')[0].trigger('click'); v.visible.value = false; await nextTick(); v.visible.value = true; await nextTick();
    expect(v.wrapper.find('[role=radio]').attributes('aria-checked')).toBe('true');
    await v.wrapper.find('.qc-submit').trigger('click'); await flushPromises();
    expect(v.store.openCount.value).toBe(0); expect(v.wrapper.find('.fy-past').attributes('open')).toBeUndefined();
    expect(v.wrapper.text()).toContain('Staging'); expect(v.wrapper.text()).toContain('Answer queued');
  });
  it('retains draft and attention after a failed save and dismisses only when persistence confirms', async() => {
    const v = await fixture(); await v.wrapper.find('[role=radio]').trigger('click'); f.invoke.mockImplementation(async(name:string) => { await Promise.resolve(); if (name === 'decisions:resolve') return { settled: false, reason: 'Unavailable' }; if (name === 'decisions:dismiss') return { settled: false }; return f.records });
    await v.wrapper.find('.qc-submit').trigger('click'); await flushPromises(); expect(v.store.openCount.value).toBe(1); expect(v.wrapper.text()).toContain('Unavailable'); expect(v.wrapper.find('[role=radio]').attributes('aria-checked')).toBe('true');
    await v.wrapper.find('.fy-dismiss').trigger('click'); await flushPromises(); expect(v.store.openCount.value).toBe(1);
  });
  it('never inserts the previous chat after switching during a save', async() => {
    const v = await fixture(); let finish!:(value:any)=>void; f.invoke.mockImplementation((name:string) => name === 'decisions:resolve' ? new Promise(resolve => { finish = resolve }) : Promise.resolve([]));
    const saving = v.store.resolve(v.store.decisions.value[0], 'answered', [{ question: 'Which environment?', selected: ['Staging'] }]); v.owner.value = 'b'; await flushPromises(); finish({ settled: true, late: true }); await saving; expect(v.store.decisions.value).toEqual([]);
  });
  it('opens a targeted historical request and preserves expansion through a live refresh', async() => {
    f.records = [question('past', { status: 'answered', attention: 'answered', answers: [{ question: 'Which environment?', selected: ['Staging'] }] })]; const v = await fixture(); v.store.show('past'); await flushPromises(); expect(v.wrapper.find('.fy-past').attributes('open')).toBeDefined(); await v.store.refresh(); await nextTick(); expect(v.wrapper.find('.fy-past').attributes('open')).toBeDefined();
  });
  it('restores the saved selection when delivery is interrupted, without resubmitting automatically', async() => {
    f.records = [question('interrupted', { answerDelivery: 'interrupted', answers: [{ question: 'Which environment?', selected: ['Staging'] }] })]; const v = await fixture();
    expect(v.store.openCount.value).toBe(1); expect(v.wrapper.text()).toContain('Check the original chat'); expect(v.wrapper.find('[role=radio]').attributes('aria-checked')).toBe('true');
    expect(f.invoke.mock.calls.some(call => call[0] === 'decisions:resolve')).toBe(false);
  });
  it('keeps task Done, Copy and Reply controls on the shared durable answer route', async() => {
    f.records = [question('task', { questions: [{ question: 'Finish signing in', task: true, command: 'example --sign-in', options: [{ label: 'Done' }] }] })]; const v = await fixture(); expect(v.wrapper.find('.tk-copy').text()).toBe('Copy'); expect(v.wrapper.find('.tk-f').text()).toContain('Reply'); await v.wrapper.find('.tk-pri').trigger('click'); await flushPromises(); expect(f.invoke).toHaveBeenCalledWith('decisions:resolve', expect.objectContaining({ answers: [{ question: 'Finish signing in', selected: ['Done'] }] }));
  });
});
