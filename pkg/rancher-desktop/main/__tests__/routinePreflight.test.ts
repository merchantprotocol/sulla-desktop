import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const scan = jest.fn<(...args: any[]) => Promise<any>>();
const findActive = jest.fn<(...args: any[]) => Promise<any>>();
const admit = jest.fn<(...args: any[]) => Promise<any>>();
const graphExecute = jest.fn<(...args: any[]) => Promise<any>>();
const createGraph = jest.fn<(...args: any[]) => Promise<any>>();
const definition: any = {
  id: 'ready-prs', name: 'Ready PRs', concurrencyPolicy: 'forbid', auto_restart: false,
  preflight: { functionRef: 'ready-prs', inputs: { owner: 'example' } },
  nodes: [{ id: 'trigger', type: 'workflow', position: { x: 0, y: 0 }, data: { subtype: 'schedule', category: 'trigger', label: 'Schedule', config: {} } }], edges: [],
};
jest.unstable_mockModule('@pkg/main/ipcMain', () => ({ getIpcMainProxy: () => ({ handle: jest.fn() }) }));
jest.unstable_mockModule('@pkg/utils/logging', () => ({ default: { background: { log: jest.fn(), warn: jest.fn(), error: jest.fn() } } }));
jest.unstable_mockModule('@pkg/agent/services/RoutineConcurrencyPolicy', () => ({ RoutineConcurrencyPolicy: {} }));
jest.unstable_mockModule('@pkg/agent/database/models/WorkflowModel', () => ({ WorkflowModel: { findById: async() => ({ attributes: { definition } }) } }));
jest.unstable_mockModule('@pkg/agent/workflow/WorkflowRegistry', () => ({ getWorkflowRegistry: () => ({ loadWorkflow: async() => definition }) }));
jest.unstable_mockModule('@pkg/agent/database/models/WorkflowExecutionModel', () => ({ WorkflowExecutionModel: { findActiveByWorkflow: findActive, admitSingleton: admit } }));
jest.unstable_mockModule('@pkg/agent/tools/function/function_run', () => ({ runFunctionStructured: scan }));
jest.unstable_mockModule('@pkg/agent/services/GraphRegistry', () => ({ GraphRegistry: { getOrCreateAgentGraph: createGraph } }));
const { executeRoutine } = await import('../sullaRoutineTemplateEvents');
const { activateWorkflowOnState } = await import('@pkg/agent/tools/workflow/execute_workflow');

beforeEach(() => {
  jest.clearAllMocks();
  findActive.mockResolvedValue(null);
  admit.mockResolvedValue(undefined);
  graphExecute.mockResolvedValue(undefined);
  createGraph.mockResolvedValue({ graph: { execute: graphExecute }, state: { metadata: {}, messages: [] } });
});

describe('deterministic routine admission before all graph/model work', () => {
  it.each(['Scheduled trigger', 'Catch-up: missed trigger', ''])('empty queue creates no graph for %s', async(trigger) => {
    scan.mockResolvedValue({ successBoolean: true, outputs: { shouldRun: false, count: 0, ready_prs: [] } });
    await expect(executeRoutine(definition.id, trigger)).resolves.toMatchObject({ skipped: 'preflight_empty', executionId: '' });
    expect(scan).toHaveBeenCalledTimes(1);
    expect(admit).not.toHaveBeenCalled();
    expect(createGraph).not.toHaveBeenCalled();
    expect(graphExecute).not.toHaveBeenCalled();
  });

  it.each([undefined, {}, { shouldRun: 'true' }, { shouldRun: 0 }, []])('malformed result %j fails without AI', async(outputs) => {
    scan.mockResolvedValue({ successBoolean: true, outputs });
    await expect(executeRoutine(definition.id)).rejects.toThrow('Preflight failed closed');
    expect(admit).not.toHaveBeenCalled();
    expect(createGraph).not.toHaveBeenCalled();
    expect(graphExecute).not.toHaveBeenCalled();
  });

  it('runtime errors never create an agent', async() => {
    scan.mockRejectedValue(new Error('runtime offline'));
    await expect(executeRoutine(definition.id)).rejects.toThrow('runtime offline');
    expect(createGraph).not.toHaveBeenCalled();
    expect(admit).not.toHaveBeenCalled();
  });

  it('function failure remains closed even with shouldRun true', async() => {
    scan.mockResolvedValue({ successBoolean: false, outputs: { shouldRun: true } });
    await expect(executeRoutine(definition.id)).rejects.toThrow('Preflight failed closed');
    expect(createGraph).not.toHaveBeenCalled();
  });

  it('active runs bypass both scanning and graph creation', async() => {
    findActive.mockResolvedValue({ attributes: { execution_id: 'existing' } });
    await expect(executeRoutine(definition.id)).resolves.toMatchObject({ skipped: 'already_active' });
    expect(scan).not.toHaveBeenCalled();
    expect(createGraph).not.toHaveBeenCalled();
    expect(admit).not.toHaveBeenCalled();
  });

  it('the atomic singleton race loser creates no graph', async() => {
    scan.mockResolvedValue({ successBoolean: true, outputs: { shouldRun: true } });
    admit.mockRejectedValue(new Error('already admitted'));
    await expect(executeRoutine(definition.id)).rejects.toThrow('already admitted');
    expect(createGraph).not.toHaveBeenCalled();
  });

  it('passes the one verified scan unchanged to the sole admitted graph', async() => {
    const outputs = { shouldRun: true, count: 1, ready_prs: [{ number: 9, head_sha: 'abc', repository: 'frontend' }] };
    scan.mockResolvedValue({ successBoolean: true, outputs });
    await expect(executeRoutine(definition.id, 'scheduled')).resolves.toMatchObject({ workflowId: definition.id });
    expect(scan).toHaveBeenCalledTimes(1);
    expect(scan).toHaveBeenCalledWith({ slug: 'ready-prs', inputs: { owner: 'example' } });
    expect(admit).toHaveBeenCalledTimes(1);
    expect(createGraph).toHaveBeenCalledTimes(1);
    expect(graphExecute).toHaveBeenCalledTimes(1);
    const state = graphExecute.mock.calls[0][0];
    expect(JSON.parse(state.metadata.activeWorkflow.triggerInput)).toEqual({ trigger: 'scheduled', preflight: outputs });
  });

  it.each([{ force: true }, { allowConcurrent: true }, {}])('direct activation %j cannot bypass an empty queue', async(flags) => {
    scan.mockResolvedValue({ successBoolean: true, outputs: { shouldRun: false } });
    const state: any = { metadata: {}, messages: [] };
    await expect(activateWorkflowOnState(state, { workflowId: definition.id, ...flags })).resolves.toMatchObject({ skipped: 'preflight_empty' });
    expect(state.metadata.activeWorkflow).toBeUndefined();
    expect(admit).not.toHaveBeenCalled();
  });

  it.each([{ resume: true }, { resumeExecutionId: 'old' }, { startNodeId: 'worker' }])('rejects stale evidence replay %j', async(flags) => {
    const state: any = { metadata: {}, messages: [] };
    await expect(activateWorkflowOnState(state, { workflowId: definition.id, ...flags })).resolves.toMatchObject({ ok: false });
    expect(scan).not.toHaveBeenCalled();
    expect(admit).not.toHaveBeenCalled();
  });
});
