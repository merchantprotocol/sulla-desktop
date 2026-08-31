import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { postgresClient } from '../../PostgresClient';
import { WorkProjectViewModel } from '../WorkProjectViewModel';

describe('WorkProjectViewModel', () => {
  const originalQuery = postgresClient.query;
  const originalTransaction = postgresClient.transaction;
  afterEach(() => {
    (postgresClient as any).query = originalQuery;
    (postgresClient as any).transaction = originalTransaction;
    jest.restoreAllMocks();
  });

  it('resolves a project default before the global default', async() => {
    (postgresClient as any).query = jest.fn(() => Promise.resolve([]));
    await WorkProjectViewModel.resolve('p1');
    const [sql, params] = (postgresClient.query as any).mock.calls[0];
    expect(sql).toContain('project_id = $1 OR project_id IS NULL');
    expect(sql).toContain('project_id NULLS LAST');
    expect(params).toEqual(['p1']);
  });

  it('atomically replaces only the default in the same scope', async() => {
    const client = {
      query: (jest.fn() as any)
        .mockResolvedValueOnce({ rows: [{ id: 'p1' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'view-1' }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ id: 'view-1', project_id: 'p1', view_type: 'gantt' }] }),
    };
    (postgresClient as any).transaction = jest.fn((callback: any) => callback(client));

    const row = await WorkProjectViewModel.save({ project_id: 'p1', view_type: 'gantt', is_default: true });
    expect(row.view_type).toBe('gantt');
    expect(client.query.mock.calls[2][0]).toContain('project_id IS NOT DISTINCT FROM $1');
    expect(client.query.mock.calls[3][0]).toContain('ON CONFLICT (id) DO UPDATE');
  });
});
