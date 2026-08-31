import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { postgresClient } from '../../PostgresClient';
import { WorkTaskDispatchModel } from '../WorkTaskDispatchModel';

describe('WorkTaskDispatchModel downstream-first backpressure', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('counts autonomous in-review work whether or not a verifier already holds it', async() => {
    const queryOne = jest.spyOn(postgresClient, 'queryOne').mockResolvedValue({ count: '4' } as any);

    await expect(WorkTaskDispatchModel.countReviewBacklog()).resolves.toBe(4);

    const [sql, params] = queryOne.mock.calls[0];
    expect(sql).toContain("t.status = 'in_review'");
    expect(sql).toContain("LOWER(t.assignee) IN ('heartbeat', 'dispatcher', 'verifier')");
    expect(sql).toContain("FROM unnest(COALESCE(t.labels, '{}')) AS label");
    expect(sql).not.toContain("d.status = 'running'");
    expect(params).toEqual([
      ['done', 'cancelled', 'parked', 'blocked'],
      ['gated', 'decision', 'human', 'manual', 'no-auto-dispatch'],
    ]);
  });

  it('makes the todo claim itself reject races with downstream review work', async() => {
    const query = jest.fn(() => Promise.resolve({ rows: [] })) as any;
    jest.spyOn(postgresClient, 'transaction').mockImplementation((callback: any) => callback({ query }));

    await expect(WorkTaskDispatchModel.claimNext('sulla-desktop', 'runtime-1')).resolves.toBeNull();

    const sql = query.mock.calls[0][0];
    expect(sql).toContain("downstream.status = 'in_review'");
    expect(sql).toContain("LOWER(downstream.assignee) IN ('heartbeat', 'dispatcher', 'verifier')");
    expect(sql).toContain("LOWER(downstream_label) = ANY($3::text[])");
    expect(sql.indexOf("downstream.status = 'in_review'"))
      .toBeLessThan(sql.indexOf('FOR UPDATE OF t SKIP LOCKED'));
  });
});
