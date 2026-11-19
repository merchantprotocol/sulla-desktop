// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.
// @vitest-environment jsdom

import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';

const f = vi.hoisted(() => ({
  controller: null as any,
  selector:   null as any,
}));

vi.mock('@pkg/pages/chat/controller/useChatController', () => ({
  useChatController: () => f.controller,
  useModelSelector:  () => f.selector,
}));

import ModelSwitcherModal from '@pkg/pages/chat/components/chrome/ModelSwitcherModal.vue';

describe('model switcher availability refresh', () => {
  beforeEach(() => {
    f.controller = {
      modals: ref({ which: '' }),
      thread: ref({ runLocation: 'container' }),
      closeModal: vi.fn(),
    };
    f.selector = {
      providerGroups: ref([{
        providerId: 'grok', providerName: 'Grok', accessLabel: 'API · separate billing', isActiveProvider: true, loading: false,
        models: [{ providerId: 'grok', providerName: 'Grok', providerAccessLabel: 'API · separate billing', modelId: 'grok-4.6', modelLabel: 'Grok 4.6', selectionMode: 'exact', isActiveProvider: true, isActiveModel: true }],
      }]),
      agentOptions: ref([]),
      activeAgentId: ref(null),
      loadingProvidersValue: false,
      refresh: vi.fn(async() => undefined),
      refreshAgents: vi.fn(async() => undefined),
      selectModel: vi.fn(),
      selectAgent: vi.fn(),
    };
  });

  afterEach(() => { document.body.innerHTML = '' });

  it('labels the auto sentinel, a CLI family alias, and an exact id distinctly', async() => {
    const model = (modelId: string, modelLabel: string, selectionMode: string) => ({
      providerId: 'claude-code', providerName: 'Claude Code', providerAccessLabel: 'Subscription · CLI', modelId, modelLabel, selectionMode, isActiveProvider: false, isActiveModel: false,
    });
    f.selector.providerGroups.value = [{
      providerId: 'claude-code', providerName: 'Claude Code', accessLabel: 'Subscription · CLI', isActiveProvider: false, loading: false,
      models: [model('claude-code', 'Auto (Claude picks)', 'automatic'), model('opus', 'Opus 5.5 (CLI alias)', 'alias'), model('claude-opus-5-5', 'Opus 5.5', 'exact')],
    }];
    const wrapper = mount(ModelSwitcherModal, { attachTo: document.body });
    f.controller.modals.value.which = 'model';
    await nextTick();
    const modes = wrapper.findAll('.model-mode').map(node => node.text());
    expect(modes).toEqual(['Automatic · provider default', 'Automatic version · opus', 'Exact ID · claude-opus-5-5']);
    wrapper.unmount();
  });

  it('refreshes provider availability on every open even when cached groups are nonempty', async() => {
    const wrapper = mount(ModelSwitcherModal, { attachTo: document.body });
    f.controller.modals.value.which = 'model';
    await nextTick();
    expect(f.selector.refresh).toHaveBeenCalledTimes(1);
    expect(wrapper.text()).toContain('API · separate billing');

    f.controller.modals.value.which = '';
    await nextTick();
    f.controller.modals.value.which = 'model';
    await nextTick();
    expect(f.selector.refresh).toHaveBeenCalledTimes(2);
    expect(f.selector.refreshAgents).not.toHaveBeenCalled();
    wrapper.unmount();
  });
});
