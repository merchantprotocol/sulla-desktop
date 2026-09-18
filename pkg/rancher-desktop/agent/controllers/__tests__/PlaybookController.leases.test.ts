/** @jest-environment node */
import { afterEach, describe, expect, it, jest } from '@jest/globals';

jest.unstable_mockModule('fs', () => ({ appendFileSync: jest.fn() }));
jest.unstable_mockModule('../../services/ConversationLogger', () => ({ getConversationLogger: jest.fn() }));
jest.unstable_mockModule('../../services/WebSocketClientService', () => ({ getWebSocketClientService: jest.fn(() => ({ send: jest.fn() })) }));
jest.unstable_mockModule('../../database/models/ChatMessageModel', () => ({ ChatMessageModel: {} }));
jest.unstable_mockModule('../../workflow/lockedCoreRoutineExecution', () => ({ inheritSubAgentToolPolicy: jest.fn(), lockedCoreBlockedError: jest.fn(), resolveAgentTaskForDispatch: jest.fn() }));
jest.unstable_mockModule('../../database/RedisClient', () => ({ redisClient: { get: jest.fn(async() => null) } }));
jest.unstable_mockModule('../../tools/workflow/stop_workflow', () => ({ stopKey: () => 'stop' }));
jest.unstable_mockModule('../../tools/workflow/pause_workflow', () => ({ pauseKey: () => 'pause' }));
jest.unstable_mockModule('../../database/models/WorkflowPendingCompletionModel', () => ({ WorkflowPendingCompletionModel: { findPending: jest.fn(async() => []) } }));
jest.unstable_mockModule('../../database/models/WorkflowExecutionModel', () => ({ WorkflowExecutionModel: {
  acquireLease: jest.fn(async() => ({})), renewHeartbeat: jest.fn(async() => ({})), settle: jest.fn(async() => ({})),
} }));
jest.unstable_mockModule('../../database/models/WorkflowCheckpointModel', () => ({ WorkflowCheckpointModel: { saveCheckpoint: jest.fn() } }));
jest.unstable_mockModule('../../workflow/WorkflowPlaybook', () => ({
  createPlaybookState: jest.fn(), resolveDecision: jest.fn(),
  processNextStep: jest.fn((playbook: any) => ({ action: 'prompt_orchestrator', nodeId: 'slow', prompt: 'Do work', updatedPlaybook: playbook })),
  completeSubAgent: jest.fn((playbook: any) => ({ action: 'continue', updatedPlaybook: playbook })),
}));

const { PlaybookController } = await import('../PlaybookController');
const { WorkflowExecutionModel } = await import('../../database/models/WorkflowExecutionModel');
const { WorkflowCheckpointModel } = await import('../../database/models/WorkflowCheckpointModel');
const { processNextStep } = await import('../../workflow/WorkflowPlaybook');

afterEach(() => { jest.useRealTimers(); jest.clearAllMocks(); });

describe('PlaybookController lease fencing', () => {
  it('acquires fresh ownership for a resumed checkpoint and releases the heartbeat on completion', async() => {
    jest.useFakeTimers();
    (WorkflowExecutionModel.renewHeartbeat as any).mockResolvedValue({});
    (processNextStep as any).mockImplementationOnce((playbook: any) => ({ action: 'workflow_completed', updatedPlaybook: playbook }));
    const state: any = { messages: [], metadata: { activeWorkflow: {
      status: 'running', executionId: 'resumed', workflowId: 'custom', completedNodeIds: [], currentNodeIds: [], nodeOutputs: {},
      _leaseOwner: 'old-runtime', _leaseToken: 'old-checkpoint-token',
      definition: { name: 'Resumed', nodes: [], edges: [] },
    } } };
    const controller: any = new PlaybookController({ execute: async() => state, getEntryPoint: () => 'agent', getNode: () => null });
    controller.emitPlaybookEvent = jest.fn();
    controller.emitEdgeActivations = jest.fn();
    await controller.processWorkflowPlaybook(state);
    expect(WorkflowExecutionModel.acquireLease).toHaveBeenCalledWith('resumed', expect.stringContaining('runtime-'), 60000, expect.any(String));
    expect((WorkflowExecutionModel.acquireLease as any).mock.calls[0][3]).not.toBe('old-checkpoint-token');
    expect(WorkflowExecutionModel.settle).toHaveBeenCalledWith('resumed', 'completed', undefined, undefined);
    expect(state.metadata.activeWorkflow).toBeUndefined();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('renews during a long node and rejects its late output after external settlement', async() => {
    jest.useFakeTimers();
    let finish!: () => void;
    const abort = jest.fn();
    const state: any = { messages: [], metadata: { options: { abort: { abort } }, activeWorkflow: {
      status: 'running', executionId: 'long-node', workflowId: 'custom', completedNodeIds: [], currentNodeIds: ['slow'], nodeOutputs: {},
      definition: { name: 'Custom', nodes: [{ id: 'slow', data: { label: 'Slow' } }], edges: [] },
    } } };
    const execute = jest.fn(async() => {
      await new Promise<void>(resolve => { finish = resolve; });
      state.messages.push({ role: 'assistant', content: 'A substantive result from the slow node.' });
      return state;
    });
    const controller: any = new PlaybookController({ execute, getEntryPoint: () => 'agent', getNode: () => null });
    controller.emitPlaybookEvent = jest.fn();
    controller.emitEdgeActivations = jest.fn();
    const running = controller.processWorkflowPlaybook(state);
    await jest.advanceTimersByTimeAsync(0);
    expect(execute).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(180_000);
    expect(WorkflowExecutionModel.renewHeartbeat).toHaveBeenCalledTimes(13);
    (WorkflowExecutionModel.renewHeartbeat as any).mockResolvedValue(null);
    await jest.advanceTimersByTimeAsync(15_000);
    expect(abort).toHaveBeenCalledTimes(1);
    finish();
    await running;
    expect(WorkflowCheckpointModel.saveCheckpoint).not.toHaveBeenCalled();
    expect(WorkflowExecutionModel.settle).not.toHaveBeenCalled();
    expect(processNextStep).toHaveBeenCalledTimes(1);
    expect(state.metadata.activeWorkflow.status).toBe('failed');
    expect(jest.getTimerCount()).toBe(0);
  });
});
