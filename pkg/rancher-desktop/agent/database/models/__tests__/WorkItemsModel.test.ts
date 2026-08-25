import { afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

import { postgresClient } from '../../PostgresClient';
import { WorkItemsModel } from '../WorkItemsModel';
import { WorkLaneDefinitionModel } from '../WorkLaneDefinitionModel';

describe('WorkItemsModel', () => {
  let originalQuery: any;

  beforeAll(() => {
    originalQuery = postgresClient.query;
  });

  beforeEach(() => {
    jest.spyOn(WorkLaneDefinitionModel, 'runtimeCapability').mockResolvedValue({
      ready: false, catalogPresent: false, missingRoles: [], degradedReason: 'test compatibility mode',
    });
    jest.spyOn(WorkLaneDefinitionModel, 'validateTaskStatus').mockImplementation((_projectId, laneKey) => Promise.resolve({
      lane_key:      laneKey,
      semantic_role: ['done', 'cancelled'].includes(laneKey) ? 'terminal' : laneKey === 'blocked' ? 'blocked' : 'execution',
    } as any));
    jest.spyOn(WorkLaneDefinitionModel, 'preferredLaneKey').mockImplementation((_projectId, _role, fallback) => Promise.resolve(fallback));
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

  it('normalizes direct Sulla todo ownership when inserting through the model boundary', async() => {
    (postgresClient as any).query = (jest.fn() as any)
      .mockResolvedValueOnce([{ id: 'epic-1', project_id: 'project-1' }])
      .mockImplementationOnce((_sql: string, params: any[]) => Promise.resolve([{
        id: params[0], status: params[7], assignee: params[11], labels: params[12],
      }]));

    const task = await WorkItemsModel.insertTask({
      id:       'task-1',
      epic_id:  'epic-1',
      title:    'Executable',
      status:   'todo',
      assignee: 'sulla',
      actor:    'sulla',
      labels:   ['projects'],
    });

    expect(task.assignee).toBe('dispatcher');
    expect((postgresClient.query as any).mock.calls[1][1][11]).toBe('dispatcher');
  });

  it('falls back to todo ownership when omitted-status creation is capability-degraded', async() => {
    (postgresClient as any).query = (jest.fn() as any)
      .mockResolvedValueOnce([{ id: 'epic-1', project_id: 'project-1' }])
      .mockImplementationOnce((_sql: string, params: any[]) => Promise.resolve([{
        id: params[0], status: params[7], assignee: params[11], labels: params[12],
      }]));

    const task = await WorkItemsModel.insertTask({
      id:       'task-degraded-default',
      epic_id:  'epic-1',
      title:    'Compatibility entry',
      assignee: 'sulla',
      actor:    'sulla',
    });

    expect(task).toMatchObject({ status: 'todo', assignee: 'dispatcher' });
  });

  it('defaults omitted-status creation to the project-specific execution-entry lane', async() => {
    jest.spyOn(WorkLaneDefinitionModel, 'validateTaskStatus').mockResolvedValue({
      lane_key: 'ready-custom', semantic_role: 'execution',
    } as any);
    jest.spyOn(WorkLaneDefinitionModel, 'preferredLaneKey').mockResolvedValue('ready-custom');
    (postgresClient as any).query = (jest.fn() as any)
      .mockResolvedValueOnce([{ id: 'epic-1', project_id: 'project-1' }])
      .mockImplementationOnce((_sql: string, params: any[]) => Promise.resolve([{
        id: params[0], status: params[7], assignee: params[11], labels: params[12],
      }]));

    const task = await WorkItemsModel.insertTask({
      id:       'task-custom-create',
      epic_id:  'epic-1',
      title:    'Custom execution entry',
      assignee: 'sulla',
      actor:    'sulla',
    });

    expect(task).toMatchObject({ status: 'ready-custom', assignee: 'dispatcher' });
    expect(WorkLaneDefinitionModel.preferredLaneKey).toHaveBeenCalledWith(
      'project-1', 'execution', 'todo', 'first',
    );
  });
  it('preserves gated and human ownership when inserting through the model boundary', async() => {
    (postgresClient as any).query = (jest.fn() as any)
      .mockResolvedValueOnce([{ id: 'epic-1', project_id: 'project-1' }])
      .mockResolvedValueOnce([{ id: 'gated', assignee: 'sulla' }])
      .mockResolvedValueOnce([{ id: 'epic-1', project_id: 'project-1' }])
      .mockResolvedValueOnce([{ id: 'human', assignee: 'human' }]);

    await WorkItemsModel.insertTask({
      id:       'gated',
      epic_id:  'epic-1',
      title:    'Needs approval',
      status:   'todo',
      assignee: 'sulla',
      actor:    'sulla',
      labels:   ['gated'],
    });
    await WorkItemsModel.insertTask({
      id:       'human',
      epic_id:  'epic-1',
      title:    'Human task',
      status:   'todo',
      assignee: 'human',
      actor:    'sulla',
      labels:   [],
    });

    expect((postgresClient.query as any).mock.calls[1][1][11]).toBe('sulla');
    expect((postgresClient.query as any).mock.calls[3][1][11]).toBe('human');
  });

  it('normalizes a legacy todo during an update using the resulting labels and status', async() => {
    (postgresClient as any).query = (jest.fn() as any)
      .mockResolvedValueOnce([{
        id: 'task-1', status: 'todo', priority: 'high', assignee: 'sulla', labels: [],
      }])
      .mockImplementationOnce((_sql: string, params: any[]) => Promise.resolve([{
        id: 'task-1', assignee: params[1], title: params[0],
      }]));

    const task = await WorkItemsModel.updateTask('task-1', { title: 'Touched', actor: 'heartbeat' });
    const sql = (postgresClient.query as any).mock.calls[1][0] as string;

    expect(task?.assignee).toBe('dispatcher');
    expect(sql).toContain('assignee = $2');
    expect(sql).toContain('last_moved_by');
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

  it('commits a schedule edit and its audit row in the same transaction', async() => {
    const before = {
      id:           'task-schedule',
      project_id:   'project-1',
      status:       'todo',
      priority:     'high',
      assignee:     'human',
      labels:       [],
      start_at:     null,
      due_at:       null,
      milestone_at: null,
    };
    const after = { ...before, due_at: '2026-08-31T00:00:00.000Z' };
    (postgresClient as any).query = jest.fn(() => Promise.resolve([before]));
    const client = {
      query: (jest.fn() as any)
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [before] })
        .mockResolvedValueOnce({ rows: [after] })
        .mockResolvedValueOnce({ rows: [] }),
    };
    (postgresClient as any).transaction = jest.fn((callback: any) => callback(client));

    const updated = await WorkItemsModel.updateTask('task-schedule', {
      due_at: '2026-08-31T00:00:00.000Z', actor: 'human',
    });

    expect(updated?.due_at).toBe('2026-08-31T00:00:00.000Z');
    expect(client.query.mock.calls[1][0]).toContain('FOR UPDATE');
    expect(client.query.mock.calls[2][0]).toContain('UPDATE work_tasks');
    expect(client.query.mock.calls[3][0]).toContain('INSERT INTO work_schedule_audit');
    expect(postgresClient.transaction).toHaveBeenCalledTimes(1);
  });

  it('persists active same-project dependencies and rejects dependency cycles', async() => {
    const successClient = {
      query: (jest.fn() as any)
        .mockResolvedValueOnce({
          rows: [
            { id: 'task-a', project_id: 'project-1' },
            { id: 'task-b', project_id: 'project-1' },
          ],
        })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({
          rows: [{
            id:                   'dep-1',
            dependent_task_id:    'task-a',
            depends_on_task_id:   'task-b',
            relation_type:        'requires',
            acceptance_condition: null,
            created_by:           'human',
            created_at:           '2026-08-24T00:00:00.000Z',
            updated_at:           null,
            archived_at:          null,
          }],
        }),
    };
    (postgresClient as any).transaction = jest.fn((callback: any) => callback(successClient));
    await expect(WorkItemsModel.setTaskDependency('task-a', 'task-b', 'human')).resolves.toMatchObject(
      {
        task_id: 'task-a', depends_on_task_id: 'task-b',
      },
    );
    expect(successClient.query.mock.calls[3][0]).toContain('WITH RECURSIVE reach');

    const cycleClient = {
      query: (jest.fn() as any)
        .mockResolvedValueOnce({
          rows: [
            { id: 'task-a', project_id: 'project-1' },
            { id: 'task-b', project_id: 'project-1' },
          ],
        })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ found: true }] }),
    };
    (postgresClient as any).transaction = jest.fn((callback: any) => callback(cycleClient));
    await expect(
      WorkItemsModel.setTaskDependency('task-a', 'task-b', 'human'),
    )
      .rejects.toThrow('create a cycle');
  });
});
