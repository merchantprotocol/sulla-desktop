import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const claimDueMock: any = jest.fn();
const observeMock: any = jest.fn();
const summaryMock: any = jest.fn();
const addCommentMock: any = jest.fn();
const updateTaskMock: any = jest.fn();
const settingsGetMock: any = jest.fn();
const postgresQueryMock: any = jest.fn();

jest.unstable_mockModule('../../database/models/WorkTaskWaitModel', () => ({
  WorkTaskWaitModel: {
    claimDue: claimDueMock,
    observe:  observeMock,
    summary:  summaryMock,
  },
}));

jest.unstable_mockModule('../../database/models/WorkItemsModel', () => ({
  WorkItemsModel: { addComment: addCommentMock, updateTask: updateTaskMock },
}));

jest.unstable_mockModule('../../database/models/SullaSettingsModel', () => ({
  SullaSettingsModel: { get: settingsGetMock, set: jest.fn() },
}));

jest.unstable_mockModule('../../database/PostgresClient', () => ({
  postgresClient: { query: postgresQueryMock },
}));

jest.unstable_mockModule('../IntegrationService', () => ({
  getIntegrationService: () => ({ getIntegrationValue: jest.fn() }),
}));

jest.unstable_mockModule('../HeartbeatService', () => ({
  isInsideWindow: () => true,
}));

describe('ExternalWaitMonitorService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    settingsGetMock.mockImplementation((key: string, fallback: unknown) =>
      Promise.resolve(key === 'externalWaitMonitorEnabled' ? true : fallback),
    );
    summaryMock.mockResolvedValue({ active: 0, oldest: null, unchanged: 0, failures: 0 });
    addCommentMock.mockResolvedValue(undefined);
    postgresQueryMock.mockResolvedValue([]);
  });

  it('suppresses repeated pending fingerprints and emits one pending-to-success delta', async() => {
    const wait: any = {
      id:                          'wait-1',
      task_id:                     'task-1',
      wait_kind:                   'github_checks',
      target_key:                  'org/repo#1',
      target:                      { owner: 'org', repo: 'repo', pullNumber: 1 },
      last_observed_fingerprint:   null,
      consecutive_unchanged_count: 0,
      consecutive_failure_count:   0,
      status:                      'active',
    };
    claimDueMock.mockImplementation(() => Promise.resolve(wait.status === 'active' ? [{ ...wait }] : []));
    observeMock.mockImplementation((_id: string, observation: any) => {
      const first = !wait.last_observed_fingerprint;
      const changed = !first && wait.last_observed_fingerprint !== observation.fingerprint;
      const terminal = observation.outcome !== 'pending';
      wait.last_observed_fingerprint = observation.fingerprint;
      if (terminal) wait.status = observation.outcome;
      else if (changed) wait.status = 'changed';
      else wait.consecutive_unchanged_count += 1;
      return Promise.resolve({ changed: changed || terminal, wait: { ...wait } });
    });

    const pending = {
      fingerprint: 'pending-a', outcome: 'pending', summary: '1 pending', nextCheckAt: new Date(),
    };
    const polls = [
      ...Array.from({ length: 10 }, () => ({ ...pending })),
      { fingerprint: 'success-a', outcome: 'satisfied', summary: '1 success', nextCheckAt: new Date() },
    ] as any[];
    const poller: any = jest.fn(() => Promise.resolve(polls.shift()));
    const { ExternalWaitMonitorService } = await import('../ExternalWaitMonitorService');
    const service = new ExternalWaitMonitorService(poller);

    for (let i = 0; i < 11; i++) await service.forceCheck();

    expect(poller).toHaveBeenCalledTimes(11);
    expect(addCommentMock).toHaveBeenCalledTimes(1);
    expect(addCommentMock.mock.calls[0][0].body).toContain('External wait satisfied: 1 success');
    expect(updateTaskMock).toHaveBeenCalledWith('task-1', {
      status: 'in_review', assignee: 'heartbeat', actor: 'external-wait-monitor',
    });
    const metrics = await service.getMetrics();
    expect(metrics.unchangedSuppressions).toBe(10);
    expect(metrics.deltasEmitted).toBe(1);
  });
});
