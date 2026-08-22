import { afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';

import { postgresClient } from '../../PostgresClient';
import { WorkItemsModel } from '../WorkItemsModel';

describe('WorkItemsModel', () => {
  let originalQuery: any;

  beforeAll(() => {
    originalQuery = postgresClient.query;
  });

  afterEach(() => {
    (postgresClient as any).query = originalQuery;
    jest.restoreAllMocks();
  });

  it('lists recent activity with project and author filters in stable parameter order', async() => {
    (postgresClient as any).query = jest.fn(() => Promise.resolve([{
      id:             'comment-1',
      kind:           'comment',
      activity_at:    '2026-08-17T16:00:00.000Z',
      created_at:     '2026-08-17T16:00:00.000Z',
      task_id:        'task-1',
      body:           'Moved the operator task forward.',
      author:         'Heartbeat',
      task_title:     'Improve Projects continuity',
      task_status:    'in_progress',
      task_priority:  'high',
      project_id:     'project-1',
      project_title:  'Sulla Desktop',
      project_slug:   'sulla-desktop',
      epic_id:        null,
      epic_title:     null,
    }]));

    const rows = await WorkItemsModel.listRecentActivity({
      projectId: 'project-1',
      author:    'heartbeat',
      limit:     12,
    });

    // Unified feed: params are always bound in [projectId, author, limit] order.
    expect(postgresClient.query).toHaveBeenCalledWith(
      expect.stringContaining('UNION ALL'),
      ['project-1', 'heartbeat', 12],
    );
    expect(postgresClient.query).toHaveBeenCalledWith(
      expect.stringContaining("LOWER(COALESCE(c.author, '')) = LOWER($2)"),
      ['project-1', 'heartbeat', 12],
    );
    expect(rows[0]).toMatchObject({
      kind:          'comment',
      task_title:    'Improve Projects continuity',
      project_title: 'Sulla Desktop',
    });
  });

  it('projects task lifecycle actors through the unified activity author field', async() => {
    (postgresClient as any).query = jest.fn(() => Promise.resolve([]));

    await WorkItemsModel.listRecentActivity({
      projectId: 'project-1',
      author:    'heartbeat',
      limit:     20,
    });

    const sql = (postgresClient.query as any).mock.calls[0][0] as string;

    expect(sql).toContain("COALESCE(t.created_by, 'sulla')");
    expect(sql).toContain("COALESCE(t.last_moved_by, 'sulla')");
    expect(sql).toContain("LOWER(COALESCE(t.created_by, 'sulla')) = LOWER($2)");
    expect(sql).toContain("LOWER(COALESCE(t.last_moved_by, 'sulla')) = LOWER($2)");
    expect(sql).toContain("SELECT 'tc:' || t.id, 'task_created', t.created_at, NULL, COALESCE(t.created_by, 'sulla')");
    expect(sql).toContain("SELECT 'tm:' || t.id, 'task_moved', t.last_moved_at, NULL, COALESCE(t.last_moved_by, 'sulla')");
  });

  it('bounds recent activity limits passed over IPC', async() => {
    (postgresClient as any).query = jest.fn(() => Promise.resolve([]));

    await WorkItemsModel.listRecentActivity({ limit: 500 });
    await WorkItemsModel.listRecentActivity({ limit: 0 });

    // projectId/author default to null; limit is clamped to [1, 200].
    expect(postgresClient.query).toHaveBeenNthCalledWith(
      1,
      expect.any(String),
      [null, null, 200],
    );
    expect(postgresClient.query).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      [null, null, 1],
    );
  });

  it('orders tasks by oldest activity inside each priority block', async() => {
    (postgresClient as any).query = jest.fn(() => Promise.resolve([]));

    await WorkItemsModel.listTasks({ assignee: 'heartbeat', limit: 12 });

    const sql = (postgresClient.query as any).mock.calls[0][0] as string;
    expect(sql).toContain('ORDER BY');
    expect(sql).toContain('last_activity_at ASC, due_at ASC NULLS LAST, position ASC');
    expect(sql.indexOf('last_activity_at ASC')).toBeGreaterThan(sql.indexOf('CASE priority'));
  });

  it('advances task activity on every task mutation', async() => {
    (postgresClient as any).query = (jest.fn() as any)
      .mockResolvedValueOnce([{
        id: 'task-1', status: 'todo', priority: 'high', assignee: 'heartbeat',
      }])
      .mockResolvedValueOnce([{
        id: 'task-1', status: 'todo', priority: 'high', assignee: 'heartbeat', title: 'Updated',
      }]);

    await WorkItemsModel.updateTask('task-1', { title: 'Updated', actor: 'heartbeat' });

    const sql = (postgresClient.query as any).mock.calls[1][0] as string;
    expect(sql).toContain('updated_at = now()');
    expect(sql).toContain('last_activity_at = now()');
    expect(sql).not.toContain('last_moved_at = now()');
  });

  it('inserts a comment and touches its task in one SQL statement', async() => {
    (postgresClient as any).query = (jest.fn() as any)
      .mockResolvedValueOnce([{ id: 'task-1', title: 'Rotate me' }])
      .mockResolvedValueOnce([{
        id: 'comment-1', task_id: 'task-1', body: 'Checked.', author: 'heartbeat',
      }]);

    await WorkItemsModel.addComment({ id: 'comment-1', task_id: 'task-1', body: 'Checked.', author: 'heartbeat' });

    const sql = (postgresClient.query as any).mock.calls[1][0] as string;
    expect(sql).toContain('WITH inserted AS');
    expect(sql).toContain('SET last_activity_at = now()');
    expect(sql).toContain('SELECT inserted.* FROM inserted JOIN touched ON true');
  });
});
