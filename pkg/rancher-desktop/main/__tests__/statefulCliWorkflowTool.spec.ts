import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockExecute = jest.fn<() => Promise<void>>();
const mockDelete = jest.fn();
const mockGetGraph = jest.fn<() => Promise<any>>();
const mockMarkFailed = jest.fn<(executionId: string, error: string) => Promise<void>>();

jest.unstable_mockModule('@pkg/agent/services/GraphRegistry', () => ({
  GraphRegistry: {
    getOrCreateAgentGraph: mockGetGraph,
    delete:                mockDelete,
  },
}));

jest.unstable_mockModule('@pkg/agent/database/models/WorkflowExecutionModel', () => ({
  WorkflowExecutionModel: {
    markFailed: mockMarkFailed,
  },
}));

let callStatefulWorkflowTool: typeof import('../statefulCliWorkflowTool').callStatefulWorkflowTool;
let needsStatefulWorkflowDispatch: typeof import('../statefulCliWorkflowTool').needsStatefulWorkflowDispatch;

class FakeTool {
  schemaDef = {};
  name = 'execute_workflow';
  description = 'test';
  metadata = {};
  state: any;
  success = true;

  setState(state: any) { this.state = state }
  call() {
    if (this.success) {
      this.state.metadata.activeWorkflow = { executionId: 'wfp-detached' };
    }
    return Promise.resolve({ success: this.success });
  }
}

describe('stateful CLI workflow dispatch', () => {
  beforeAll(async() => {
    ({ callStatefulWorkflowTool, needsStatefulWorkflowDispatch } = await import('../statefulCliWorkflowTool'));
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockExecute.mockResolvedValue(undefined);
    mockMarkFailed.mockResolvedValue(undefined);
    mockGetGraph.mockResolvedValue({
      graph: { execute: mockExecute },
      state: { metadata: {} },
    });
  });

  it('only binds mutating workflow calls', () => {
    expect(needsStatefulWorkflowDispatch('execute_workflow', {})).toBe(true);
    expect(needsStatefulWorkflowDispatch('restart_from_checkpoint', { executionId: 'wfp', nodeId: 'node' })).toBe(true);
    expect(needsStatefulWorkflowDispatch('restart_from_checkpoint', { executionId: 'wfp' })).toBe(false);
  });

  it('uses a fresh worker, launches the graph, and cleans up on completion', async() => {
    const cached = new FakeTool();
    const result = await callStatefulWorkflowTool(cached, 'execute_workflow', {});

    expect(result.success).toBe(true);
    expect(cached.state).toBeUndefined();
    expect(mockExecute).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(mockDelete).toHaveBeenCalledTimes(1);
  });

  it('does not launch a failed tool and removes the detached graph', async() => {
    class FailingTool extends FakeTool {
      success = false;
    }
    await callStatefulWorkflowTool(new FailingTool(), 'execute_workflow', {});

    expect(mockExecute).not.toHaveBeenCalled();
    expect(mockDelete).toHaveBeenCalledTimes(1);
  });

  it('marks the execution failed and cleans up when the graph rejects', async() => {
    mockExecute.mockRejectedValue(new Error('graph exploded'));
    await callStatefulWorkflowTool(new FakeTool(), 'execute_workflow', {});
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(mockMarkFailed).toHaveBeenCalledWith('wfp-detached', expect.stringContaining('graph exploded'));
    expect(mockDelete).toHaveBeenCalledTimes(1);
  });
});
