import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { WorkLaneDefinitionModel } from '../../models/WorkLaneDefinitionModel';
import { initialize } from '../WorkLaneDefinitionSeeder';

describe('WorkLaneDefinitionSeeder', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('ensures schema before reasserting defaults and legacy statuses', async() => {
    const ensure = jest.spyOn(WorkLaneDefinitionModel, 'ensureTable').mockResolvedValue();
    const seed = jest.spyOn(WorkLaneDefinitionModel, 'seedDefaultsAndLegacyStatuses')
      .mockResolvedValue({ defaults: 9, legacy: 2 });
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);

    await initialize();

    expect(ensure).toHaveBeenCalledTimes(1);
    expect(seed).toHaveBeenCalledTimes(1);
    expect(ensure.mock.invocationCallOrder[0]).toBeLessThan(seed.mock.invocationCallOrder[0]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('9 default and 2 legacy'));
  });
});
