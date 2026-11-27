// SPDX-License-Identifier: GPL-2.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    id, anchor: { x: 20, y: 45, aboveY: 5 }, palette: {}, title: 'Tab', status: 'Idle', detail: '',
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
