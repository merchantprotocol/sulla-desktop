// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { mount } from '@vue/test-utils';
import { expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick, provide, ref } from 'vue';

const ipc = vi.hoisted(() => ({ invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() }));
vi.mock('@pkg/utils/ipcRenderer', () => ({ ipcRenderer: ipc }));

import { AgentModelSelectorController } from '@pkg/pages/agent/AgentModelSelectorController';
import { useSelectionLabel } from '@pkg/pages/chat/composables/useSelectionLabel';
import { ChatControllerKey, ModelSelectorKey } from '@pkg/pages/chat/controller/useChatController';

const defaults = (agentId: string) => ({
  defaults: { chat: { kind: 'agent', agentId } },
  agents: [
    { slug: 'account-manager', name: 'Product Owner' },
    { slug: 'sulla', name: 'Sulla' },
  ],
});

it('displays the saved agent on an unpinned chat and updates when Preferences changes', async() => {
  ipc.invoke.mockImplementation(async(channel: string) => {
    if (channel === 'model-defaults:get') return defaults('account-manager');
    return {};
  });
  const onSelectForChat = vi.fn();
  const selector = new AgentModelSelectorController({
    systemReady: ref(true), loading: ref(false), isRunning: ref(false),
    modelName: ref(''), modelMode: ref('remote'), onSelectForChat,
  });
  const thread = ref({ agentId: null, providerId: null as string | null });
  const model = ref({ id: '', name: 'Default' });
  const Label = defineComponent({
    setup() {
      const { label, title } = useSelectionLabel();
      return () => h('button', { title: title.value }, label.value);
    },
  });
  const root = mount(defineComponent({
    setup() {
      provide(ChatControllerKey, { thread, model } as any);
      provide(ModelSelectorKey, selector);
      return () => h(Label);
    },
  }));

  try {
    await selector.start();
    await nextTick();
    expect(root.text()).toBe('Product Owner');
    expect(root.get('button').attributes('title')).toContain('New chat default');
    expect(thread.value).toEqual({ agentId: null, providerId: null });

    const broadcast = ipc.on.mock.calls.find(([channel]) => channel === 'model-defaults:changed')?.[1];
    expect(broadcast).toBeTypeOf('function');
    broadcast({}, defaults('sulla'));
    await nextTick();
    expect(root.text()).toBe('Sulla');

    thread.value.providerId = 'codex';
    model.value = { id: 'gpt-6.2-sol', name: 'GPT-6.2 Sol' };
    broadcast({}, defaults('account-manager'));
    await nextTick();
    expect(root.text()).toBe('GPT-6.2 Sol');
    expect(onSelectForChat).not.toHaveBeenCalled();
  } finally {
    selector.dispose();
    root.unmount();
  }
});
