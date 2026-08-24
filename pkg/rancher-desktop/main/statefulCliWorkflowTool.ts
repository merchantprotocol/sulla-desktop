import { WorkflowExecutionModel } from '@pkg/agent/database/models/WorkflowExecutionModel';
import { GraphRegistry } from '@pkg/agent/services/GraphRegistry';

interface StatefulTool {
  schemaDef:   Record<string, unknown>;
  name:        string;
  description: string;
  metadata:    Record<string, unknown>;
  setState:    (state: Record<string, any>) => void;
  call:        (params: Record<string, unknown>) => Promise<any>;
}

export function needsStatefulWorkflowDispatch(toolName: string, params: Record<string, unknown>): boolean {
  return toolName === 'execute_workflow' ||
    (toolName === 'restart_from_checkpoint' && Boolean(params.executionId && params.nodeId));
}

export async function callStatefulWorkflowTool(
  tool: StatefulTool,
  toolName: string,
  params: Record<string, unknown>,
): Promise<any> {
  const invocationId = `cli-${ toolName }-${ Date.now().toString(36) }-${ Math.random().toString(36).slice(2, 8) }`;
  const graphResult = await GraphRegistry.getOrCreateAgentGraph('sulla-desktop', invocationId);
  const graph = graphResult.graph as { execute: (state: unknown) => Promise<unknown> };
  const state = graphResult.state as Record<string, any>;

  // Registry workers are cached. A fresh instance prevents graph state from
  // leaking into another concurrent CLI call.
  const ToolConstructor = tool.constructor as new () => StatefulTool;
  const boundTool = new ToolConstructor();
  boundTool.schemaDef = tool.schemaDef;
  boundTool.name = tool.name;
  boundTool.description = tool.description;
  boundTool.metadata = { ...tool.metadata };
  boundTool.setState(state);

  const result = await boundTool.call(params);
  const activeExecutionId = state.metadata?.activeWorkflow?.executionId as string | undefined;
  if (!result.success || !activeExecutionId) {
    GraphRegistry.delete(invocationId);
    return result;
  }

  graph.execute(state)
    .catch(async(err) => {
      await WorkflowExecutionModel.markFailed(activeExecutionId, `detached_graph_failed: ${ err instanceof Error ? err.message : String(err) }`);
    })
    .finally(() => GraphRegistry.delete(invocationId));

  return result;
}
