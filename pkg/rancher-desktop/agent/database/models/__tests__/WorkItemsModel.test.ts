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
      task_id:        'task-1',
      body:           'Moved the operator task forward.',
      author:         'Heartbeat',
      created_at:     '2026-08-17T16:00:00.000Z',
      updated_at:     null,
      archived:       false,
      task_title:     'Improve workboard continuity',
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

    expect(postgresClient.query).toHaveBeenCalledWith(
      expect.stringContaining('JOIN work_tasks t ON t.id = c.task_id'),
      ['project-1', 'heartbeat', 12],
    );
    expect(postgresClient.query).toHaveBeenCalledWith(
      expect.stringContaining("LOWER(COALESCE(c.author, '')) = LOWER($2)"),
      ['project-1', 'heartbeat', 12],
    );
    expect(rows[0]).toMatchObject({
      task_title:    'Improve workboard continuity',
      project_title: 'Sulla Desktop',
    });
  });

  it('bounds recent activity limits passed over IPC', async() => {
    (postgresClient as any).query = jest.fn(() => Promise.resolve([]));

    await WorkItemsModel.listRecentActivity({ limit: 500 });
    await WorkItemsModel.listRecentActivity({ limit: 0 });

    expect(postgresClient.query).toHaveBeenNthCalledWith(
      1,
      expect.any(String),
      [200],
    );
    expect(postgresClient.query).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      [1],
    );
  });
});
