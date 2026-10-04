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
  acquireLease: jest.fn(async() => ({})), renewHeartbeat: jest.fn(async() => ({})), settle: jest.fn(async() => ({})), markSuspended: jest.fn(async() => undefined),
} }));
jest.unstable_mockModule('../../database/models/WorkflowCheckpointModel', () => ({ WorkflowCheckpointModel: { saveCheckpoint: jest.fn() } }));
const invokeTool = jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue({ success: true, result: 'browser verified' });
const createTool = jest.fn<(...args: any[]) => Promise<any>>().mockImplementation(() => Promise.resolve({ invoke: invokeTool }));
jest.unstable_mockModule('../../tools/registry', () => ({ toolRegistry: { createTool } }));
const loadWorkflow = jest.fn<(...args: any[]) => Promise<any>>();
jest.unstable_mockModule('../../workflow/WorkflowRegistry', () => ({ getWorkflowRegistry: () => ({ loadWorkflow }) }));
jest.unstable_mockModule('../../workflow/WorkflowPlaybook', () => ({
  createPlaybookState: jest.fn(), resolveDecision: jest.fn(),
  processNextStep: jest.fn((playbook: any) => ({ action: 'prompt_orchestrator', nodeId: 'slow', prompt: 'Do work', updatedPlaybook: playbook })),
  completeSubAgent: jest.fn((playbook: any) => ({ action: 'continue', updatedPlaybook: playbook })),
}));

const { PlaybookController } = await import('../PlaybookController');
const { WorkflowExecutionModel } = await import('../../database/models/WorkflowExecutionModel');
const { WorkflowCheckpointModel } = await import('../../database/models/WorkflowCheckpointModel');
const { processNextStep, createPlaybookState } = await import('../../workflow/WorkflowPlaybook');

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

