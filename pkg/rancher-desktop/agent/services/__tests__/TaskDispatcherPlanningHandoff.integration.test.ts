import { afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';

import { postgresClient } from '../../database/PostgresClient';

const planningTransitionMock: any = jest.fn(() => Promise.resolve());

jest.unstable_mockModule('../../database/models/SullaSettingsModel', () => ({
  SullaSettingsModel: { get: jest.fn() },
}));
jest.unstable_mockModule('../../database/models/WorkItemsModel', () => ({
  WorkItemsModel: {
    addComment:   jest.fn(() => Promise.resolve()),
    updateTask:   jest.fn(() => Promise.resolve()),
    listComments: jest.fn(() => Promise.resolve([])),
  },
}));
jest.unstable_mockModule('../PlanningCouncilService', () => ({
  PlanningCouncilService: { handleTaskStatusTransition: planningTransitionMock },
}));
jest.unstable_mockModule('../CanonicalArtifactCustodyService', () => ({
  CanonicalArtifactCustodyService: { verify: jest.fn() },
}));
jest.unstable_mockModule('../../database/models/WorkflowModel', () => ({
  WorkflowModel: { findById: jest.fn() },
}));
jest.unstable_mockModule('../GraphRegistry', () => ({
  GraphRegistry: {
    getOrCreateAgentGraph: jest.fn(),
    delete:                jest.fn(),
  },
}));
jest.unstable_mockModule('../HeartbeatService', () => ({
  isInsideWindow: jest.fn(() => true),
}));
jest.unstable_mockModule('../../utils/sullaPaths', () => ({
  findAgentDir: jest.fn(() => '/agents/opus-worker'),
}));
jest.unstable_mockModule('../../workflow/WorkflowPlaybook', () => ({
  createPlaybookState: jest.fn(),
}));
jest.unstable_mockModule('../GraphRegistry', () => ({
  GraphRegistry: { delete: jest.fn(), getOrCreateAgentGraph: jest.fn() },
}));
jest.unstable_mockModule('../CanonicalArtifactCustodyService', () => ({
  CanonicalArtifactCustodyService: { verify: jest.fn() },
}));
jest.unstable_mockModule('../../database/models/SullaSettingsModel', () => ({
  SullaSettingsModel: { get: jest.fn() },
}));
jest.unstable_mockModule('../../database/models/WorkItemsModel', () => ({
  WorkItemsModel: { listComments: jest.fn() },
}));
jest.unstable_mockModule('../../database/models/WorkflowModel', () => ({
  WorkflowModel: { findById: jest.fn() },
}));
jest.unstable_mockModule('../HeartbeatService', () => ({
  isInsideWindow: jest.fn(),
}));
jest.unstable_mockModule('../../utils/sullaPaths', () => ({
  findAgentDir: jest.fn(),
}));
jest.unstable_mockModule('../../tools/agents/agentTurnOutcome', () => ({
  extractAgentTurnOutcome: jest.fn(),
}));

describe('TaskDispatcherService planning handoff', () => {
  let originalTransaction: any;

  beforeAll(() => {
    originalTransaction = postgresClient.transaction;
  });

  afterEach(() => {
    (postgresClient as any).transaction = originalTransaction;
    jest.clearAllMocks();
  });

  it('passes the complete row returned by the real atomic finalizer to the planning council', async() => {
    const events: string[] = [];
    const task = {
      id:          'task-1',
      project_id:  'project-1',
      epic_id:     'epic-1',
      title:       'Repair custody',
      description: '',
      status:      'in_progress',
      priority:    'critical',
      assignee:    'dispatcher',
      labels:      [],
    } as any;
    let storedTask = { ...task };
    let storedDispatchStatus = 'running';
    const query = jest.fn((sql: string, params: any[] = []) => {
      if (sql.includes('SELECT status FROM work_task_dispatches')) {
        return Promise.resolve({ rows: [{ status: storedDispatchStatus }] });
      }
      if (sql.includes('UPDATE work_task_dispatches')) {
        storedDispatchStatus = params[2];
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('INSERT INTO work_task_comments')) {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('UPDATE work_tasks')) {
        expect(sql).toContain('RETURNING *');
        expect(storedTask).toMatchObject({
          id:       params[0],
          status:   'in_progress',
          assignee: 'dispatcher',
        });
        storedTask = {
          ...storedTask,
          status:        params[1],
          assignee:      params[2],
          updated_at:    '2026-08-23T20:52:00.000Z',
          last_moved_at: '2026-08-23T20:52:00.000Z',
        };
        events.push('task-row-returned');
        return Promise.resolve({ rows: [{ ...storedTask }] });
      }
      throw new Error(`Unexpected finalizer query: ${ sql }`);
    });
    (postgresClient as any).transaction = jest.fn(async(callback: any) => {
      const result = await callback({ query });
      events.push('transaction-committed');
      return result;
    });
    planningTransitionMock.mockImplementationOnce(() => {
      events.push('planning-claimed');
      return Promise.resolve();
    });

    const { TaskDispatcherService } = await import('../TaskDispatcherService');
    const service = new TaskDispatcherService();

    await (service as any).finalizeClaim({
      task,
      dispatch: {
        id:        'dispatch-1',
        task_id:   'task-1',
        agent_id:  'opus-worker',
        thread_id: 'thread-1',
        status:    'running',
      },
    }, 'failed', 'worker transport failed', 'core-routine');

    expect(planningTransitionMock).toHaveBeenCalledTimes(1);
    expect(planningTransitionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id:         'task-1',
        status:     'planning',
        assignee:   'dispatcher',
        project_id: 'project-1',
      }),
      'in_progress',
      'dispatcher',
    );
    expect(events).toEqual([
      'task-row-returned',
      'transaction-committed',
      'planning-claimed',
    ]);
  });
});
