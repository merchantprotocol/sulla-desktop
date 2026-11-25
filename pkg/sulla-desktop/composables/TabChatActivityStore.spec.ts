// SPDX-License-Identifier: GPL-2.0-or-later

import { EventEmitter } from 'node:events';

import { describe, expect, it } from 'vitest';
import { computed, effectScope } from 'vue';

import { ChatActivityStore } from '@pkg/pages/chat/messages/chatActivityStore';

describe('window chat activity', () => {
  it('keeps the ring and attention state when the header is replaced without a new IPC event', () => {
    const ipc = new EventEmitter();
    const store = new ChatActivityStore();
    const disconnect = store.connect(new EventTarget(), ipc);
    const mountHeaderState = () => {
      const scope = effectScope();
      const state = scope.run(() => computed(() => store.read('hosted-chat')))!;

      return { state, unmount: () => scope.stop() };
    };
    const original = mountHeaderState();

    ipc.emit('internal-tab-view:chat-running', {}, 'hosted-chat', true, { state: 'you' });
    expect(original.state.value).toEqual({ working: true, snapshot: { state: 'you' } });
    original.unmount();

    const replacement = mountHeaderState();

    expect(ipc.listenerCount('internal-tab-view:chat-running')).toBe(1);
    expect(replacement.state.value).toEqual({ working: true, snapshot: { state: 'you' } });
    ipc.emit('internal-tab-view:chat-running', {}, 'hosted-chat', false);
    expect(replacement.state.value).toEqual({ working: false, snapshot: { state: 'you' } });
    replacement.unmount();
    disconnect();
    expect(ipc.listenerCount('internal-tab-view:chat-running')).toBe(0);
  });
});
