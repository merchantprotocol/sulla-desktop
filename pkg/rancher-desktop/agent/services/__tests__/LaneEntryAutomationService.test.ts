import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { WorkLaneWorkflowBindingModel } from '../../database/models/WorkLaneWorkflowBindingModel';
import { getProjectsApplicationService } from '../../projects/application/ProjectsApplicationService';
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

  it('executes the claimed immutable snapshot with task-generation identity and exact settlement', async() => {
    const entry: any = {
      id:                'entry-3',
      task_id:           'task-1',
      workflow_id:       'wf-1',
      generation:        3,
      lane_key:          'todo',
      status:            'pending',
      actor:             'heartbeat',
      binding_snapshot:  { lane_contract: { input: 'project.lane-entry.v1' } },
      workflow_snapshot: { id: 'wf-1', name: 'Snapshot revision 1', revision: 1, nodes: [], edges: [] },
    };
    const running = { ...entry, status: 'running', execution_id: 'lane-exec-task-1-3' };
    jest.spyOn(WorkLaneWorkflowBindingModel, 'getLaneEntry')
      .mockResolvedValueOnce(entry)
      .mockResolvedValueOnce(running);
    jest.spyOn(WorkLaneWorkflowBindingModel, 'markStarted').mockResolvedValue(running);
    const settled = jest.spyOn(WorkLaneWorkflowBindingModel, 'markOutcome').mockResolvedValue({
      ...running, status: 'completed',
    });
    const execute = jest.spyOn(LaneEntryAutomationService as any, 'executeRoutine')
      .mockImplementation(async(...args: unknown[]) => {
        const options = args[2] as any;
        await options.onSettled({ executionId: 'lane-exec-task-1-3', status: 'completed' });
        return { executionId: 'lane-exec-task-1-3', workflowId: 'wf-1' };
      });

    await expect(LaneEntryAutomationService.dispatchEntry('entry-3')).resolves.toMatchObject({
      execution_id: 'lane-exec-task-1-3', status: 'running',
    });
    expect(execute).toHaveBeenCalledWith('wf-1', expect.any(String), expect.objectContaining({
      definitionSnapshot: entry.workflow_snapshot,
      executionScope:     { taskId: 'task-1', generation: 3 },
      executionId:        'lane-exec-task-1-3',
    }));
    expect(settled).toHaveBeenCalledWith(
      'entry-3', 'lane-exec-task-1-3', 'completed', {
        disposition: 'completed', workflowOutcome: {}, transitionReceipt: null,
      });
  });

  it('applies a structured next-stage outcome against the exact claimed generation', async() => {
    const entry: any = {
      id: 'entry-next', task_id: 'task-1', workflow_id: 'wf-1', generation: 4,
      lane_key: 'research', status: 'pending', binding_snapshot: {}, workflow_snapshot: { id: 'wf-1' },
    };
    jest.spyOn(WorkLaneWorkflowBindingModel, 'getLaneEntry')
      .mockResolvedValueOnce(entry).mockResolvedValueOnce({ ...entry, status: 'running' });
    jest.spyOn(WorkLaneWorkflowBindingModel, 'markStarted').mockResolvedValue({ ...entry, status: 'running' });
    const settled = jest.spyOn(WorkLaneWorkflowBindingModel, 'markOutcome').mockResolvedValue({ ...entry, status: 'completed' });
    const transition = jest.spyOn(getProjectsApplicationService(), 'transitionTaskRelative').mockResolvedValue({
      task: {} as any, fromStage: 'research', toStage: 'publish', stagePosition: 2, previousGeneration: 4,
    });
    jest.spyOn(LaneEntryAutomationService as any, 'executeRoutine').mockImplementation(async(...args: unknown[]) => {
      await (args[2] as any).onSettled({
        executionId: 'lane-exec-task-1-4', status: 'completed', outcome: { transition: { mode: 'next' } },
      });
      return { executionId: 'lane-exec-task-1-4', workflowId: 'wf-1' };
    });

    await LaneEntryAutomationService.dispatchEntry('entry-next');
    expect(transition).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'task-1', direction: 'next', expectedGeneration: 4,
    }), { actor: 'sulla', source: 'routine' });
    expect(settled).toHaveBeenCalledWith('entry-next', 'lane-exec-task-1-4', 'completed',
      expect.objectContaining({ transitionReceipt: expect.objectContaining({ toStage: 'publish' }) }));
  });

  it('retries a committed pending outbox row once', async() => {
    const entry: any = { id: 'entry-4', status: 'pending', workflow_id: 'wf-1' };
    jest.spyOn(WorkLaneWorkflowBindingModel, 'listRecoverable').mockResolvedValue([entry]);
    const dispatch = jest.spyOn(LaneEntryAutomationService, 'dispatchEntry').mockResolvedValue({
      ...entry, status: 'running',
    });

    await expect(LaneEntryAutomationService.drainRecoverable()).resolves.toHaveLength(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith('entry-4');
  });

  it('reclaims an interrupted scoped execution during boot recovery', async() => {
    const interrupted: any = {
      id:                        'entry-5',
      status:                    'running',
      workflow_id:               'wf-1',
      execution_id:              'lane-exec-task-5-1',
      workflow_execution_status: 'running',
    };
    jest.spyOn(WorkLaneWorkflowBindingModel, 'listRecoverable').mockResolvedValue([interrupted]);
    const reset = jest.spyOn(WorkLaneWorkflowBindingModel, 'resetInterruptedExecution').mockResolvedValue({
      ...interrupted, status: 'pending', execution_id: null,
    });
    const dispatch = jest.spyOn(LaneEntryAutomationService, 'dispatchEntry').mockResolvedValue({
      ...interrupted, status: 'running',
    });

    await expect(LaneEntryAutomationService.drainRecoverable(50, true)).resolves.toHaveLength(1);
    expect(reset).toHaveBeenCalledWith('entry-5', 'lane-exec-task-5-1');
    expect(dispatch).toHaveBeenCalledWith('entry-5');
  });
});
