// SPDX-License-Identifier: GPL-2.0-or-later

import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { TabGroupPopoverBridge } from './TabGroupPopoverBridge';
import type { TabGroupPopoverRequest } from '@pkg/shared/TabStripPopup';

describe('tab group popover bridge', () => {
  it('ignores stale edits and releases listeners when the shell is disposed', () => {
    // risk: permissions — replies from a replaced group editor must not mutate the current group.
    const ipc = Object.assign(new EventEmitter(), { send: vi.fn() });
    const bridge = new TabGroupPopoverBridge(ipc);
    const request: TabGroupPopoverRequest = {
      requestId: 'first', groupId: 'group-1', name: '', colorToken: 'blue', focus: 'name',
      anchor: { x: 1, y: 2, aboveY: 0 }, palette: {},
      swatches: [
        { token: 'grey', label: 'Grey', color: '#345678' },
        { token: 'blue', label: 'Blue', color: '#345678' },
        { token: 'cyan', label: 'Cyan', color: '#345678' },
        { token: 'green', label: 'Green', color: '#345678' },
        { token: 'gold', label: 'Gold', color: '#345678' },
        { token: 'orange', label: 'Orange', color: '#345678' },
        { token: 'pink', label: 'Pink', color: '#345678' },
        { token: 'purple', label: 'Purple', color: '#345678' },
      ],
    };
    const firstChange = vi.fn();
    const firstClose = vi.fn();
    const secondChange = vi.fn();
    const secondClose = vi.fn();

    bridge.open(request, firstChange, firstClose);
    bridge.open({ ...request, requestId: 'second' }, secondChange, secondClose);
    ipc.emit('tab-group-popover:changed', {}, 'first', { name: 'stale' });
    ipc.emit('tab-group-popover:changed', {}, 'second', { name: 'current' });
    expect(firstChange).not.toHaveBeenCalled();
    expect(firstClose).toHaveBeenCalledOnce();
    expect(secondChange).toHaveBeenCalledExactlyOnceWith({ name: 'current' });

    bridge.dispose();
    expect(secondClose).toHaveBeenCalledOnce();
    expect(ipc.listenerCount('tab-group-popover:changed')).toBe(0);
    expect(ipc.listenerCount('tab-group-popover:closed')).toBe(0);
    expect(ipc.send).toHaveBeenCalledWith('tab-group-popover:hide', 'second');
  });
});
