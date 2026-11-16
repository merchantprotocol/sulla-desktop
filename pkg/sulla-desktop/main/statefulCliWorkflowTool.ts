// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { WorkflowExecutionModel } from '@pkg/agent/database/models/WorkflowExecutionModel';
import { GraphRegistry } from '@pkg/agent/services/GraphRegistry';

export interface StatefulTool {
  schemaDef:   Record<string, unknown>;
  name:        string;
  description: string;
  metadata:    Record<string, unknown>;
  setState:    (state: Record<string, any>) => void;
  call:        (params: Record<string, unknown>) => Promise<any>;
}

/** The graph registry and execution store the dispatcher needs; defaults are the agent singletons. */
export interface StatefulWorkflowCollaborators {
  getOrCreateAgentGraph(channel: string, invocationId: string): Promise<{ graph: unknown; state: unknown }>;
  deleteGraph(invocationId: string): void;
  markExecutionFailed(executionId: string, reason: string): Promise<unknown>;
  invocationId(toolName: string): string;
}

const agentCollaborators: StatefulWorkflowCollaborators = {
  getOrCreateAgentGraph: (channel, invocationId) => GraphRegistry.getOrCreateAgentGraph(channel, invocationId),
  deleteGraph:           invocationId => { GraphRegistry.delete(invocationId) },
  markExecutionFailed:   (executionId, reason) => WorkflowExecutionModel.markFailed(executionId, reason),
  invocationId:          toolName => `cli-${ toolName }-${ Date.now().toString(36) }-${ Math.random().toString(36).slice(2, 8) }`,
};

/** Runs workflow-activating CLI tools on a fresh detached graph so their state never leaks between calls. */
export class StatefulCliWorkflowDispatcher {
  constructor(private readonly deps: StatefulWorkflowCollaborators = agentCollaborators) {}

  needsDispatch(toolName: string, params: Record<string, unknown>): boolean {
    return toolName === 'execute_workflow' ||
      (toolName === 'restart_from_checkpoint' && Boolean(params.executionId && params.nodeId));
  }

  async call(tool: StatefulTool, toolName: string, params: Record<string, unknown>): Promise<any> {
    const invocationId = this.deps.invocationId(toolName);
    const graphResult = await this.deps.getOrCreateAgentGraph('sulla-desktop', invocationId);
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
      this.deps.deleteGraph(invocationId);

      return result;
    }

    graph.execute(state)
      .catch(async(err) => {
        await this.deps.markExecutionFailed(activeExecutionId, `detached_graph_failed: ${ err instanceof Error ? err.message : String(err) }`);
      })
      .finally(() => this.deps.deleteGraph(invocationId));

    return result;
  }
}
