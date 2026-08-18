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
});
