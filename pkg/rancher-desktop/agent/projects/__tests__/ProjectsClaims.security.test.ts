import { createHash } from 'node:crypto';

import { describe, expect, it, jest } from '@jest/globals';

import { claimTasks, recoverExpiredClaims, releaseClaims, renewClaims } from '../../../../../services/sulla-projects/src/claims';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

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
});
