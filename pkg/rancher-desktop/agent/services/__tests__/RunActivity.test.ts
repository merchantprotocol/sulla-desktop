import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import { SullaSettingsModel } from '../../database/models/SullaSettingsModel';
import { DEAD_RUN_CHECK_MS, RunActivity, watchForDeadRun } from '../RunActivity';

describe('RunActivity dead-run detection', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(SullaSettingsModel, 'get').mockImplementation(async(key, fallback) =>
      key === 'taskDispatcherDeadRunMinutes' ? 30 : fallback);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  const tick = async(ms: number) => {
    await jest.advanceTimersByTimeAsync(ms);
  };

  it('fires once after the whole tree is silent past the threshold', async() => {
    const onDead = jest.fn<(reason: string) => void>();
    const stop = watchForDeadRun('dispatch-1', onDead);
    await tick(29 * 60_000);
    expect(onDead).not.toHaveBeenCalled();
    await tick(2 * DEAD_RUN_CHECK_MS);
    expect(onDead).toHaveBeenCalledTimes(1);
    expect(onDead).toHaveBeenCalledWith('no agent activity for 30 minute(s)');
    await tick(10 * DEAD_RUN_CHECK_MS);
    expect(onDead).toHaveBeenCalledTimes(1);
    stop();
  });

  it('treats activity from an inheriting sub-agent as activity for the run', async() => {
    const onDead = jest.fn<(reason: string) => void>();
    const stop = watchForDeadRun('dispatch-2', onDead);
    const child = { activityKeys: RunActivity.inherit({ activityKeys: ['dispatch-2'] }, 'job-9') };
    expect(child.activityKeys).toEqual(['dispatch-2', 'job-9']);
    for (let minute = 0; minute < 60; minute += 10) {
      await tick(10 * 60_000);
      RunActivity.touch(child);
    }
    expect(onDead).not.toHaveBeenCalled();
    stop();
  });

  it('keeps a quiet run whose workflow lease is still renewing', async() => {
    const onDead = jest.fn<(reason: string) => void>();
    const stop = watchForDeadRun('dispatch-3', onDead, async() => true);
    await tick(45 * 60_000);
    expect(onDead).not.toHaveBeenCalled();
    stop();
  });

  it('stops watching and forgets the clock when stopped', async() => {
    const onDead = jest.fn<(reason: string) => void>();
    const stop = watchForDeadRun('dispatch-4', onDead);
    stop();
    expect(RunActivity.lastActivityAt('dispatch-4')).toBeUndefined();
    await tick(60 * 60_000);
    expect(onDead).not.toHaveBeenCalled();
  });
});
