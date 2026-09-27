/** @jest-environment node */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const model = {
  findStaleExecutions: jest.fn((): Promise<any[]> => Promise.resolve([])),
  recover:             jest.fn((): Promise<any> => Promise.resolve(null)),
  findSuspended:       jest.fn((): Promise<any[]> => Promise.resolve([])),
  nextLeaseExpiry:     jest.fn((): Promise<Date | null> => Promise.resolve(null)),
};
const notifications = { create: jest.fn((_id: string, _options: unknown) => Promise.resolve()) };

jest.unstable_mockModule('../../database/models/WorkflowExecutionModel', () => ({ WorkflowExecutionModel: model }));
jest.unstable_mockModule('@pkg/main/chromeApi/ChromeApiService', () => ({ getChromeApi: () => ({ notifications }) }));
jest.unstable_mockModule('@pkg/utils/logging', () => ({
  default: { background: { log: jest.fn(), warn: jest.fn(), error: jest.fn() } },
}));

const pausedJobSearch = {
  attributes: {
    execution_id:  'wfp-1',
    workflow_id:   'jonathon-job-search',
    workflow_name: 'Jonathon Job Search',
    workflow_slug: 'jonathon-job-search',
    started_at:    new Date(),
    auto_restart:  false,
  },
};

describe('WorkflowRecoveryService', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it('re-checks an already-expired but unclaimable lease every 30s, not every second', async() => {
    const { recoverOnBoot } = await import('../WorkflowRecoveryService');
    model.nextLeaseExpiry.mockResolvedValue(new Date(Date.now() - 4 * 86_400_000));

    await recoverOnBoot();
    expect(model.findStaleExecutions).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(29_000);
    expect(model.findStaleExecutions).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(2_000);
    expect(model.findStaleExecutions).toHaveBeenCalledTimes(2);
  });

  it('tells the user once about a paused run that needs a manual decision', async() => {
    const { recoverOnBoot } = await import('../WorkflowRecoveryService');
    model.findSuspended.mockResolvedValue([pausedJobSearch]);
    model.nextLeaseExpiry.mockResolvedValue(null);

    await recoverOnBoot();
    await recoverOnBoot();
    await recoverOnBoot();

    expect(notifications.create).toHaveBeenCalledTimes(1);
    expect(notifications.create).toHaveBeenCalledWith('workflow-paused-wfp-1', expect.objectContaining({
      title: 'Routine paused: Jonathon Job Search',
    }));
  });
});
