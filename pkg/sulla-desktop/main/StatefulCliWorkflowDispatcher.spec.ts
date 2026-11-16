import { describe, expect, it, vi } from 'vitest';

vi.mock('@pkg/agent/database/models/WorkflowExecutionModel', () => ({ WorkflowExecutionModel: { markFailed: vi.fn() } }));
vi.mock('@pkg/agent/services/GraphRegistry', () => ({ GraphRegistry: { getOrCreateAgentGraph: vi.fn(), delete: vi.fn() } }));

import { StatefulCliWorkflowDispatcher, type StatefulWorkflowCollaborators } from './statefulCliWorkflowTool';

class FakeTool {
  schemaDef: Record<string, unknown> = {};
  name = '';
  description = '';
  metadata: Record<string, unknown> = {};
  state: Record<string, any> = {};
  static result: any = { success: true };
  static onCall: (state: Record<string, any>) => void = () => undefined;
  setState(state: Record<string, any>) { this.state = state }
  async call(_params: Record<string, unknown>) { FakeTool.onCall(this.state); return FakeTool.result }
}

function setup(execute: () => Promise<unknown> = async () => undefined) {
  const state: Record<string, any> = {};
  const deps: StatefulWorkflowCollaborators = {
    getOrCreateAgentGraph: vi.fn(async () => ({ graph: { execute: vi.fn(execute) }, state })),
    deleteGraph:           vi.fn(),
    markExecutionFailed:   vi.fn(async () => undefined),
    invocationId:          () => 'inv-1',
  };

  return { deps, state, dispatcher: new StatefulCliWorkflowDispatcher(deps) };
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

describe('StatefulCliWorkflowDispatcher', () => {
  it('dispatches execute_workflow and full restart_from_checkpoint calls only', () => {
    const { dispatcher } = setup();

    expect(dispatcher.needsDispatch('execute_workflow', {})).toBe(true);
    expect(dispatcher.needsDispatch('restart_from_checkpoint', { executionId: 'e', nodeId: 'n' })).toBe(true);
    expect(dispatcher.needsDispatch('restart_from_checkpoint', { executionId: 'e' })).toBe(false);
    expect(dispatcher.needsDispatch('list_checkpoints', {})).toBe(false);
  });

  // risk: state isolation — the cached tool must not receive this call's graph state
  it('binds a fresh tool copy and frees the graph when no workflow became active', async () => {
    const { deps, dispatcher } = setup();
    const cached = Object.assign(new FakeTool(), { name: 'execute_workflow', metadata: { a: 1 } });

    FakeTool.result = { success: true };
    FakeTool.onCall = () => undefined;
    expect(await dispatcher.call(cached, 'execute_workflow', {})).toEqual({ success: true });
    expect(cached.state).toEqual({});
    expect(deps.getOrCreateAgentGraph).toHaveBeenCalledWith('sulla-desktop', 'inv-1');
    expect(deps.deleteGraph).toHaveBeenCalledWith('inv-1');
  });

  // risk: data accuracy — a detached graph failure marks the execution failed and frees the graph
  it('runs the detached graph and marks the execution failed when it throws', async () => {
    const { deps, dispatcher } = setup(async () => { throw new Error('boom') });

    FakeTool.result = { success: true };
    FakeTool.onCall = (state) => { state.metadata = { activeWorkflow: { executionId: 'exec-9' } } };
    await dispatcher.call(new FakeTool(), 'execute_workflow', {});
    await tick();
    expect(deps.markExecutionFailed).toHaveBeenCalledWith('exec-9', 'detached_graph_failed: boom');
    expect(deps.deleteGraph).toHaveBeenCalledWith('inv-1');
  });
});
