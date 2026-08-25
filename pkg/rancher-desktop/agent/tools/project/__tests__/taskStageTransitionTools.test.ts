/** @jest-environment node */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { getProjectsApplicationService } from '../../../projects/application/ProjectsApplicationService';
import { TransitionTaskRelativeWorker } from '../transition_task_relative';
import { TransitionTaskStageWorker } from '../transition_task_stage';

const projects = getProjectsApplicationService() as any;
const transitionTaskStage = jest.spyOn(projects, 'transitionTaskStage');
const transitionTaskRelative = jest.spyOn(projects, 'transitionTaskRelative');
const call = (tool: any, input: any) => tool._validatedCall(input);

describe('task stage transition workflow tools', () => {
  beforeEach(() => { jest.clearAllMocks() });

  it('requires an explicit task and stage', async() => {
    expect((await call(new TransitionTaskStageWorker(), { task_id: 'task-1' })).successBoolean).toBe(false);
    expect(transitionTaskStage).not.toHaveBeenCalled();
  });

  it('passes exact stage and generation context through the application boundary', async() => {
    transitionTaskStage.mockResolvedValue({ fromStage: 'research', toStage: 'publish' });
    const result = await call(new TransitionTaskStageWorker(), {
      task_id: 'task-1', stage_key: 'publish', expected_generation: 7, actor: 'publishing-routine',
    });
    expect(result.successBoolean).toBe(true);
    expect(transitionTaskStage).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'task-1', stageKey: 'publish', expectedGeneration: 7,
    }), { actor: 'publishing-routine', source: 'routine' });
  });

  it('accepts only next or previous relative movement', async() => {
    expect((await call(new TransitionTaskRelativeWorker(), {
      task_id: 'task-1', direction: 'review',
    })).successBoolean).toBe(false);
    transitionTaskRelative.mockResolvedValue({ fromStage: 'intake', toStage: 'research' });
    const result = await call(new TransitionTaskRelativeWorker(), {
      task_id: 'task-1', direction: 'next', expected_generation: 2,
    });
    expect(result.successBoolean).toBe(true);
    expect(transitionTaskRelative).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'task-1', direction: 'next', expectedGeneration: 2,
    }), { actor: 'sulla', source: 'routine' });
  });
});
