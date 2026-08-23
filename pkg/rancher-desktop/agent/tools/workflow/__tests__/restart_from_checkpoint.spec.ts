import { jest } from '@jest/globals';

const mockFindCheckpointBefore = jest.fn<() => Promise<any>>();
const mockFindByNode = jest.fn<() => Promise<any>>();
const mockMarkRunning = jest.fn<() => Promise<void>>();

jest.unstable_mockModule('../../../database/models/WorkflowCheckpointModel', () => ({
  WorkflowCheckpointModel: {
    findCheckpointBefore: mockFindCheckpointBefore,
    findByNode:            mockFindByNode,
  },
}));

jest.unstable_mockModule('../../../database/models/WorkflowExecutionModel', () => ({
  WorkflowExecutionModel: {
    markRunning: mockMarkRunning,
  },
}));

let RestartFromCheckpointWorker: typeof import('../restart_from_checkpoint').RestartFromCheckpointWorker;

function checkpoint() {
  return {
    attributes: {
      node_label:     'Lenses Complete',
      playbook_state: {
        executionId:      'wfp-original',
        workflowId:       'core-routine-dream-about-human',
        status:           'running',
        definition:       { id: 'core-routine-dream-about-human', name: 'Dreaming About My Human' },
        currentNodeIds:   ['node-dah-prune'],
        completedNodeIds: ['node-dah-merge'],
        nodeOutputs:      { 'node-dah-merge': { result: 'done' } },
      },
    },
  };
}

describe('RestartFromCheckpointWorker', () => {
  beforeAll(async() => {
    ({ RestartFromCheckpointWorker } = await import('../restart_from_checkpoint'));
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockFindCheckpointBefore.mockResolvedValue(checkpoint());
    mockFindByNode.mockResolvedValue(null);
    mockMarkRunning.mockResolvedValue(undefined);
  });

  test('fails closed when a mutating restart has no graph state', async() => {
    const worker = new RestartFromCheckpointWorker();
    const result = await (worker as any)._validatedCall({
      executionId: 'wfp-original',
      nodeId:      'node-dah-prune',
    });

    expect(result.successBoolean).toBe(false);
    expect(result.responseString).toContain('No agent state available');
    expect(mockFindCheckpointBefore).not.toHaveBeenCalled();
    expect(mockMarkRunning).not.toHaveBeenCalled();
  });

  test('persists and attaches the exact restarted execution before success', async() => {
    const state: any = { metadata: {} };
    const worker = new RestartFromCheckpointWorker();
    worker.setState(state);

    const result = await (worker as any)._validatedCall({
      executionId: 'wfp-original',
      nodeId:      'node-dah-prune',
    });
    const response = JSON.parse(result.responseString);

    expect(result.successBoolean).toBe(true);
    expect(mockMarkRunning).toHaveBeenCalledWith(expect.objectContaining({
      executionId: response.executionId,
      workflowId:  'core-routine-dream-about-human',
    }));
    expect(state.metadata.activeWorkflow.executionId).toBe(response.executionId);
    expect(state.metadata.activeWorkflow.currentNodeIds).toContain('node-dah-prune');
  });

  test('does not claim success when execution persistence fails', async() => {
    mockMarkRunning.mockRejectedValue(new Error('database offline'));
    const state: any = { metadata: {} };
    const worker = new RestartFromCheckpointWorker();
    worker.setState(state);

    const result = await (worker as any)._validatedCall({
      executionId: 'wfp-original',
      nodeId:      'node-dah-prune',
    });

    expect(result.successBoolean).toBe(false);
    expect(result.responseString).toContain('database offline');
    expect(state.metadata.activeWorkflow).toBeUndefined();
  });
});
