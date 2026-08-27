import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { postgresClient } from '../../PostgresClient';
import { DispatcherLivenessModel } from '../DispatcherLivenessModel';

describe('DispatcherLivenessModel', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('records a checking tick and carries forward a stale-check wedge', async() => {
    const queryOne = jest.spyOn(postgresClient, 'queryOne').mockResolvedValue({
      checking: true, consecutive_wedge_count: 1, wedge_count: 4,
    } as any);
    await DispatcherLivenessModel.beginTick(60_000);
    expect(queryOne.mock.calls[0][0]).toContain("last_outcome = 'checking'");
    expect(queryOne.mock.calls[0][0]).toContain('dispatcher_liveness.checking');
    expect(queryOne.mock.calls[0][1]).toEqual([60_000]);
  });

  it('completes a tick with an explicit outcome and clears the in-flight flag', async() => {
    const queryOne = jest.spyOn(postgresClient, 'queryOne').mockResolvedValue({
      checking: false, last_outcome: 'no-eligible-work',
    } as any);
    await DispatcherLivenessModel.completeTick(60_000, 'no-eligible-work');
    expect(queryOne.mock.calls[0][0]).toContain('checking = false');
    expect(queryOne.mock.calls[0][1]).toEqual([60_000, 'no-eligible-work']);
  });
});
