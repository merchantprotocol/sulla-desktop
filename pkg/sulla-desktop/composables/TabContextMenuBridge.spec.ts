// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';
import { createApp, h } from 'vue';

import { WindowTabStripState } from './WindowTabStripState';

describe('window tab context menu bridge', () => {
  it.each(['duplicate', 'attention:folded-chat'])('delivers %s once, only to the opener with two mounted headers', (action) => {
    const ipc = new EventEmitter();
    const bridge = new WindowTabStripState(window, ipc);

    bridge.connect();
    bridge.connect();
    const mountHeader = (id: string) => {
      const select = vi.fn();
      const onClosed = vi.fn();
      const app = createApp({
        setup: () => () => h('button', { onClick: () => bridge.open({ id, select, onClosed }) }),
      });
      const root = document.createElement('div');

      app.mount(root);
      return { open: () => root.querySelector('button')!.click(), select, onClosed, unmount: () => app.unmount() };
    };
    const parked = mountHeader('previous');
    const current = mountHeader('current');

    parked.open();
    current.open();
    expect(ipc.listenerCount('tab-context-menu:selected')).toBe(1);
    ipc.emit('tab-context-menu:closed', {}, 'previous');
    ipc.emit('tab-context-menu:selected', {}, 'previous', action);
    ipc.emit('tab-context-menu:selected', {}, 'current', action);
    ipc.emit('tab-context-menu:selected', {}, 'current', action);

    expect(parked.select).not.toHaveBeenCalled();
    expect(current.select).toHaveBeenCalledExactlyOnceWith(action);
    expect(parked.onClosed).toHaveBeenCalledOnce();
    expect(current.onClosed).toHaveBeenCalledOnce();
    parked.unmount();
    current.unmount();
    bridge.dispose();
    expect(ipc.listenerCount('tab-context-menu:selected')).toBe(0);
    expect(ipc.listenerCount('internal-tab-view:chat-running')).toBe(0);
    expect(ipc.listenerCount('tab-context-menu:closed')).toBe(0);
  });

  it('scopes activity and requests to each shell and releases both on disposal', () => {
    const events = new EventTarget();
    const firstIpc = new EventEmitter();
    const otherIpc = new EventEmitter();
    const first = new WindowTabStripState(events, firstIpc);
    const other = new WindowTabStripState(new EventTarget(), otherIpc);
    const selectFirst = vi.fn();
    const selectOther = vi.fn();
    const closeFirst = vi.fn();

    first.connect();
    other.connect();
    first.setActiveGroup('browser');
    expect(first.activeGroup.value).toBe('browser');
    expect(other.activeGroup.value).toBe('chats');
    first.open({ id: 'menu', select: selectFirst, onClosed: closeFirst });
    other.open({ id: 'menu', select: selectOther, onClosed: vi.fn() });
    firstIpc.emit('internal-tab-view:chat-running', {}, 'chat', false, { state: 'you' });
    events.dispatchEvent(new CustomEvent('sulla:chat-running', { detail: { tabId: 'chat', running: true } }));
    expect(first.readActivity('chat')).toEqual({ working: true, snapshot: { state: 'you' } });
    expect(other.readActivity('chat')).toEqual({ working: false, snapshot: undefined });

    first.dispose();
    expect(closeFirst).toHaveBeenCalledOnce();
    events.dispatchEvent(new CustomEvent('sulla:chat-running', { detail: { tabId: 'chat', running: true } }));
    expect(first.readActivity('chat')).toEqual({ working: false, snapshot: undefined });
    firstIpc.emit('tab-context-menu:selected', {}, 'menu', 'close');
    otherIpc.emit('tab-context-menu:selected', {}, 'menu', 'pin');
    expect(selectFirst).not.toHaveBeenCalled();
    expect(selectOther).toHaveBeenCalledExactlyOnceWith('pin');
    other.dispose();
  });
});
