import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { postgresClient } from '../../PostgresClient';
import { WorkTaskDispatchModel } from '../WorkTaskDispatchModel';

describe('WorkTaskDispatchModel broad portfolio visibility', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('counts every in-review task without pre-filtering its context', async() => {
    const queryOne = jest.spyOn(postgresClient, 'queryOne').mockResolvedValue({ count: '4' } as any);

    await expect(WorkTaskDispatchModel.countReviewBacklog()).resolves.toBe(4);

    const [sql, params] = queryOne.mock.calls[0];
    expect(sql).toContain("t.status = 'in_review'");
    expect(sql).not.toContain('LOWER(t.assignee)');
    expect(sql).not.toContain('unnest(COALESCE(t.labels');
    expect(sql).not.toContain("d.status = 'running'");
    expect(params).toBeUndefined();
  });

  it('does not let downstream review hide a newer todo claim', async() => {
    const query = jest.fn(() => Promise.resolve({ rows: [] })) as any;
    jest.spyOn(postgresClient, 'transaction').mockImplementation((callback: any) => callback({ query }));

    await expect(WorkTaskDispatchModel.claimNext('sulla-desktop', 'runtime-1')).resolves.toBeNull();

    const sql = query.mock.calls[0][0];
    expect(sql).not.toContain('downstream.status');
    expect(sql).toContain('FOR UPDATE OF t SKIP LOCKED');
  });
});
