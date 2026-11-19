// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
// The agent editor's Try opens a normal chat with that agent selected once. A later human pick
// (Default or a plain model) must survive remount, reopen and restart. The real ChatPage,
// ChatController, ThreadRegistry, LocalStoragePersister and AgentModelSelectorController run;
// only IPC is faked.
import { flushPromises, shallowMount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ChatPage from '@pkg/pages/chat/ChatPage.vue';
import type { ChatController } from '@pkg/pages/chat/controller/ChatController';
import { ThreadRegistry } from '@pkg/pages/chat/controller/ThreadRegistry';
import { ChatControllerKey, ModelSelectorKey } from '@pkg/pages/chat/controller/useChatController';
import { LocalStoragePersister } from '@pkg/pages/chat/services/LocalStoragePersister';

const f = vi.hoisted(() => ({ responses: new Map<string, unknown>() }));

vi.mock('electron', () => ({ webUtils: { getPathForFile: () => '' }, ipcRenderer: { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn(), send: vi.fn() } }));
vi.mock('@pkg/utils/ipcRenderer', () => ({
  ipcRenderer: {
    invoke:             vi.fn((channel: string) => Promise.resolve(f.responses.has(channel) ? f.responses.get(channel) : undefined)),
    on:                 vi.fn(),
    removeListener:     vi.fn(),
    removeAllListeners: vi.fn(),
    send:               vi.fn(),
    sendSync:           vi.fn(),
  },
}));
vi.mock('@pkg/agent/services/WebSocketClientService', () => {
  const inert: any = new Proxy({}, { get: (_target, key) => key === 'then' ? undefined : () => () => undefined });
  return { getWebSocketClientService: () => inert };
});
vi.mock('@pkg/pages/chat/components/chrome/Canvas.vue', () => ({ default: { name: 'Canvas', template: '<div><slot /></div>' } }));

const TRIED = 'qa-tried-agent';
const luna = { providerId: 'codex', providerName: 'Codex', modelId: 'gpt-6-luna', modelLabel: 'GPT-6 Luna', isActiveProvider: true, isActiveModel: true };

const mounted: VueWrapper[] = [];
function mountChat(props: Record<string, unknown>) {
  const wrapper = shallowMount(ChatPage, { props }) as VueWrapper;
  mounted.push(wrapper);
  const provides = (wrapper.vm as unknown as { $: { provides: Record<symbol, unknown> } }).$.provides;
  return {
    wrapper,
    controller: () => provides[ChatControllerKey as symbol] as ChatController,
    selector:   () => provides[ModelSelectorKey as symbol] as { selectDefault(): void; selectModel(option: Record<string, unknown>): void },
  };
}
function unmountAll(): void { mounted.splice(0).forEach(wrapper => wrapper.unmount()) }

beforeEach(() => {
  localStorage.clear(); f.responses.clear();
  f.responses.set('agent-definitions:list', [{ id: 'agent-1', slug: TRIED, name: 'QA Tried', enabled: true, status: 'production' }]);
  f.responses.set('model-provider:get-providers', []);
  f.responses.set('conversation-history:get-recent', []);
});
afterEach(unmountAll);

describe('Try opens a normal chat with the agent selected once', () => {
  it('selects the tried agent on the new chat and tells the tab the handoff is used', async() => {
    const { wrapper, controller } = mountChat({ tabId: 'tab-try', handoffAgentId: TRIED });
    await flushPromises();
    expect(controller().thread.value.agentId).toBe(TRIED);
    expect(controller().thread.value.messages).toHaveLength(0);
    expect(wrapper.emitted('handoff-agent-consumed')).toHaveLength(1);
  });

  it('keeps Default after the human switches away from the tried agent and the chat remounts', async() => {
    const first = mountChat({ tabId: 'tab-default', handoffAgentId: TRIED });
    await flushPromises();
    first.selector().selectDefault();
    await flushPromises();
    expect(first.controller().thread.value.agentId ?? null).toBeNull();
    const threadId = first.controller().thread.value.id;
    unmountAll();

    // Restart before the tab list dropped the handoff: the saved thread still wins.
    const again = mountChat({ tabId: 'tab-default', handoffAgentId: TRIED });
    await flushPromises();
    expect(again.controller().thread.value.id).toBe(threadId);
    expect(again.controller().thread.value.agentId ?? null).toBeNull();
    expect(again.controller().model.value).toMatchObject({ id: '', name: 'Default' });
    expect(again.wrapper.emitted('handoff-agent-consumed')).toHaveLength(1);

    // And after the tab cleared it.
    unmountAll();
    const reopened = mountChat({ tabId: 'tab-default' });
    await flushPromises();
    expect(reopened.controller().thread.value.agentId ?? null).toBeNull();
  });

  it('keeps a plain model the human picked instead of the tried agent after remount', async() => {
    const first = mountChat({ tabId: 'tab-model', handoffAgentId: TRIED });
    await flushPromises();
    first.selector().selectModel(luna);
    await flushPromises();
    expect(first.controller().thread.value.agentId ?? null).toBeNull();
    unmountAll();

    const again = mountChat({ tabId: 'tab-model', handoffAgentId: TRIED });
    await flushPromises();
    expect(again.controller().thread.value.agentId ?? null).toBeNull();
    expect(again.controller().thread.value.providerId).toBe('codex');
    expect(again.controller().model.value.id).toBe('gpt-6-luna');
  });

  it('keeps the tried agent across a remount when the human did not change it', async() => {
    mountChat({ tabId: 'tab-kept', handoffAgentId: TRIED });
    await flushPromises();
    unmountAll();
    const again = mountChat({ tabId: 'tab-kept' });
    await flushPromises();
    expect(again.controller().thread.value.agentId).toBe(TRIED);
  });

  it('leaves the dedicated agent-tab path unchanged: initialAgentId still selects on a restored thread', async() => {
    const persister = new LocalStoragePersister();
    const saved = new ThreadRegistry(persister).create({ tabId: 'tab-agent' });
    saved.selectForChat({ id: '', name: 'Default', tier: 'hosted', ctx: '' }, null, null);
    persister.setTabThread('tab-agent', saved.thread.value.id);

    const { wrapper, controller } = mountChat({ tabId: 'tab-agent', initialAgentId: 'launched-agent' });
    await flushPromises();
    expect(controller().thread.value.id).toBe(saved.thread.value.id);
    expect(controller().thread.value.agentId).toBe('launched-agent');
    expect(wrapper.emitted('handoff-agent-consumed')).toBeUndefined();
  });
});
