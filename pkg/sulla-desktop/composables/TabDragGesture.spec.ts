// SPDX-License-Identifier: GPL-2.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TabDragAutoScroll } from './TabDragAutoScroll';
import { TabDragClickSuppression } from './TabDragClickSuppression';

describe('tab pointer gesture cleanup', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const setup = () => {
    const events = new EventTarget();
    const anchor = new EventTarget();
    const other = new EventTarget();
    const suppress = new TabDragClickSuppression({
      addEventListener:    events.addEventListener.bind(events),
      removeEventListener: (type: string, callback: EventListener, options?: EventListenerOptions | boolean) =>
        events.removeEventListener(type, callback, typeof options === 'boolean' ? { capture: options } : options),
      setTimeout:   (callback: () => void, delay: number) => Number(setTimeout(callback, delay)),
      clearTimeout: (id: number) => clearTimeout(id),
    } as unknown as Window);
    const dispatch = (type: string, target = anchor, pointerId = 7, detail = 1) => {
      const event = new Event(type, { cancelable: true });
      Object.defineProperties(event, {
        pointerId:    { value: pointerId },
        detail:       { value: detail },
        button:       { value: 0 },
        composedPath: { value: () => [target, events] },
      });
      events.dispatchEvent(event);
      return event.defaultPrevented;
    };
    return { anchor, other, suppress, dispatch };
  };

  it('blocks only the original drag click, once, not a keyboard click, another tab or another pointer', () => {
    const { anchor, other, suppress, dispatch } = setup();
    suppress.arm(anchor, 7);
    expect(dispatch('click', other)).toBe(false);
    expect(dispatch('click', anchor, 8)).toBe(false);
    expect(dispatch('click', anchor, 7, 0)).toBe(false);
    expect(dispatch('click')).toBe(true);
    expect(dispatch('click')).toBe(false);
  });

  it('disarms on the next pointerdown and expires even if no drag click arrived', () => {
    const { anchor, other, suppress, dispatch } = setup();
    suppress.arm(anchor, 7);
    dispatch('pointerdown', other);
    expect(dispatch('click')).toBe(false);

    suppress.arm(anchor, 7);
    vi.advanceTimersByTime(300);
    expect(dispatch('click')).toBe(false);
  });

  it('starts the Escape cancellation window at release and clears it on pointer cancellation', () => {
    const { anchor, suppress, dispatch } = setup();
    suppress.arm(anchor, 7, true);
    vi.advanceTimersByTime(1500);
    expect(dispatch('click')).toBe(false);
    dispatch('pointerup');
    expect(dispatch('click')).toBe(true);

    suppress.arm(anchor, 7, true);
    dispatch('pointercancel');
    dispatch('pointerup');
    expect(dispatch('click')).toBe(false);
  });

  it('continues edge steps without pointer moves and stops the pending frame on drop or cancellation', () => {
    const scroll = new TabDragAutoScroll({
      requestAnimationFrame: callback => Number(setTimeout(() => callback(Date.now()), 16)),
      cancelAnimationFrame:  id => clearTimeout(id),
    });
    const step = vi.fn(() => true);
    scroll.start(step);
    scroll.start(step);
    vi.advanceTimersByTime(48);
    expect(step).toHaveBeenCalledTimes(3);
    scroll.stop();
    vi.advanceTimersByTime(160);
    expect(step).toHaveBeenCalledTimes(3);

    const endOfStrip = vi.fn(() => false);
    scroll.start(endOfStrip);
    vi.advanceTimersByTime(160);
    expect(endOfStrip).toHaveBeenCalledOnce();
  });
});
