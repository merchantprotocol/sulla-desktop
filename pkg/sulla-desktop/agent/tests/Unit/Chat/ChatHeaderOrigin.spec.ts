// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.
// @vitest-environment jsdom

import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';

import ChatHeader from '@pkg/pages/chat/components/chrome/ChatHeader.vue';
import { ChatControllerKey } from '@pkg/pages/chat/controller/useChatController';

const controller = { thread: ref({ title: 'Fix · #4350 round 2' }), sidebar: ref({ historyOpen: false }), toggleHistory: vi.fn(), renameThread: vi.fn() };
const props = { subAgents: { total: 0, live: 0 }, subAgentsOpen: false, filesOpen: false, dockSide: true };

describe('an agent\'s own chat tab', () => {
  // risk: the "Launched by" chip floated over the header buttons once the side dock narrowed the chat
  it('shows who launched it in the header\'s own left column, with a way back', async() => {
    const back = vi.fn();
    const header = mount(ChatHeader, { props, global: { provide: { [ChatControllerKey as symbol]: controller, 'chat:agent-origin': ref({ name: 'account-manager', back }) } } });

    const chip = header.find('.ch-left .ch-origin');
    expect(chip.text()).toContain('Launched by account-manager');
    await chip.trigger('click');
    expect(back).toHaveBeenCalled();
  });

  it('shows nothing there for an ordinary chat', () => {
    const header = mount(ChatHeader, { props, global: { provide: { [ChatControllerKey as symbol]: controller } } });
    expect(header.find('.ch-origin').exists()).toBe(false);
  });
});
