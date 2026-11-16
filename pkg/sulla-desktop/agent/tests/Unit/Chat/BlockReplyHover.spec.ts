// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.
// @vitest-environment jsdom

import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { computed, nextTick, ref } from 'vue';

import TurnSulla from '@pkg/pages/chat/components/transcript/TurnSulla.vue';
import { ChatControllerKey } from '@pkg/pages/chat/controller/useChatController';

vi.mock('@pkg/utils/ipcRenderer', () => ({ ipcRenderer: { invoke: vi.fn(), send: vi.fn(), on: vi.fn(), removeListener: vi.fn() } }));

function mountTurn() {
  const controller = { thread: computed(() => ({ id: 't1' })), regenerate: vi.fn(), togglePin: vi.fn(), messages: ref([]) };
  return mount(TurnSulla, {
    attachTo: document.body,
    props:    { msg: { id: 'm1', kind: 'sulla', role: 'assistant', text: 'Draft Slack DM to MJ for your approval.', createdAt: Date.now() } as any },
    global:   { provide: { [ChatControllerKey as symbol]: controller } },
  });
}

afterEach(() => { vi.useRealTimers(); document.body.innerHTML = '' });

describe('replying to one block of a Sulla message', () => {
  // risk: the Reply button sits outside the message, so moving the pointer
  // towards it left the message first and the button vanished before it
  // could be clicked
  it('keeps the Reply button while the pointer travels to it, and lets it be clicked', async() => {
    vi.useFakeTimers();
    const replies: { threadId: string }[] = [];
    window.addEventListener('chat:reply', e => replies.push((e as CustomEvent).detail));
    const turn = mountTurn();

    await turn.find('.chat-body p').trigger('mousemove');
    expect(turn.find('.block-reply').exists()).toBe(true);

    await turn.find('.chat-turn').trigger('mouseleave');
    vi.advanceTimersByTime(150);
    await nextTick();
    expect(turn.find('.block-reply').exists()).toBe(true);

    await turn.find('.block-reply').trigger('mouseenter');
    vi.advanceTimersByTime(2000);
    await nextTick();
    await turn.find('.block-reply').trigger('click');

    expect(replies).toHaveLength(1);
    expect(replies[0].threadId).toBe('t1');
    expect(turn.find('.block-reply').exists()).toBe(false);
    turn.unmount();
  });

  it('still hides the Reply button once the pointer has really moved away', async() => {
    vi.useFakeTimers();
    const turn = mountTurn();

    await turn.find('.chat-body p').trigger('mousemove');
    await turn.find('.chat-turn').trigger('mouseleave');
    vi.advanceTimersByTime(1000);
    await nextTick();

    expect(turn.find('.block-reply').exists()).toBe(false);
    turn.unmount();
  });
});
