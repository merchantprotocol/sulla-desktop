import { beforeEach, afterEach, describe, expect, it, jest } from '@jest/globals';

import { SullaSettingsModel } from '../SullaSettingsModel';
import { postgresClient } from '../../PostgresClient';
import { WorkTaskDispatchModel } from '../WorkTaskDispatchModel';

function admissionClient(query: any): any {
  return { query: (sql: string, ...args: any[]) => sql.includes('pg_advisory_xact_lock')
    ? Promise.resolve({ rows: [] }) : query(sql, ...args) };
}

describe('WorkTaskDispatchModel broad portfolio visibility', () => {
  beforeEach(() => {
    jest.spyOn(SullaSettingsModel, 'get').mockImplementation(async(_key, fallback) => fallback);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('counts every in-review task without pre-filtering its context', async() => {
    const queryOne = jest.spyOn(postgresClient, 'queryOne').mockResolvedValue({ count: '4' } as any);

    await expect(WorkTaskDispatchModel.countReviewBacklog()).resolves.toBe(4);

    const [sql, params] = queryOne.mock.calls[0];
    expect(sql).toContain("= 'review'");
    expect(sql).toContain("lane.semantic_role");
    expect(sql).not.toContain('LOWER(t.assignee)');
    expect(sql).not.toContain('unnest(COALESCE(t.labels');
    expect(sql).not.toContain("d.status = 'running'");
    expect(params).toBeUndefined();
  });

  it('does not let downstream review hide a newer todo claim', async() => {
    const query = jest.fn(() => Promise.resolve({ rows: [] })) as any;
    jest.spyOn(postgresClient, 'transaction').mockImplementation((callback: any) => callback(admissionClient(query)));

    await expect(WorkTaskDispatchModel.claimNext('sulla-desktop', 'runtime-1')).resolves.toBeNull();

    const sql = query.mock.calls[0][0];
    expect(sql).not.toContain('downstream.status');
    expect(sql).toContain('FOR UPDATE OF t SKIP LOCKED');
  });
});
