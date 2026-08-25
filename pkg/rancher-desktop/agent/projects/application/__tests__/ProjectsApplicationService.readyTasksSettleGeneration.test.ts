import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { WorkLaneWorkflowBindingModel } from '../../../database/models/WorkLaneWorkflowBindingModel';
import { WorkTaskDependencyModel } from '../../../database/models/WorkTaskDependencyModel';
import { ProjectsApplicationService } from '../ProjectsApplicationService';

function repository(overrides: { getTask?: any; listTasks?: any } = {}) {
  return {
    getTask:   overrides.getTask ?? jest.fn(() => Promise.resolve({ id: 'task-1', status: 'in_review' })),
    listTasks: overrides.listTasks ?? jest.fn(() => Promise.resolve([])),
  } as any;
}

describe('ProjectsApplicationService.readyTasks', () => {
  afterEach(() => { jest.restoreAllMocks() });

  it('splits candidates into ready and blocked using bulk dependency holds', async() => {
    const listTasks = jest.fn((_opts?: any) => Promise.resolve([
      { id: 'task-1', title: 'Ready one' },
      { id: 'task-2', title: 'Blocked one' },
    ]));
    const listUnresolvedForTasks = jest.spyOn(WorkTaskDependencyModel, 'listUnresolvedForTasks').mockResolvedValue([
      { taskId: 'task-2', dependsOnTaskId: 'task-0', dependsOnStatus: 'todo', dependsOnTitle: 'Blocker', policy: 'pending', reason: "prerequisite task-0 is 'todo', not yet done" } as any,
    ]);
    const service = new ProjectsApplicationService(repository({ listTasks }));

    const result = await service.readyTasks({ projectId: 'project-1' });

    expect(listTasks).toHaveBeenCalledWith({ projectId: 'project-1', epicId: undefined, includeDone: false, limit: 200 });
    expect(listUnresolvedForTasks).toHaveBeenCalledWith(['task-1', 'task-2']);
    expect(result.ready).toEqual([{ id: 'task-1', title: 'Ready one' }]);
    expect(result.blocked).toHaveLength(1);
    expect(result.blocked[0].task).toEqual({ id: 'task-2', title: 'Blocked one' });
    expect(result.blocked[0].holds).toHaveLength(1);
    expect(result.blocked[0].holds[0].dependsOnTaskId).toBe('task-0');
  });

  it('scopes to one epic and respects an explicit limit', async() => {
    const listTasks = jest.fn((_opts?: any) => Promise.resolve([]));
    jest.spyOn(WorkTaskDependencyModel, 'listUnresolvedForTasks').mockResolvedValue([]);
    const service = new ProjectsApplicationService(repository({ listTasks }));

    await service.readyTasks({ projectId: 'project-1', epicId: 'epic-1', limit: 25 });

    expect(listTasks).toHaveBeenCalledWith({ projectId: 'project-1', epicId: 'epic-1', includeDone: false, limit: 25 });
  });

  it('returns an empty result without querying holds when there are no candidates', async() => {
    const listTasks = jest.fn(() => Promise.resolve([]));
    const listUnresolvedForTasks = jest.spyOn(WorkTaskDependencyModel, 'listUnresolvedForTasks').mockResolvedValue([]);
    const service = new ProjectsApplicationService(repository({ listTasks }));

    const result = await service.readyTasks({ projectId: 'project-1' });

    expect(listUnresolvedForTasks).toHaveBeenCalledWith([]);
    expect(result).toEqual({ ready: [], blocked: [] });
  });
});

describe('ProjectsApplicationService.settleStageGeneration', () => {
  afterEach(() => { jest.restoreAllMocks() });

  it('settles the current generation when it matches and the lane entry is running', async() => {
    jest.spyOn(WorkLaneWorkflowBindingModel, 'listLaneEntries').mockResolvedValue([
      { id: 'entry-1', generation: 2, lane_key: 'in_review', execution_id: 'exec-1', status: 'running' },
    ] as any);
    const markOutcome = jest.spyOn(WorkLaneWorkflowBindingModel, 'markOutcome').mockResolvedValue({
      id: 'entry-1', generation: 2, status: 'completed',
    } as any);
    const service = new ProjectsApplicationService(repository());

    const result = await service.settleStageGeneration({
      taskId: 'task-1', expectedGeneration: 2, status: 'completed', outcome: { checks: 'green' },
    }, { actor: 'review-routine', source: 'routine' });

    expect(markOutcome).toHaveBeenCalledWith('entry-1', 'exec-1', 'completed', { checks: 'green', settledBy: 'review-routine' });
    expect(result).toEqual({ id: 'entry-1', generation: 2, status: 'completed' });
  });

  it('rejects a stale expected_generation before touching the lane entry', async() => {
    jest.spyOn(WorkLaneWorkflowBindingModel, 'listLaneEntries').mockResolvedValue([
      { id: 'entry-1', generation: 5, lane_key: 'in_review', execution_id: 'exec-1', status: 'running' },
    ] as any);
    const markOutcome = jest.spyOn(WorkLaneWorkflowBindingModel, 'markOutcome');
    const service = new ProjectsApplicationService(repository());

    await expect(service.settleStageGeneration({ taskId: 'task-1', expectedGeneration: 4, status: 'failed' }))
      .rejects.toThrow('Stale stage generation');
    expect(markOutcome).not.toHaveBeenCalled();
  });

  it('rejects settlement when the lane entry has no active execution', async() => {
    jest.spyOn(WorkLaneWorkflowBindingModel, 'listLaneEntries').mockResolvedValue([
      { id: 'entry-1', generation: 1, lane_key: 'todo', execution_id: null, status: 'pending' },
    ] as any);
    const service = new ProjectsApplicationService(repository());

    await expect(service.settleStageGeneration({ taskId: 'task-1', expectedGeneration: 1, status: 'completed' }))
      .rejects.toThrow('has no active execution');
  });

  it('rejects when the compare-and-set finds the lane entry no longer running', async() => {
    jest.spyOn(WorkLaneWorkflowBindingModel, 'listLaneEntries').mockResolvedValue([
      { id: 'entry-1', generation: 1, lane_key: 'todo', execution_id: 'exec-1', status: 'running' },
    ] as any);
    jest.spyOn(WorkLaneWorkflowBindingModel, 'markOutcome').mockResolvedValue(null);
    const service = new ProjectsApplicationService(repository());

    await expect(service.settleStageGeneration({ taskId: 'task-1', expectedGeneration: 1, status: 'completed' }))
      .rejects.toThrow('settlement rejected');
  });

  it('rejects an invalid status before querying lane entries', async() => {
    const listLaneEntries = jest.spyOn(WorkLaneWorkflowBindingModel, 'listLaneEntries');
    const service = new ProjectsApplicationService(repository());

    await expect(service.settleStageGeneration({ taskId: 'task-1', expectedGeneration: 1, status: 'pending' as any }))
      .rejects.toThrow("status must be 'completed' or 'failed'");
    expect(listLaneEntries).not.toHaveBeenCalled();
  });

  it('rejects settlement for a missing task', async() => {
    const service = new ProjectsApplicationService(repository({ getTask: jest.fn(() => Promise.resolve(null)) }));

    await expect(service.settleStageGeneration({ taskId: 'task-missing', expectedGeneration: 1, status: 'completed' }))
      .rejects.toThrow('Task not found');
  });
});
