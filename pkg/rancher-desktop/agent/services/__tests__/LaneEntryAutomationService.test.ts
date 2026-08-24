import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { WorkLaneWorkflowBindingModel } from '../../database/models/WorkLaneWorkflowBindingModel';
import { LaneEntryAutomationService } from '../LaneEntryAutomationService';

describe('LaneEntryAutomationService', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('does not relaunch a duplicate same-generation claim', async() => {
    const entry: any = { id: 'entry-1', workflow_id: 'wf-1', generation: 1 };
    jest.spyOn(WorkLaneWorkflowBindingModel, 'claimLaneEntry').mockResolvedValue({ created: false, entry });
    const started = jest.spyOn(WorkLaneWorkflowBindingModel, 'markStarted');

    await expect(LaneEntryAutomationService.handleTransition('task-1', 'todo')).resolves.toEqual({ created: false, entry });
    expect(started).not.toHaveBeenCalled();
  });

  it('leaves an explicit unautomated audit row without dispatching', async() => {
    const entry: any = { id: 'entry-2', workflow_id: null, generation: 2, status: 'unautomated' };
    jest.spyOn(WorkLaneWorkflowBindingModel, 'claimLaneEntry').mockResolvedValue({ created: true, entry });
    const started = jest.spyOn(WorkLaneWorkflowBindingModel, 'markStarted');

    await expect(LaneEntryAutomationService.handleTransition('task-1', 'manual')).resolves.toEqual({ created: true, entry });
    expect(started).not.toHaveBeenCalled();
  });
});
