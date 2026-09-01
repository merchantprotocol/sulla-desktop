import { describe, expect, it, jest } from '@jest/globals';

import { createDbBootGate } from '../dbBootGate';

describe('createDbBootGate', () => {
  const noSleep = () => Promise.resolve();

  it('resolves immediately when the database is already up', async() => {
    const initialize = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const gate = createDbBootGate(initialize, 1, noSleep);

    await gate();
    expect(initialize).toHaveBeenCalledTimes(1);
  });

  it('retries until initialize succeeds instead of failing once', async() => {
    const initialize = jest.fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('connect ECONNREFUSED 127.0.0.1:30116'))
      .mockRejectedValueOnce(new Error('connect ECONNREFUSED 127.0.0.1:30116'))
      .mockResolvedValue(undefined);
    const gate = createDbBootGate(initialize, 1, noSleep);

    await gate();
    expect(initialize).toHaveBeenCalledTimes(3);
  });

  it('keeps retrying well past any finite boot budget', async() => {
    let calls = 0;
    const initialize = jest.fn<() => Promise<void>>().mockImplementation(() => {
      calls++;

      return calls < 100 ? Promise.reject(new Error('ECONNREFUSED')) : Promise.resolve();
    });
    const gate = createDbBootGate(initialize, 1, noSleep);

    await gate();
    expect(initialize).toHaveBeenCalledTimes(100);
  });

  it('is single-flight: concurrent and later callers share one initialization', async() => {
    let resolveInit: () => void = () => {};
    const initialize = jest.fn<() => Promise<void>>().mockImplementation(() => new Promise<void>(resolve => {
      resolveInit = resolve;
    }));
    const gate = createDbBootGate(initialize, 1, noSleep);

    const first = gate();
    const second = gate();

    resolveInit();
    await Promise.all([first, second]);
    await gate();
    expect(initialize).toHaveBeenCalledTimes(1);
  });

  it('waits retryMs between attempts', async() => {
    const sleeps: number[] = [];
    const sleep = (ms: number) => {
      sleeps.push(ms);

      return Promise.resolve();
    };
    const initialize = jest.fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValue(undefined);
    const gate = createDbBootGate(initialize, 5_000, sleep);

    await gate();
    expect(sleeps).toEqual([5_000]);
  });
});
