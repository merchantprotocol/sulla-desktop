// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
// A long chat whose browser cache holds only the recent tail reopens with its complete history:
// the real ChatPage, ThreadRegistry, LocalStoragePersister and ChatController run; only IPC is faked.
import { flushPromises, shallowMount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const f = vi.hoisted(() => ({
  pending: new Map<string, Array<{ resolve: (value: unknown) => void; reject: (error: unknown) => void }>>(),
  hold: new Set<string>(),
  responses: new Map<string, unknown>(),
}));

vi.mock('electron', () => ({ webUtils: { getPathForFile: () => '' }, ipcRenderer: { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn(), send: vi.fn() } }));
vi.mock('@pkg/utils/ipcRenderer', () => ({ ipcRenderer: {
  invoke: vi.fn((channel: string) => {
    if (f.hold.has(channel)) return new Promise((resolve, reject) => { f.pending.set(channel, [...(f.pending.get(channel) ?? []), { resolve, reject }]) });
    return Promise.resolve(f.responses.has(channel) ? f.responses.get(channel) : undefined);
  }),
  on: vi.fn(), removeListener: vi.fn(), removeAllListeners: vi.fn(), send: vi.fn(), sendSync: vi.fn(),
} }));
// Transport boundary: the renderer message bus is inert here.
vi.mock('@pkg/agent/services/WebSocketClientService', () => {
  const inert: any = new Proxy({}, { get: (_target, key) => key === 'then' ? undefined : () => () => undefined });
  return { getWebSocketClientService: () => inert };
});
// Canvas.vue is template-only, which the agent test SFC compiler cannot load; it only lays out slots.
vi.mock('@pkg/pages/chat/components/chrome/Canvas.vue', () => ({ default: { name: 'Canvas', template: '<div><slot /></div>' } }));

import ChatPage from '@pkg/pages/chat/ChatPage.vue';
import { ChatController } from '@pkg/pages/chat/controller/ChatController';
import { ChatControllerKey } from '@pkg/pages/chat/controller/useChatController';
import { LocalStoragePersister } from '@pkg/pages/chat/services/LocalStoragePersister';
import { asMessageId, type ThreadId } from '@pkg/pages/chat/types/chat';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

import type { ThreadState } from '@pkg/pages/chat/models/Thread';

const TAB = 'tab_mwfmz5sq_jmlj8c';

/** The canonical thread the database holds: `count` ordered messages with stable ids. */
function canonicalThread(count: number, textSize = 8): ThreadState {
  const controller = new ChatController();
  controller.renameThread('T&B Staging Test');
  const state = controller.serialize();
  controller.dispose();
  state.thread.messages = Array.from({ length: count }, (_, index) => ({
    id: asMessageId(`m${ index }`), kind: 'user', createdAt: 1_794_000_000_000 + index, text: `message ${ index } ${ 'x'.repeat(textSize) }`,
  }));
  return state;
}

/** What an earlier build left in localStorage: only the recent tail, with no marker. */
function legacyTailCache(full: ThreadState, tail = 60): void {
  const cached = { ...full, thread: { ...full.thread, messages: full.thread.messages.slice(-tail) } };
  localStorage.setItem(`chat:thread:${ full.thread.id }`, JSON.stringify(cached));
  localStorage.setItem('chat:index', JSON.stringify([full.thread.id]));
  localStorage.setItem(`chat:tab:${ TAB }`, full.thread.id);
}

function release(channel: string, value: unknown): void {
  f.hold.delete(channel);
  for (const waiter of f.pending.get(channel) ?? []) waiter.resolve(value);
  f.pending.delete(channel);
}

function mountChat() {
  const wrapper = shallowMount(ChatPage, { props: { tabId: TAB } }) as VueWrapper;
  mounted.push(wrapper);
  const provides = (wrapper.vm as unknown as { $: { provides: Record<symbol, unknown> } }).$.provides;
  return () => provides[ChatControllerKey as symbol] as ChatController;
}

const loads = () => vi.mocked(ipcRenderer.invoke).mock.calls.filter(([channel]) => channel === 'chat-messages:load').length;
const ids = (controller: ChatController) => controller.messages.value.map(message => String(message.id));

const mounted: VueWrapper[] = [];
beforeEach(() => {
  localStorage.clear(); f.pending.clear(); f.hold.clear(); f.responses.clear();
  vi.mocked(ipcRenderer.invoke).mockClear();
  f.responses.set('agent-definitions:list', []);
  f.responses.set('model-provider:get-providers', []);
  f.responses.set('conversation-history:get-recent', []);
});
afterEach(() => { mounted.splice(0).forEach(wrapper => wrapper.unmount()); vi.useRealTimers() });

describe('reopening a long chat from a tail-only browser cache', () => {
  it('restores all 981 canonical messages behind a legacy 60-message cache', async() => {
    const full = canonicalThread(981);
    legacyTailCache(full);
    f.responses.set('chat-messages:load', { success: true, data: full });
    const controller = mountChat();
    await flushPromises();
    expect(new Set(ids(controller())).size).toBe(981);
    expect(ids(controller())).toEqual(full.thread.messages.map(message => String(message.id)));
    expect(controller().thread.value.title).toBe('T&B Staging Test');
  });

  it('restores the full history behind a newly capped (marked) cache copy', async() => {
    const full = canonicalThread(981, 1_600);
    new LocalStoragePersister().save(full);
    localStorage.setItem(`chat:tab:${ TAB }`, full.thread.id);
    expect((JSON.parse(localStorage.getItem(`chat:thread:${ full.thread.id }`)!) as ThreadState).thread.messages.length).toBe(60);
    f.responses.set('chat-messages:load', { success: true, data: full });
    const controller = mountChat();
    await flushPromises();
    expect(ids(controller())).toEqual(full.thread.messages.map(message => String(message.id)));
    // The browser cache stays a capped tail; the database keeps the full thread.
    expect((JSON.parse(localStorage.getItem(`chat:thread:${ full.thread.id }`)!) as ThreadState).thread.messages.length).toBe(60);
  });

  it('keeps edits, a new human message and live chat state made while the database read was pending', async() => {
    const full = canonicalThread(981);
    legacyTailCache(full);
    f.hold.add('chat-messages:load');
    const controller = mountChat();
    await flushPromises();
    const chat = controller();
    chat.updateMessage(asMessageId('m975'), { text: 'edited locally' } as any);
    chat.appendMessage({ id: asMessageId('human-new'), kind: 'user', createdAt: Date.now(), text: 'sent while loading' });
    chat.transitionRun({ type: 'send', messageId: asMessageId('human-new') });
    chat.send('queued behind the run');
    chat.stageAttachment({ id: 'att-1', name: 'notes.md', size: '1 KB', kind: 'file' } as any);
    chat.selectForChat({ id: 'grok-4.7', name: 'Grok 4.7', tier: 'hosted', ctx: '' }, 'grok', null);
    const live = JSON.stringify({ runState: chat.runState.value, queue: chat.queue.value, staged: chat.staged.value, model: chat.model.value, title: chat.thread.value.title, providerId: chat.thread.value.providerId });

    release('chat-messages:load', { success: true, data: full });
    await flushPromises();
    const restored = ids(chat);
    expect(restored).toEqual([...full.thread.messages.map(message => String(message.id)), 'human-new']);
    expect(new Set(restored).size).toBe(982);
    expect((chat.messages.value.find(message => message.id === 'm975') as any).text).toBe('edited locally');
    expect(JSON.stringify({ runState: chat.runState.value, queue: chat.queue.value, staged: chat.staged.value, model: chat.model.value, title: chat.thread.value.title, providerId: chat.thread.value.providerId })).toBe(live);
  });

  it('keeps the cached 60 messages and the tab pointer when the database read keeps failing', async() => {
    const full = canonicalThread(981);
    legacyTailCache(full);
    f.responses.set('chat-messages:load', { success: false, error: 'database unavailable' });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.useFakeTimers();
    const controller = mountChat();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ids(controller())).toEqual(full.thread.messages.slice(-60).map(message => String(message.id)));
    expect(localStorage.getItem(`chat:tab:${ TAB }`)).toBe(full.thread.id);
    expect(loads()).toBe(5);
  });

  it('does not re-read a small complete cached chat from the database', async() => {
    const full = canonicalThread(3);
    new LocalStoragePersister().save(full);
    localStorage.setItem(`chat:tab:${ TAB }`, full.thread.id as ThreadId);
    const controller = mountChat();
    await flushPromises();
    expect(ids(controller())).toEqual(['m0', 'm1', 'm2']);
    expect(loads()).toBe(0);
  });
});

