import { describe, expect, it, jest } from '@jest/globals';

import { PostgresProjectsUnitOfWork } from '../PostgresProjectsUnitOfWork';

function clientWith(query: any) {
  return { query, release: jest.fn() } as any;
}

describe('PostgresProjectsUnitOfWork', () => {
  it('commits every repository operation through one client', async() => {
    const query = jest.fn<(sql: string) => Promise<{ rows: any[] }>>(async(sql: string) => {
      if (sql.includes('FROM work_tasks')) {
        return {
          rows: [{
            id:         'task-1',
            project_id: 'project-1',
            epic_id:    'epic-1',
            title:      'Task',
            status:     'todo',
            assignee:   null,
            labels:     null,
            archived:   false,
          }],
        };
      }
      return { rows: [] };
    });
    const client = clientWith(query);
    const unitOfWork = new PostgresProjectsUnitOfWork(() => Promise.resolve(client));

    const task = await unitOfWork.execute(repositories => repositories.tasks.lock('task-1'));

    expect(task?.labels).toEqual([]);
    expect(query.mock.calls.map(call => call[0])).toEqual([
      'BEGIN', expect.stringContaining('FOR UPDATE'), 'COMMIT',
    ]);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('rolls back and rethrows without leaking the client', async() => {
    const query = jest.fn<(sql: string) => Promise<{ rows: any[] }>>(() => Promise.resolve({ rows: [] }));
    const client = clientWith(query);
    const unitOfWork = new PostgresProjectsUnitOfWork(() => Promise.resolve(client));

    await expect(unitOfWork.execute(async() => {
      throw new Error('fail the atomic command');
    })).rejects.toThrow('fail the atomic command');

    expect(query.mock.calls.map(call => call[0])).toEqual(['BEGIN', 'ROLLBACK']);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('composes with a caller-owned transaction without begin, commit, rollback, or release', async() => {
    const query = jest.fn<(sql: string, values?: any[]) => Promise<{ rows: any[] }>>(() => Promise.resolve({
      rows: [{ id: 'project-1', title: 'Project', archived: false }],
    }));
    const client = clientWith(query);

    const project = await PostgresProjectsUnitOfWork.useExisting(
      client,
      repositories => repositories.projects.get('project-1'),
    );

    expect(project?.id).toBe('project-1');
    expect(query).toHaveBeenCalledTimes(1);
    expect(client.release).not.toHaveBeenCalled();
  });
});
