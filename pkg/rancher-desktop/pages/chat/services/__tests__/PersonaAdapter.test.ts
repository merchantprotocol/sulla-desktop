import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import { StreamUpdateScheduler } from '../StreamUpdateScheduler';

describe('PersonaAdapter stream scheduling', () => {
  beforeEach(() => { jest.useFakeTimers() });
  afterEach(() => { jest.useRealTimers() });

  it('publishes the leading update immediately and coalesces a burst', () => {
    const publish = jest.fn();
    const scheduler = new StreamUpdateScheduler(publish);

    scheduler.schedule();
    expect(publish).toHaveBeenCalledTimes(1);

    scheduler.schedule();
    scheduler.schedule();
    expect(publish).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(32);
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it('keeps publishing a continuous stream without animation frames', () => {
    const publish = jest.fn();
    const scheduler = new StreamUpdateScheduler(publish);

    scheduler.schedule();
    for (let i = 0; i < 4; i++) {
      scheduler.schedule();
      jest.advanceTimersByTime(32);
    }

    expect(publish).toHaveBeenCalledTimes(5);
  });

  it('flushes completion immediately and cancels the pending trailing sync', () => {
    const publish = jest.fn();
    const scheduler = new StreamUpdateScheduler(publish);

    scheduler.schedule();
    scheduler.schedule();
    scheduler.flush();

    expect(publish).toHaveBeenCalledTimes(2);
    jest.advanceTimersByTime(64);
    expect(publish).toHaveBeenCalledTimes(2);
  });
});
