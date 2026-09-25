import { afterEach, describe, expect, it, jest } from '@jest/globals';

import type { WorkflowDefinition } from '@pkg/pages/editor/workflow/types';

const findActiveByLaneScope = jest.fn<(...args: any[]) => Promise<any>>();
const findByExecution = jest.fn<(...args: any[]) => Promise<any>>();
const recentExecutions = jest.fn<(...args: any[]) => Promise<any>>();
jest.unstable_mockModule('../../../database/models/WorkflowCheckpointModel', () => ({ WorkflowCheckpointModel: { findByExecution, recentExecutions } }));
const admitSingleton = jest.fn<(...args: any[]) => Promise<void>>();
const markRunning = jest.fn<(...args: any[]) => Promise<void>>();

jest.unstable_mockModule('../../../database/models/WorkflowExecutionModel', () => ({
  WorkflowExecutionModel: {
    findActiveByLaneScope,
    findActiveByWorkflow: jest.fn(),
    markFailed:           jest.fn(),
    markRunning,
    admitSingleton,
  },
}));

async function activate(input: any, state: any) {
  const { activateWorkflowOnState } = await import('../execute_workflow');
  return activateWorkflowOnState(state, input);
}

const snapshot: WorkflowDefinition = {
  id:          'workflow-snapshot',
  name:        'Immutable snapshot',
  description: 'Captured before the source row changed',
  version:     1,
  createdAt:   '2026-08-24T00:00:00.000Z',
  updatedAt:   '2026-08-24T00:00:00.000Z',
  nodes:       [{
    id:       'trigger',
    type:     'workflow',
    position: { x: 0, y: 0 },
    data:     { category: 'trigger', subtype: 'manual', label: 'Lane entry', config: {} },
  }],
  edges: [],
};

describe('activateWorkflowOnState lane scope', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('activates the supplied immutable snapshot without loading mutable workflow state', async() => {
    findActiveByLaneScope.mockResolvedValue(null);
    markRunning.mockResolvedValue();
    const state: any = { metadata: { scopedWorkflowId: snapshot.id }, messages: [] };

    await expect(activate({
      workflowId:         snapshot.id,
      definitionSnapshot: snapshot,
      executionScope:     { taskId: 'task-1', generation: 2 },
      executionId:        'lane-exec-task-1-2',
      message:            'lane payload',
    }, state)).resolves.toMatchObject({ ok: true });
    expect(state.metadata.activeWorkflow).toMatchObject({
      executionId: 'lane-exec-task-1-2',
      definition:  snapshot,
    });
    expect(markRunning).toHaveBeenCalledWith(expect.objectContaining({
      workflowId:      snapshot.id,
      scopeTaskId:     'task-1',
      scopeGeneration: 2,
    }));
  });

  it('rejects a duplicate active task-generation before creating another playbook', async() => {
    findActiveByLaneScope.mockResolvedValue({
      attributes: { execution_id: 'lane-exec-task-1-2', status: 'running' },
    });
    const state: any = { metadata: { scopedWorkflowId: snapshot.id }, messages: [] };

    await expect(activate({
      workflowId:         snapshot.id,
      definitionSnapshot: snapshot,
      executionScope:     { taskId: 'task-1', generation: 2 },
      executionId:        'duplicate',
    }, state)).resolves.toMatchObject({ ok: false });
    expect(markRunning).not.toHaveBeenCalled();
    expect(state.metadata.activeWorkflow).toBeUndefined();
  });
});


describe('singleton admission', () => {
  afterEach(() => { jest.clearAllMocks(); });
  it.each([{}, { force: true }, { allowConcurrent: true }, { startNodeId: 'trigger' }])('fails closed before state mutation for %j', async(flags) => {
    admitSingleton.mockRejectedValue(new Error('active execution'));
    const state: any = { metadata: {}, messages: [] };
    const result = await activate({ workflowId: snapshot.id, definitionSnapshot: { ...snapshot, concurrencyPolicy: 'forbid' }, ...flags }, state);
    expect(result.ok).toBe(false);
    expect(result.responseString).toContain('active execution');
    expect(state.metadata.activeWorkflow).toBeUndefined();
    expect(markRunning).not.toHaveBeenCalled();
  });
  it.each([{ resume: true }, { resumeExecutionId: 'prior' }])('does not publish a resumed checkpoint when admission fails for %j', async(flags) => {
    const checkpoint = { attributes: { playbook_state: { definition: snapshot, executionId: 'prior', status: 'running', completedNodeIds: [], currentNodeIds: ['trigger'] } } };
    findByExecution.mockResolvedValue([checkpoint]);
    recentExecutions.mockResolvedValue([checkpoint]);
    admitSingleton.mockRejectedValue(new Error('database unavailable'));
    const state: any = { metadata: {}, messages: [] };
    const result = await activate({ workflowId: snapshot.id, definitionSnapshot: { ...snapshot, concurrencyPolicy: 'forbid' }, ...flags }, state);
    expect(result.ok).toBe(false);
    expect(result.responseString).toContain('database unavailable');
    expect(state.metadata.activeWorkflow).toBeUndefined();
  });
  it('publishes state only after durable admission and records a single execution', async() => {
    const state: any = { metadata: {}, messages: [] };
    admitSingleton.mockImplementation(async() => { expect(state.metadata.activeWorkflow).toBeUndefined(); });
    const result = await activate({ workflowId: snapshot.id, definitionSnapshot: { ...snapshot, concurrencyPolicy: 'forbid' } }, state);
    expect(result.ok).toBe(true);
    expect(admitSingleton).toHaveBeenCalledTimes(1);
    expect(markRunning).not.toHaveBeenCalled();
    expect(state.metadata.activeWorkflow.definition.concurrencyPolicy).toBe('forbid');
  });
});
