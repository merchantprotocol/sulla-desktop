// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
// A restored chat keeps its exact per-chat model through startup: the real ChatPage, ChatController,
// ThreadRegistry, LocalStoragePersister and AgentModelSelectorController run; only IPC is faked.
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

// Transport boundary: the renderer message bus is inert here (no backend run state in these tests).
vi.mock('@pkg/agent/services/WebSocketClientService', () => {
  const inert: any = new Proxy({}, { get: (_target, key) => key === 'then' ? undefined : () => () => undefined });
  return { getWebSocketClientService: () => inert };
});
// Canvas.vue is template-only, which the agent test SFC compiler cannot load; it only lays out slots.
vi.mock('@pkg/pages/chat/components/chrome/Canvas.vue', () => ({ default: { name: 'Canvas', template: '<div><slot /></div>' } }));

import ChatPage from '@pkg/pages/chat/ChatPage.vue';
import { ThreadRegistry } from '@pkg/pages/chat/controller/ThreadRegistry';
import { ChatControllerKey, ModelSelectorKey } from '@pkg/pages/chat/controller/useChatController';

import type { ChatController } from '@pkg/pages/chat/controller/ChatController';
import { LocalStoragePersister } from '@pkg/pages/chat/services/LocalStoragePersister';

const opus = { id: 'claude-opus-5-5', name: 'opus-5.5', tier: 'hosted' as const, ctx: '' };

function release(channel: string, value: unknown): void {
  f.hold.delete(channel);
  for (const waiter of f.pending.get(channel) ?? []) waiter.resolve(value);
  f.pending.delete(channel);
}

/** Saves a real thread the way a previous session did, and points the tab at it. */
function savedChat(tabId: string, options: { keepLocal: boolean }) {
  const persister = new LocalStoragePersister();
  const saved = new ThreadRegistry(persister).create({ tabId });
  saved.selectForChat(opus, 'claude-code', null);
  const state = saved.serialize();
  persister.setTabThread(tabId, saved.thread.value.id);
  // A thread missing from this renderer's localStorage is reopened from the durable DB backup.
  if (!options.keepLocal) localStorage.removeItem(`chat:thread:${ saved.thread.value.id }`);
  return state;
}

/** Mounts the real page and reads the controller it provides to its descendants. */
function mountChat(tabId: string) {
  const wrapper = shallowMount(ChatPage, { props: { tabId } }) as VueWrapper;
  const provides = (wrapper.vm as unknown as { $: { provides: Record<symbol, unknown> } }).$.provides;
  return {
    wrapper,
    controller: () => provides[ChatControllerKey as symbol] as ChatController,
    // The same selector the page provides to its model menu.
    selector: () => provides[ModelSelectorKey as symbol] as {
      selectModel(option: Record<string, unknown>): void;
      activePrimaryProvider: { value: string };
      activeModelId: { value: string };
    },
  };
}

const mounted: VueWrapper[] = [];
beforeEach(() => {
  localStorage.clear(); f.pending.clear(); f.hold.clear(); f.responses.clear();
  f.responses.set('agent-definitions:list', []);
  f.responses.set('model-provider:get-providers', []);
  f.responses.set('conversation-history:get-recent', []);
});
afterEach(() => { mounted.splice(0).forEach(wrapper => wrapper.unmount()) });

describe('restoring a chat with an exact per-chat model', () => {
  it('keeps the saved model and provider while the selector starts and after delayed settings load', async() => {
    savedChat('tab-restore', { keepLocal: true });
    f.hold.add('model-provider:get-state');
    const { wrapper, controller } = mountChat('tab-restore');
    mounted.push(wrapper);
    await flushPromises();
    expect(controller().model.value.id).toBe('claude-opus-5-5');
    expect(controller().thread.value.providerId).toBe('claude-code');

    // Preferences' global state arrives late: it must not overwrite the chat's own pin.
    release('model-provider:get-state', { primaryProvider: 'codex', activeModelId: 'gpt-6-luna' });
    await flushPromises();
    expect(controller().model.value.id).toBe('claude-opus-5-5');
    expect(controller().model.value.name).not.toBe('Auto');
    expect(controller().thread.value.providerId).toBe('claude-code');
  });

  it('restores the exact model when the thread arrives later from the database backup', async() => {
    const state = savedChat('tab-db', { keepLocal: false });
    f.hold.add('chat-messages:load');
    const { wrapper, controller, selector } = mountChat('tab-db');
    mounted.push(wrapper);
    await flushPromises();
    release('chat-messages:load', { success: true, data: state });
    await flushPromises();
    expect(controller().thread.value.id).toBe(state.thread.id);
    expect(controller().model.value.id).toBe('claude-opus-5-5');
    expect(controller().thread.value.providerId).toBe('claude-code');
    // The model menu shows the restored chat pin, not Default.
    expect(selector().activePrimaryProvider.value).toBe('claude-code');
    expect(selector().activeModelId.value).toBe('claude-opus-5-5');
  });

  it('keeps a fresh chat on Default', async() => {
    const { wrapper, controller } = mountChat('tab-fresh');
    mounted.push(wrapper);
    await flushPromises();
    expect(controller().model.value).toMatchObject({ id: '', name: 'Default' });
    expect(controller().thread.value.providerId ?? null).toBeNull();
  });

  it('keeps a newer human pick made while the database restore was still loading', async() => {
    const state = savedChat('tab-human', { keepLocal: false });
    f.hold.add('chat-messages:load');
    const { wrapper, controller, selector } = mountChat('tab-human');
    mounted.push(wrapper);
    await flushPromises();
    // The human picks Codex in the provisional thread before the slow DB restore finishes.
    selector().selectModel({ providerId: 'codex', providerName: 'Codex', modelId: 'gpt-6-luna', modelLabel: 'GPT-6 Luna', isActiveProvider: true, isActiveModel: true });
    await flushPromises();
    release('chat-messages:load', { success: true, data: state });
    await flushPromises();
    expect(controller().thread.value.id).toBe(state.thread.id);
    expect(controller().model.value.id).toBe('gpt-6-luna');
    expect(controller().thread.value.providerId).toBe('codex');
  });
});
