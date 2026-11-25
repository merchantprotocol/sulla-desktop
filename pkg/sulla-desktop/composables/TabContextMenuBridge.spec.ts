// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';
import { createApp, h } from 'vue';

import { TabContextMenuBridge } from './TabContextMenuBridge';

describe('window tab context menu bridge', () => {
  it.each(['duplicate', 'attention:folded-chat'])('delivers %s once, only to the opener with two mounted headers', (action) => {
    const bridge = new TabContextMenuBridge();
    const ipc = new EventEmitter();
    const disconnect = bridge.connect(ipc);
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
    disconnect();
    expect(ipc.listenerCount('tab-context-menu:selected')).toBe(0);
  });

  it.each(['closeRight', 'closeOther'])('does not run %s if the fixed menu target has disappeared', (action) => {
    const bridge = new TabContextMenuBridge();
    const ipc = new EventEmitter();
    const disconnect = bridge.connect(ipc);
    const tabs = [{ id: 'left' }, { id: 'target' }, { id: 'right' }];
    const handle = vi.fn(() => tabs.splice(0));

    bridge.openForTab('menu', () => tabs.find(tab => tab.id === 'target'), handle, vi.fn());
    tabs.splice(1, 1);
    ipc.emit('tab-context-menu:selected', {}, 'menu', action);

    expect(handle).not.toHaveBeenCalled();
    expect(tabs.map(tab => tab.id)).toEqual(['left', 'right']);
    disconnect();
  });
});