describe('singleton worker lifecycle', () => {
  function setup() {
    const state: any = { messages: [], metadata: { activeWorkflow: {
      status: 'running', executionId: 'singleton-run', workflowId: 'singleton', completedNodeIds: [], currentNodeIds: ['worker'], nodeOutputs: {},
      definition: { concurrencyPolicy: 'forbid', name: 'Singleton', nodes: [{ id: 'worker', data: { label: 'Worker' } }], edges: [] },
    } } };
    const execute = jest.fn(async() => state);
    const controller: any = new PlaybookController({ execute, getEntryPoint: () => 'agent', getNode: () => null });
    controller.emitPlaybookEvent = jest.fn();
    controller.emitEdgeActivations = jest.fn();
    controller.isLockedCoreRoutine = jest.fn(async() => false);
    controller.executeSubAgentWithRetry = jest.fn();
    controller.executeSubAgent = jest.fn();
    (WorkflowExecutionModel.renewHeartbeat as any).mockResolvedValue({});
    return { state, controller, execute };
  }

  it('holds admission after a failed parent when a worker timed out and may still be running', async() => {
    const { state, controller } = setup();
    // A worker was launched and its stop was never confirmed (it timed out).
    controller.unconfirmedWorkers.set('singleton-run', 1);
    await controller.releaseWorkflow(state, state.metadata.activeWorkflow, 'failed', 'Worker timeout');
    expect(WorkflowExecutionModel.markSuspended).toHaveBeenCalledWith('singleton-run');
    expect(WorkflowExecutionModel.settle).not.toHaveBeenCalled();
    expect(state.metadata.lastCompletedWorkflow.outcome).toBe('failed');
    expect(controller.hasUnconfirmedWorkers()).toBe(true);
  });

  it('settles a failed singleton that never left a worker running, so the next scheduled run is admitted', async() => {
    const { state, controller } = setup();
    // e.g. a provider error before/without launching any worker. Suspending
    // here used to block the routine's schedule forever with no notice.
    await controller.releaseWorkflow(state, state.metadata.activeWorkflow, 'failed', 'LLM provider unavailable');
    expect(WorkflowExecutionModel.settle).toHaveBeenCalledWith('singleton-run', 'failed', 'LLM provider unavailable');
    expect(WorkflowExecutionModel.markSuspended).not.toHaveBeenCalled();
  });

  it('confirms a worker stopped when its turn returns or it throws, but not on a timeout', async() => {
    const { state, controller } = setup();
    controller.executeSubAgentUntracked = jest.fn()
      .mockResolvedValueOnce({ output: 'ok', contractStatus: 'done' } as never)
      .mockRejectedValueOnce(new Error('worker crashed') as never)
      .mockRejectedValueOnce(new Error('Sub-agent timed out after 600s') as never);
    delete controller.executeSubAgent; // use the real tracking wrapper
    const run = () => (PlaybookController.prototype as any).executeSubAgent.call(controller, state, 'w', 'a', 'p', {});

    await run();
    await expect(run()).rejects.toThrow('crashed');
    expect(controller.unconfirmedWorkers.get('singleton-run') ?? 0).toBe(0);
    await expect(run()).rejects.toThrow('timed out');
    expect(controller.unconfirmedWorkers.get('singleton-run')).toBe(1);
  });

  it('refuses successful release while a child is pending', async() => {
    const { state, controller } = setup();
    controller.pendingSubAgents.set('worker', { nodeId: 'worker' });
    await controller.releaseWorkflow(state, state.metadata.activeWorkflow, 'completed');
    expect(WorkflowExecutionModel.markSuspended).toHaveBeenCalledWith('singleton-run');
    expect(WorkflowExecutionModel.settle).not.toHaveBeenCalled();
    expect(state.metadata.lastCompletedWorkflow.error).toContain('sub-agent may still be running');
  });

  it('releases a successfully completed run when no worker remains', async() => {
    const { state, controller } = setup();
    await controller.releaseWorkflow(state, state.metadata.activeWorkflow, 'completed');
    expect(WorkflowExecutionModel.settle).toHaveBeenCalledWith('singleton-run', 'completed', undefined, undefined);
    expect(WorkflowExecutionModel.markSuspended).not.toHaveBeenCalled();
  });

  it('rejects multiple generated PROMPT tasks before launching any worker', async() => {
    const { state, controller, execute } = setup();
    execute.mockImplementationOnce(async() => {
      state.messages.push({ role: 'assistant', content: '<PROMPT>First PR</PROMPT><PROMPT>Second PR</PROMPT>' });
      return state;
    });
    (processNextStep as any).mockImplementationOnce((playbook: any) => ({ action: 'spawn_sub_agent', nodeId: 'worker', agentId: 'sulla-desktop', prompt: 'One PR', config: { maxAgents: 1 }, updatedPlaybook: playbook }));
    await controller.processWorkflowPlaybook(state);
    expect(controller.executeSubAgentWithRetry).not.toHaveBeenCalled();
    expect(controller.executeSubAgent).not.toHaveBeenCalled();
    // No worker was launched, so nothing can still be running: fail cleanly
    // instead of holding admission.
    expect(WorkflowExecutionModel.settle).toHaveBeenCalledWith('singleton-run', 'failed', expect.any(String));
    expect(WorkflowExecutionModel.markSuspended).not.toHaveBeenCalled();
  });

  it.each(['One plain task', '<PROMPT>One tagged task</PROMPT>'])('uses one tracked non-retried worker for %s', async(content) => {
    const { state, controller, execute } = setup();
    execute.mockImplementationOnce(async() => {
      state.messages.push({ role: 'assistant', content });
      return state;
    });
    (processNextStep as any).mockImplementationOnce((playbook: any) => ({ action: 'spawn_sub_agent', nodeId: 'worker', agentId: 'sulla-desktop', prompt: 'One PR', config: { maxAgents: 1 }, updatedPlaybook: playbook }));
    await controller.processWorkflowPlaybook(state);
    expect(controller.executeSubAgentWithRetry).toHaveBeenCalledTimes(1);
    expect(controller.executeSubAgentWithRetry.mock.calls[0][6]).toBe(1);
    expect(controller.executeSubAgentWithRetry.mock.calls[0][3]).toContain(content.includes('tagged') ? 'One tagged task' : 'One plain task');
    expect(controller.pendingSubAgents.size).toBe(1);
    expect(controller.executeSubAgent).not.toHaveBeenCalled();
    controller.workflowLease.heartbeat.stop();
  });

  it.each([
    ['spawn_sub_workflow', true], ['spawn_sub_workflow', false],
    ['transfer_workflow', true], ['transfer_workflow', false],
  ])('rejects unguarded %s with source singleton=%s', async(action, sourceSingleton) => {
    const { state, controller } = setup();
    if (!sourceSingleton) delete state.metadata.activeWorkflow.definition.concurrencyPolicy;
    loadWorkflow.mockResolvedValue({ id: 'target', name: 'Target', concurrencyPolicy: sourceSingleton ? undefined : 'forbid', nodes: [], edges: [] });
    (processNextStep as any).mockImplementationOnce((playbook: any) => ({ action, nodeId: 'worker', workflowId: 'target', targetWorkflowId: 'target', updatedPlaybook: playbook }));
    await controller.processWorkflowPlaybook(state);
    expect(createPlaybookState).not.toHaveBeenCalled();
    expect(controller.executeSubAgent).not.toHaveBeenCalled();
    expect(state.metadata.lastCompletedWorkflow.outcome).toBe('failed');
    expect(state.metadata.lastCompletedWorkflow.error).toContain('normal admission');
  });
});

describe('native tool graph custody', () => {
  it('creates a fresh tool and passes the exact owning graph state', async() => {
    const state: any = {
      messages: [],
      metadata: {
        threadId:       'owned-graph',
        activeWorkflow: {
          status:           'running',
          executionId:      'native-run',
          workflowId:       'native',
          completedNodeIds: [],
          currentNodeIds:   ['tool'],
          nodeOutputs:      {},
          definition:       { name: 'Native', nodes: [{ id: 'tool', data: { label: 'Browser', subtype: 'tool-call' } }], edges: [] },
        },
      },
    };
    const params = { tool: 'tab', args: { url: 'about:blank', active: false } };
    (WorkflowExecutionModel.renewHeartbeat as any).mockResolvedValue({});
    (processNextStep as any)
      .mockImplementationOnce((playbook: any) => ({ action: 'execute_tool_call', nodeId: 'tool', toolName: 'browser_controller', params, updatedPlaybook: playbook }))
      .mockImplementationOnce((playbook: any) => ({ action: 'workflow_completed', updatedPlaybook: playbook }));
    const controller: any = new PlaybookController({ execute: () => Promise.resolve(state), getEntryPoint: () => 'agent', getNode: () => null });
    controller.emitPlaybookEvent = jest.fn();
    controller.emitEdgeActivations = jest.fn();
    await controller.processWorkflowPlaybook(state);
    expect(createTool).toHaveBeenCalledWith('browser_controller');
    expect(invokeTool).toHaveBeenCalledWith(params, state);
  });
});