describe('write provenance of a tail-only browser-cache view', () => {
  const saves = () => vi.mocked(ipcRenderer.invoke).mock.calls.filter(([channel]) => channel === 'chat-messages:save').map(([, , state]) => state as any);

  it('marks every save made while the full read is pending as partial, then saves complete after the merge', async() => {
    const full = canonicalThread(981);
    legacyTailCache(full);
    f.hold.add('chat-messages:load');
    const controller = mountChat();
    await flushPromises();
    controller().selectForChat({ id: 'grok-4.7', name: 'Grok 4.7', tier: 'hosted', ctx: '' }, 'grok', null);
    expect(saves().at(-1)).toMatchObject({ partialHistory: true });
    expect(saves().at(-1).thread.messages).toHaveLength(60);

    release('chat-messages:load', { success: true, data: full });
    await flushPromises();
    expect(controller().serialize()).not.toHaveProperty('partialHistory');
    controller().renameThread('Renamed after merge');
    expect(saves().at(-1)).not.toHaveProperty('partialHistory');
    expect(saves().at(-1).thread.messages).toHaveLength(981);
  });

  it('clears partial provenance after a complete read even when it adds no messages', async() => {
    const full = canonicalThread(60);
    legacyTailCache(full);
    f.responses.set('chat-messages:load', { success: true, data: full });
    const controller = mountChat();
    await flushPromises();
    expect(ids(controller())).toHaveLength(60);
    expect(controller().serialize()).not.toHaveProperty('partialHistory');
  });

  it('keeps the partial marker in the browser cache through failed reads, even after an edit leaves 59 messages', async() => {
    const full = canonicalThread(981);
    legacyTailCache(full);
    f.responses.set('chat-messages:load', { success: false, error: 'database unavailable' });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.useFakeTimers();
    const controller = mountChat();
    await vi.advanceTimersByTimeAsync(60_000);
    controller().removeMessage(asMessageId('m975'));
    controller().persistThread();
    const cached = JSON.parse(localStorage.getItem(`chat:thread:${ full.thread.id }`)!) as ThreadState;
    expect(cached.thread.messages).toHaveLength(59);
    expect(new LocalStoragePersister().isTailOnlyCache(cached)).toBe(true);
    expect(saves().at(-1)).toMatchObject({ partialHistory: true });
  });

  it('keeps an ordinary fresh chat complete', async() => {
    const controller = mountChat();
    await flushPromises();
    controller().renameThread('Fresh');
    expect(saves().at(-1)).not.toHaveProperty('partialHistory');
  });
});
