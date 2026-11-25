// SPDX-License-Identifier: GPL-2.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TabAttentionMenuOwner } from './TabAttentionMenuOwner';
import { TabHoverController } from './TabHoverController';

describe('TabHoverController', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const create = () => {
    const show = vi.fn();
    const hide = vi.fn();
    const clock = {
      setTimeout:   (callback: () => void, delay: number) => Number(setTimeout(callback, delay)),
      clearTimeout: (id: number) => clearTimeout(id),
    };
    return { show, hide, hover: new TabHoverController(clock, show, hide) };
  };
  const request = (id: string) => ({
    id, anchor: { x: 20, y: 45 }, palette: {}, title: 'Tab', status: 'Idle', detail: '',
  });

  it('does not show a parked or detached anchor whose visibility changed during the delay', () => {
    const { show, hover } = create();
    let visible = true;
    hover.schedule(() => visible ? request('first') : undefined);
    vi.advanceTimersByTime(349);
    expect(show).not.toHaveBeenCalled();

    visible = false;
    vi.advanceTimersByTime(1);
    expect(show).not.toHaveBeenCalled();
  });

  it('replaces pending hovers and releases only its own visible request on cancellation', () => {
    const { hover, show, hide } = create();
    hover.schedule(() => request('first'));
    vi.advanceTimersByTime(250);
    hover.schedule(() => request('second'));
    vi.advanceTimersByTime(349);
    expect(show).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(show).toHaveBeenCalledExactlyOnceWith(request('second'));

    hover.cancel();
    hover.cancel();
    expect(hide).toHaveBeenCalledExactlyOnceWith('second');
    hover.schedule(() => request('third'));
    hover.cancel();
    vi.advanceTimersByTime(350);
    expect(show).toHaveBeenCalledTimes(1);
  });
});

describe('TabAttentionMenuOwner', () => {
  it('delivers selections to the current opener and ignores replies for a replaced header', () => {
    const owner = new TabAttentionMenuOwner();
    const first = { id: 'old-header', select: vi.fn(), onClosed: vi.fn() };
    const current = { id: 'visible-header', select: vi.fn(), onClosed: vi.fn() };

    owner.open(first);
    owner.open(current);
    owner.close(first.id);
    owner.select(first.id, 'stale-tab');
    owner.select(current.id, 'folded-chat');

    expect(first.onClosed).toHaveBeenCalledOnce();
    expect(first.select).not.toHaveBeenCalled();
    expect(current.select).toHaveBeenCalledExactlyOnceWith('folded-chat');
    owner.close(current.id);
    owner.select(current.id, 'closed-menu');
    expect(current.select).toHaveBeenCalledOnce();
    expect(current.onClosed).toHaveBeenCalledOnce();
  });
});
