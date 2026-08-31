import { describe, expect, it, jest } from '@jest/globals';

import { createPostgresProjectsRepositories } from '../PostgresProjectsRepositories';

describe('PostgresProjectsRepositories', () => {
  it('uses compare-and-set lane persistence and preserves an omitted assignee', async() => {
    const query = jest.fn<(sql: string, values?: any[]) => Promise<{ rows: any[] }>>(() => Promise.resolve({
      rows: [{
        id:         'task-1',
        project_id: 'project-1',
        epic_id:    null,
        title:      'Task',
        status:     'in_progress',
        assignee:   'dispatcher',
        labels:     ['p0'],
        archived:   false,
      }],
    }));
    const repositories = createPostgresProjectsRepositories({ query } as any);

    await expect(repositories.tasks.compareAndSetLane({
      taskId: 'task-1', expectedLane: 'todo', destinationLane: 'in_progress', actor: 'dispatcher',
    })).resolves.toMatchObject({ status: 'in_progress', labels: ['p0'] });

    expect(query).toHaveBeenCalledWith(expect.stringContaining('status = $6'), [
      'task-1', 'in_progress', 'dispatcher', false, null, 'todo',
    ]);
  });

  it('returns null when another transaction won the expected-lane race', async() => {
    const query = jest.fn<(sql: string, values?: any[]) => Promise<{ rows: any[] }>>(() => Promise.resolve({ rows: [] }));
    const repositories = createPostgresProjectsRepositories({ query } as any);

    await expect(repositories.tasks.compareAndSetLane({
      taskId: 'task-1', expectedLane: 'todo', destinationLane: 'in_progress', actor: 'dispatcher',
    })).resolves.toBeNull();
  });
});
