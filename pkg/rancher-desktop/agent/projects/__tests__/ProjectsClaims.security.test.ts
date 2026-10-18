import { createHash } from 'node:crypto';

import { afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

import { claimTasks, recoverExpiredClaims, releaseClaims, renewClaims } from '../../../../../services/sulla-projects/src/claims';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const projectsRequest = jest.fn<(...args: any[]) => Promise<any>>();
const desktopDatabase = {
  query:    jest.fn<(...args: any[]) => Promise<any>>(),
  queryOne: jest.fn<(...args: any[]) => Promise<any>>(),
};

jest.unstable_mockModule('../application/ProjectsApiClient', () => ({
  ProjectsApiClient: class {
    request(...args: any[]): Promise<any> { return projectsRequest(...args) }
  },
}));
jest.unstable_mockModule('../../database/PostgresClient', () => ({ postgresClient: desktopDatabase }));

let WorkTaskOwnershipModel: typeof import('../../database/models/WorkTaskOwnershipModel').WorkTaskOwnershipModel;

beforeAll(async() => {
  ({ WorkTaskOwnershipModel } = await import('../../database/models/WorkTaskOwnershipModel'));
});

beforeEach(() => {
  projectsRequest.mockReset();
  desktopDatabase.query.mockReset();
  desktopDatabase.queryOne.mockReset();
});

afterEach(() => { jest.restoreAllMocks() });

describe('Projects task claim custody', () => {
  it('atomically hands a parent lease to a child and invalidates the parent lease', async() => {
    const parentToken = 'parent-secret-token';
    const query = jest.fn<any>()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // advisory lock
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // expired claim recovery
      .mockResolvedValueOnce({
        rows: [{
          task_id:          'task-1',
          owner_subject:    'desktop',
          external_ref:     'parent-job',
          lease_hash:       hash(parentToken),
          prior_assignee:   'original-human',
          claimed_assignee: 'parent-agent',
        }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [{ id: 'task-1', assignee: 'parent-agent' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ task_id: 'task-1' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 'task-1' }], rowCount: 1 });

    const result = await claimTasks({ query } as any, {
      tenantId:        'tenant',
      subject:         'desktop',
      externalRef:     'child-job',
      assignees:       { 'task-1': 'child-agent' },
      inheritedClaims: { 'task-1': parentToken },
    });

    expect(result.claimed).toBe(true);
    expect(result.leases[0].token).not.toBe(parentToken);
    expect(query.mock.calls[4][1]).toEqual([
      'tenant', 'child-agent', expect.any(String), 'task-1', 'desktop', 'child-job',
      hash(result.leases[0].token), 'parent-job', hash(parentToken),
    ]);
    expect(query.mock.calls[5][1]).toEqual(['task-1', 'child-agent', 'parent-agent']);

    const staleQuery = jest.fn<any>().mockResolvedValue({ rows: [], rowCount: 0 });
    await releaseClaims({ query: staleQuery } as any, {
      tenantId:    'tenant',
      subject:     'desktop',
      externalRef: 'parent-job',
      leases:      [{ taskId: 'task-1', token: parentToken }],
    });
    expect(staleQuery).toHaveBeenCalledTimes(1);
    await expect(renewClaims({ query: staleQuery } as any, {
      tenantId:    'tenant',
      subject:     'desktop',
      externalRef: 'parent-job',
      leases:      [{ taskId: 'task-1', token: parentToken }],
    })).rejects.toMatchObject({ publicCode: 'invalid_lease' });

    const childQuery = jest.fn<any>()
      .mockResolvedValueOnce({ rows: [{ prior_assignee: 'original-human', claimed_assignee: 'child-agent' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    await releaseClaims({ query: childQuery } as any, {
      tenantId:    'tenant',
      subject:     'desktop',
      externalRef: 'child-job',
      leases:      [{ taskId: 'task-1', token: result.leases[0].token }],
    });
    expect(childQuery.mock.calls[1][1]).toEqual(['task-1', 'original-human', 'child-agent']);
  });

  it('restores an expired claim only while the claimed agent still owns the task', async() => {
    const query = jest.fn<any>()
      .mockResolvedValueOnce({
        rows: [{ task_id: 'task-1', prior_assignee: 'original-human', claimed_assignee: 'agent' }], rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await expect(recoverExpiredClaims({ query } as any, 'tenant')).resolves.toBe(1);
    expect(query.mock.calls[1][1]).toEqual(['task-1', 'original-human', 'agent']);
    expect(query.mock.calls[1][0]).toContain('assignee IS NOT DISTINCT FROM $3');
  });

  it('clears rejected Desktop custody after the service expires a lease', async() => {
    const lease = { taskId: 'task-1', token: 'expired-token', expiresAt: '2026-10-18T17:00:00.000Z' };
    desktopDatabase.query.mockResolvedValue([{
      job_id: 'tab-job', project_task_ids: ['task-1'], project_task_prior_assignees: { 'task-1': lease },
    }]);
    desktopDatabase.queryOne.mockResolvedValueOnce({ job_id: 'tab-job' });
    projectsRequest.mockRejectedValue(new Error('Projects service rejected the request (invalid_lease)'));
    const interval = jest.spyOn(global, 'setInterval');

    await WorkTaskOwnershipModel.recoverRunningJobs();

    expect(desktopDatabase.queryOne.mock.calls[0][0]).toContain("project_task_ids = '{}'::text[]");
    expect(desktopDatabase.queryOne.mock.calls[0][0]).toContain('project_task_prior_assignees @> $2::jsonb');
    expect(desktopDatabase.queryOne.mock.calls[0][1]).toEqual([
      'tab-job', JSON.stringify({ 'task-1': { taskId: 'task-1', token: 'expired-token' } }), 1,
    ]);
    expect(interval).not.toHaveBeenCalled();
  });

  it('keeps local custody and retries after a transient Projects outage', async() => {
    const lease = { taskId: 'task-2', token: 'live-token', expiresAt: '2026-10-18T19:00:00.000Z' };
    desktopDatabase.query.mockResolvedValue([{
      job_id: 'recovering-tab-job', project_task_ids: ['task-2'],
      project_task_prior_assignees: { 'task-2': lease },
    }]);
    projectsRequest.mockRejectedValue(new Error('fetch failed'));
    const interval = jest.spyOn(global, 'setInterval').mockReturnValue({ unref: jest.fn() } as any);

    await WorkTaskOwnershipModel.recoverRunningJobs();

    expect(desktopDatabase.queryOne).not.toHaveBeenCalled();
    expect(interval).toHaveBeenCalledTimes(1);
  });

  it('clears stale local custody when persisted lease metadata is missing', async() => {
    desktopDatabase.query.mockResolvedValue([{
      job_id: 'broken-tab-job', project_task_ids: ['task-3'], project_task_prior_assignees: {},
    }]);
    desktopDatabase.queryOne.mockResolvedValueOnce({ job_id: 'broken-tab-job' });

    await WorkTaskOwnershipModel.recoverRunningJobs();

    expect(projectsRequest).not.toHaveBeenCalled();
    expect(desktopDatabase.queryOne.mock.calls[0][0]).toContain('project_task_ids = $2::text[]');
    expect(desktopDatabase.queryOne.mock.calls[0][0]).toContain('project_task_prior_assignees = $3::jsonb');
    expect(desktopDatabase.queryOne.mock.calls[0][1]).toEqual(['broken-tab-job', ['task-3'], '{}']);
  });
});
