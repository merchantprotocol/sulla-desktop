import { afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

import { postgresClient } from '../../PostgresClient';
import { WorkItemsModel } from '../WorkItemsModel';
import { WorkLaneDefinitionModel } from '../WorkLaneDefinitionModel';

const forceDispatcherCheckMock: any = jest.fn(() => Promise.resolve());
const planningTransitionMock: any = jest.fn(() => Promise.resolve());

jest.unstable_mockModule('../../../services/TaskDispatcherService', () => ({
  getTaskDispatcherService: () => ({ forceCheck: forceDispatcherCheckMock }),
}));
jest.unstable_mockModule('../../../services/PlanningCouncilService', () => ({
  PlanningCouncilService: { handleTaskStatusTransition: planningTransitionMock },
}));
jest.unstable_mockModule('../WorkLaneWorkflowBindingModel', () => ({
  WorkLaneWorkflowBindingModel: {
    claimLaneEntryInTransaction: jest.fn(() => Promise.resolve({
      created: false, entry: { id: 'lane-entry-test', status: 'unautomated' },
    })),
  },
}));

describe('WorkItemsModel', () => {
  let originalQuery: any;
  let originalTransaction: any;

  beforeAll(() => {
    originalQuery = postgresClient.query;
    originalTransaction = postgresClient.transaction;
  });

  beforeEach(() => {
    jest.spyOn(WorkLaneDefinitionModel, 'runtimeCapability').mockResolvedValue({
      ready: false, catalogPresent: false, missingRoles: [], degradedReason: 'test fallback',
    });
    jest.spyOn(WorkLaneDefinitionModel, 'validateTaskStatus').mockResolvedValue(null);
  });

  afterEach(() => {
    (postgresClient as any).query = originalQuery;
    (postgresClient as any).transaction = originalTransaction;
    forceDispatcherCheckMock.mockClear();
    planningTransitionMock.mockClear();
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

  it('normalizes a project-specific execution-entry lane when inserting through the model boundary', async() => {
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
      status:   'ready-custom',
      assignee: 'sulla',
      actor:    'sulla',
    });

    expect(task.assignee).toBe('dispatcher');
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

  it('normalizes a project-specific execution-entry lane during update', async() => {
    jest.spyOn(WorkLaneDefinitionModel, 'runtimeCapability').mockResolvedValue({
      ready: true, catalogPresent: true, missingRoles: [], degradedReason: null,
    });
    jest.spyOn(WorkLaneDefinitionModel, 'resolveStatus').mockResolvedValue({
      lane_key: 'ready-custom', semantic_role: 'execution',
    } as any);
    jest.spyOn(WorkLaneDefinitionModel, 'preferredLaneKey').mockResolvedValue('ready-custom');
    (postgresClient as any).query = (jest.fn() as any)
      .mockResolvedValueOnce([{
        id:         'task-custom-update',
        project_id: 'project-1',
        status:     'ready-custom',
        priority:   'high',
        assignee:   'sulla',
        labels:     [],
      }])
      .mockImplementationOnce((_sql: string, params: any[]) => Promise.resolve([{
        id: 'task-custom-update', assignee: params[1], title: params[0],
      }]));

    const task = await WorkItemsModel.updateTask('task-custom-update', {
      title: 'Touched custom lane', actor: 'heartbeat',
    });

    expect(task?.assignee).toBe('dispatcher');
    expect(WorkLaneDefinitionModel.preferredLaneKey).toHaveBeenCalledWith(
      'project-1', 'execution', 'todo', 'first',
    );
  });

  it('preserves an unknown legacy lane as manual during unrelated updates', async() => {
    jest.spyOn(WorkLaneDefinitionModel, 'runtimeCapability').mockResolvedValue({
      ready: true, catalogPresent: true, missingRoles: [], degradedReason: null,
    });
    jest.spyOn(WorkLaneDefinitionModel, 'resolveStatus').mockResolvedValue(null);
    jest.spyOn(WorkLaneDefinitionModel, 'preferredLaneKey').mockResolvedValue('todo');
    (postgresClient as any).query = (jest.fn() as any)
      .mockResolvedValueOnce([{
        id:         'task-unknown-update',
        project_id: 'project-1',
        status:     'legacy-unknown',
        priority:   'high',
        assignee:   'sulla',
        labels:     [],
      }])
      .mockImplementationOnce((_sql: string, params: any[]) => Promise.resolve([{
        id: 'task-unknown-update', assignee: 'sulla', title: params[0],
      }]));

    const task = await WorkItemsModel.updateTask('task-unknown-update', {
      title: 'Still visible', actor: 'heartbeat',
    });

    expect(task?.assignee).toBe('sulla');
    expect(WorkLaneDefinitionModel.preferredLaneKey).not.toHaveBeenCalled();
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
