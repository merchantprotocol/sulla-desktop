import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const getTaskMock: any = jest.fn();
const getProjectMock: any = jest.fn();
const getEpicMock: any = jest.fn();
const listCommentsMock: any = jest.fn();
const addCommentMock: any = jest.fn();
const updateTaskMock: any = jest.fn();
const claimMock: any = jest.fn();
const attachExecutionMock: any = jest.fn();
const settleForTaskMock: any = jest.fn();
const findActiveByExecutionMock: any = jest.fn();
const recoverStaleMock: any = jest.fn();
const recoverStaleForTaskMock: any = jest.fn();
const findWorkflowMock: any = jest.fn();
const executeRoutineMock: any = jest.fn();

jest.unstable_mockModule('../../database/models/WorkItemsModel', () => ({
  WorkItemsModel: {
    getTask:      getTaskMock,
    getProject:   getProjectMock,
    getEpic:      getEpicMock,
    listComments: listCommentsMock,
    addComment:   addCommentMock,
    updateTask:   updateTaskMock,
  },
}));

jest.unstable_mockModule('../../database/models/WorkTaskPlanningRunModel', () => ({
  PROJECT_TASK_PLANNING_WORKFLOW_ID: 'core-routine-plan-project-task',
  WorkTaskPlanningRunModel:          {
    claim:                 claimMock,
    attachExecution:       attachExecutionMock,
    settleForTask:         settleForTaskMock,
    findActiveByExecution: findActiveByExecutionMock,
    recoverStale:          recoverStaleMock,
    recoverStaleForTask:   recoverStaleForTaskMock,
  },
}));

jest.unstable_mockModule('../../database/models/WorkflowModel', () => ({
  WorkflowModel: { findById: findWorkflowMock },
}));

jest.unstable_mockModule('../../../main/sullaRoutineTemplateEvents', () => ({
  executeRoutine: executeRoutineMock,
}));

const task = {
  id:           'task-1',
  project_id:   'project-1',
  epic_id:      'epic-1',
  title:        'Fix it',
  description:  'Description',
  status:       'planning',
  priority:     'critical',
  assignee:     'planning-council',
  labels:       [],
  github_issue: 'owner/repo#1',
} as any;
const run = {
  id:             'planning-1',
  task_id:        'task-1',
  status:         'active',
  attempt:        1,
  trigger_status: 'blocked',
} as any;

async function service() {
  return (await import('../PlanningCouncilService')).PlanningCouncilService;
}

describe('PlanningCouncilService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    findWorkflowMock.mockResolvedValue({
      attributes: { system: true, status: 'production', enabled: true },
    });
    claimMock.mockResolvedValue({ run, task });
    getProjectMock.mockResolvedValue({ id: 'project-1', title: 'Project', description: '', outcome_metric: null, github_repo: 'owner/repo' });
    getEpicMock.mockResolvedValue({ id: 'epic-1', title: 'Epic', description: '' });
    listCommentsMock.mockResolvedValue([{ author: 'worker', created_at: '2026-08-23', body: 'Exact blocker' }]);
    addCommentMock.mockResolvedValue({});
    attachExecutionMock.mockResolvedValue(undefined);
    executeRoutineMock.mockResolvedValue({ executionId: 'graph-1', playbookExecutionId: 'wfp-1' });
    settleForTaskMock.mockResolvedValue(null);
    recoverStaleForTaskMock.mockResolvedValue(false);
  });

  it('atomically claims a blocked task and launches the task-scoped routine once', async() => {
    const PlanningCouncilService = await service();
    await PlanningCouncilService.handleTaskStatusTransition({ ...task, status: 'blocked' }, 'in_progress', 'worker');

    expect(claimMock).toHaveBeenCalledWith('task-1', 'blocked', 'worker');
    expect(executeRoutineMock).toHaveBeenCalledWith(
      'core-routine-plan-project-task',
      expect.stringContaining('"original_blocker":"Exact blocker"'),
      { allowConcurrent: true },
    );
    expect(attachExecutionMock).toHaveBeenCalledWith('planning-1', 'wfp-1');
    expect(addCommentMock).toHaveBeenCalledWith(expect.objectContaining({
      task_id: 'task-1', author: 'planning-council',
    }));
  });

  it('does nothing when the human disabled the locked routine', async() => {
    findWorkflowMock.mockResolvedValue({
      attributes: { system: true, status: 'production', enabled: false },
    });
    const PlanningCouncilService = await service();
    await PlanningCouncilService.handleTaskStatusTransition({ ...task, status: 'blocked' }, 'todo', 'human');

    expect(claimMock).not.toHaveBeenCalled();
    expect(executeRoutineMock).not.toHaveBeenCalled();
  });

  it('relies on the durable claim to suppress repeated planning updates', async() => {
    claimMock.mockResolvedValue(null);
    const PlanningCouncilService = await service();
    await PlanningCouncilService.handleTaskStatusTransition(task, 'planning', 'heartbeat');
    await PlanningCouncilService.handleTaskStatusTransition(task, 'planning', 'heartbeat');

    expect(claimMock).toHaveBeenCalledTimes(2);
    expect(executeRoutineMock).not.toHaveBeenCalled();
  });

  it('expires an abandoned active run and retries on the next status event', async() => {
    recoverStaleForTaskMock.mockResolvedValue(true);
    const PlanningCouncilService = await service();
    await PlanningCouncilService.handleTaskStatusTransition(task, 'planning', 'heartbeat');

    expect(recoverStaleForTaskMock).toHaveBeenCalledWith('task-1', 45);
    expect(addCommentMock).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.stringContaining('Recovered a stale planning council'),
    }));
    expect(claimMock).toHaveBeenCalled();
    expect(executeRoutineMock).toHaveBeenCalled();
  });

  it('settles the active council when the recordkeeper returns work to todo', async() => {
    settleForTaskMock.mockResolvedValue(run);
    const PlanningCouncilService = await service();
    await PlanningCouncilService.handleTaskStatusTransition(
      { ...task, status: 'todo', assignee: 'dispatcher' },
      'planning',
      'planning-council',
    );

    expect(settleForTaskMock).toHaveBeenCalledWith('task-1', 'completed');
    expect(addCommentMock).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.stringContaining('returned to todo/dispatcher'),
    }));
    expect(executeRoutineMock).not.toHaveBeenCalled();
  });

  it('fails closed when a workflow ends without moving the task out of planning', async() => {
    findActiveByExecutionMock.mockResolvedValue(run);
    getTaskMock.mockResolvedValue(task);
    const PlanningCouncilService = await service();
    await PlanningCouncilService.handleWorkflowFinished('wfp-1', 'completed');

    expect(settleForTaskMock).toHaveBeenCalledWith(
      'task-1',
      'failed',
      expect.stringContaining('without persisting a final plan'),
    );
    expect(updateTaskMock).toHaveBeenCalledWith('task-1', {
      status: 'blocked', assignee: 'heartbeat', actor: 'planning-council',
    });
  });
});
