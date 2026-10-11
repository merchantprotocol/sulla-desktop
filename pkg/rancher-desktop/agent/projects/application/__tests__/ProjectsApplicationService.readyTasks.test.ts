import { afterEach, describe, expect, it, jest } from '@jest/globals';

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
    const service = new ProjectsApplicationService(repository({ listTasks, getTask: jest.fn(async() => null) }));

    const result = await service.readyTasks({ projectId: 'project-1' });

    expect(listTasks).toHaveBeenCalledWith({ projectId: 'project-1', epicId: undefined, includeDone: false, limit: 200 });
    expect(listUnresolvedForTasks).toHaveBeenCalledWith(['task-1', 'task-2']);
    expect(result.ready).toEqual([{ id: 'task-1', title: 'Ready one' }]);
    expect(result.blocked).toHaveLength(1);
    expect(result.blocked[0].task).toEqual({ id: 'task-2', title: 'Blocked one' });
    expect(result.blocked[0].holds).toHaveLength(1);
    expect(result.blocked[0].holds[0].dependsOnTaskId).toBe('task-0');
  });

  it('follows dependencies beyond the initial page to open, unheld prerequisites', async() => {
    const tasks: Record<string, any> = {
      middle: { id: 'middle', status: 'todo' },
      leaf: { id: 'leaf', status: 'todo', assignee: 'coder' },
      human: { id: 'human', status: 'todo', assignee: 'human' },
      closed: { id: 'closed', status: 'cancelled' },
    };
    const hold = (taskId: string, dependsOnTaskId: string) => ({ taskId, dependsOnTaskId, policy: 'pending' }) as any;
    jest.spyOn(WorkTaskDependencyModel, 'listUnresolvedForTasks').mockImplementation(async(ids) =>
      ids.includes('root') ? [hold('root', 'middle')] : ids.includes('middle')
        ? [hold('middle', 'leaf'), hold('middle', 'human'), hold('middle', 'closed')] : []);
    const service = new ProjectsApplicationService(repository({
      listTasks: jest.fn(async() => [{ id: 'root' }]),
      getTask: jest.fn(async(id: string) => tasks[id] ?? null),
    }));
    const result = await service.readyTasks({ projectId: 'project-1', limit: 1 });
    expect(result.ready).toEqual([]);
    expect(result.runnablePrerequisites).toEqual([tasks.leaf, tasks.human]);
    expect(result.blocked[0].task.id).toBe('root');
  });

  it('scopes to one epic and respects an explicit limit', async() => {
    const listTasks = jest.fn((_opts?: any) => Promise.resolve([]));
    jest.spyOn(WorkTaskDependencyModel, 'listUnresolvedForTasks').mockResolvedValue([]);
    const service = new ProjectsApplicationService(repository({ listTasks, getTask: jest.fn(async() => null) }));

    await service.readyTasks({ projectId: 'project-1', epicId: 'epic-1', limit: 25 });

    expect(listTasks).toHaveBeenCalledWith({ projectId: 'project-1', epicId: 'epic-1', includeDone: false, limit: 25 });
  });

  it('returns an empty result without querying holds when there are no candidates', async() => {
    const listTasks = jest.fn(() => Promise.resolve([]));
    const listUnresolvedForTasks = jest.spyOn(WorkTaskDependencyModel, 'listUnresolvedForTasks').mockResolvedValue([]);
    const service = new ProjectsApplicationService(repository({ listTasks, getTask: jest.fn(async() => null) }));

    const result = await service.readyTasks({ projectId: 'project-1' });

    expect(listUnresolvedForTasks).toHaveBeenCalledWith([]);
    expect(result).toEqual({ ready: [], blocked: [], runnablePrerequisites: [] });
  });
});
