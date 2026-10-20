/** @jest-environment node */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

import { awaitWithBudget } from '../awaitWithBudget';

describe('awaitWithBudget', () => {
  let warn: jest.SpiedFunction<typeof console.warn>;

  beforeEach(() => {
    jest.useFakeTimers();
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.useRealTimers();
    warn.mockRestore();
  });

  test('returns the value when the work settles inside the budget', async() => {
    const outcome = await awaitWithBudget('x', Promise.resolve(42), 1000);

    expect(outcome).toEqual({ timedOut: false, value: 42 });
    expect(warn).not.toHaveBeenCalled();
  });

  test('stops waiting when the work never settles, and says so once', async() => {
    const never = new Promise<number>(() => undefined);
    const pending = awaitWithBudget('Files runtime', never, 20_000);

    await jest.advanceTimersByTimeAsync(20_000);
    expect(await pending).toEqual({ timedOut: true });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('Files runtime');
  });

  test('a failure inside the budget is rethrown to the caller', async() => {
    await expect(awaitWithBudget('x', Promise.reject(new Error('boom')), 1000)).rejects.toThrow('boom');
  });

  test('a failure AFTER the budget is logged, not thrown or left unhandled', async() => {
    let rejectLate: (e: Error) => void = () => undefined;
    const late = new Promise<number>((_resolve, reject) => { rejectLate = reject; });
    const pending = awaitWithBudget('x', late, 1000);

    await jest.advanceTimersByTimeAsync(1000);
    expect(await pending).toEqual({ timedOut: true });
    rejectLate(new Error('late failure'));
    await jest.advanceTimersByTimeAsync(0);
    expect(warn.mock.calls.some((call: unknown[]) => String(call[0]).includes('failed after the startup budget'))).toBe(true);
  });

  test('work that finishes just before the budget wins and clears the timer', async() => {
    const work = new Promise<string>(resolve => setTimeout(() => resolve('done'), 500));
    const pending = awaitWithBudget('x', work, 1000);

    await jest.advanceTimersByTimeAsync(500);
    expect(await pending).toEqual({ timedOut: false, value: 'done' });
    expect(jest.getTimerCount()).toBe(0);
  });
});
