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
    const committedTask = {
      ...task,
      status:        'planning',
      updated_at:    '2026-08-23T20:52:00.000Z',
      last_moved_at: '2026-08-23T20:52:00.000Z',
    };
    const query = (jest.fn() as any)
      .mockResolvedValueOnce({ rows: [{ status: 'running' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [committedTask] });
    (postgresClient as any).transaction = jest.fn((callback: any) => callback({ query }));

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

    expect(query.mock.calls[3][0]).toContain('RETURNING *');
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
  });
});
