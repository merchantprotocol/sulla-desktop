/** @jest-environment node */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { getProjectsApplicationService } from '../../../projects/application/ProjectsApplicationService';
import { ListReadyTasksWorker } from '../list_ready_tasks';
import { projectToolManifests } from '../manifests';
import { SettleStageGenerationWorker } from '../settle_stage_generation';

describe('readiness/stage-generation manifests', () => {
  it('registers both new node names', () => {
    const names = new Set(projectToolManifests.map(tool => tool.name));
    expect(names.has('list_ready_tasks')).toBe(true);
    expect(names.has('settle_stage_generation')).toBe(true);
  });

  it('loads both new workers through their manifest loader', async() => {
    const targets = projectToolManifests.filter(tool =>
      ['list_ready_tasks', 'settle_stage_generation'].includes(tool.name));
    expect(targets).toHaveLength(2);
    for (const tool of targets) {
      const module = await tool.loader();
      expect(Object.values(module).some((value: any) =>
        typeof value === 'function' && typeof value.prototype?._validatedCall === 'function')).toBe(true);
    }
  });
});

const projects = getProjectsApplicationService() as any;
const readyTasks = jest.spyOn(projects, 'readyTasks');
const settleStageGeneration = jest.spyOn(projects, 'settleStageGeneration');
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

describe('settle_stage_generation workflow tool', () => {
  beforeEach(() => { jest.clearAllMocks() });

  it('requires task_id, a valid status, and expected_generation', async() => {
    expect((await call(new SettleStageGenerationWorker(), { task_id: 'task-1', status: 'completed' })).successBoolean).toBe(false);
    expect((await call(new SettleStageGenerationWorker(), {
      task_id: 'task-1', status: 'unknown', expected_generation: 1,
    })).successBoolean).toBe(false);
    expect(settleStageGeneration).not.toHaveBeenCalled();
  });

  it('settles through the application boundary with the caller actor', async() => {
    settleStageGeneration.mockResolvedValue({ id: 'entry-1', status: 'completed', generation: 2 });
    const result = await call(new SettleStageGenerationWorker(), {
      task_id: 'task-1', status: 'completed', expected_generation: 2, actor: 'review-routine',
    });
    expect(result.successBoolean).toBe(true);
    expect(settleStageGeneration).toHaveBeenCalledWith({
      taskId: 'task-1', expectedGeneration: 2, status: 'completed', outcome: undefined,
    }, { actor: 'review-routine', source: 'routine' });
  });

  it('surfaces a stale-generation rejection as a failed tool result', async() => {
    settleStageGeneration.mockRejectedValue(new Error('Stale stage generation for task task-1'));
    const result = await call(new SettleStageGenerationWorker(), {
      task_id: 'task-1', status: 'failed', expected_generation: 1,
    });
    expect(result.successBoolean).toBe(false);
    expect(result.responseString).toContain('Stale stage generation');
  });
});
