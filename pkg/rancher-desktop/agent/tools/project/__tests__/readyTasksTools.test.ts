/** @jest-environment node */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { getProjectsApplicationService } from '../../../projects/application/ProjectsApplicationService';
import { ListReadyTasksWorker } from '../list_ready_tasks';
import { projectToolManifests } from '../manifests';

describe('readiness manifests', () => {
  it('registers list_ready_tasks and no stage-generation settlement tool', () => {
    const names = new Set(projectToolManifests.map(tool => tool.name));
    expect(names.has('list_ready_tasks')).toBe(true);
    expect(names.has('settle_stage_generation')).toBe(false);
  });

  it('loads the readiness worker through its manifest loader', async() => {
    const targets = projectToolManifests.filter(tool => tool.name === 'list_ready_tasks');
    expect(targets).toHaveLength(1);
    for (const tool of targets) {
      const module = await tool.loader();
      expect(Object.values(module).some((value: any) =>
        typeof value === 'function' && typeof value.prototype?._validatedCall === 'function')).toBe(true);
    }
  });
});

const projects = getProjectsApplicationService() as any;
const readyTasks = jest.spyOn(projects, 'readyTasks');
const call = (tool: any, input: any) => tool._validatedCall(input);

describe('list_ready_tasks workflow tool', () => {
  beforeEach(() => { jest.clearAllMocks() });

  it('requires project_id', async() => {
    expect((await call(new ListReadyTasksWorker(), {})).successBoolean).toBe(false);
    expect(readyTasks).not.toHaveBeenCalled();
  });

  it('passes project/epic scope through the application boundary', async() => {
    readyTasks.mockResolvedValue({ ready: [{ id: 'task-1' }], blocked: [] });
    const result = await call(new ListReadyTasksWorker(), { project_id: 'project-1', epic_id: 'epic-1', limit: 50 });
    expect(result.successBoolean).toBe(true);
    expect(readyTasks).toHaveBeenCalledWith({ projectId: 'project-1', epicId: 'epic-1', limit: 50 });
  });

  it('reports blocked tasks with their holds in the response payload', async() => {
    readyTasks.mockResolvedValue({
      ready:   [],
      blocked: [{ task: { id: 'task-2' }, holds: [{ taskId: 'task-2', dependsOnTaskId: 'task-1', reason: 'not done' }] }],
    });
    const result = await call(new ListReadyTasksWorker(), { project_id: 'project-1' });
    expect(result.successBoolean).toBe(true);
    expect(result.responseString).toContain('task-2');
    expect(result.responseString).toContain('not done');
  });
});
