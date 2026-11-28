// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';
import { WindowTabStripState } from './WindowTabStripState';

describe('window tab context menu bridge', () => {
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
