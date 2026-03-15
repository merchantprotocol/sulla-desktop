import { BaseTool, ToolResponse } from '../base';
import type { WorkflowPlaybookState } from '../../workflow/types';

export class RestartFromCheckpointWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { executionId, nodeId, workflowId } = input;

    if (!executionId && !workflowId) {
      return {
        successBoolean: false,
        responseString: 'Either executionId or workflowId is required. Use workflowId to see recent executions, or executionId + nodeId to restart from a specific checkpoint.',
      };
    }

    const { WorkflowCheckpointModel } = await import('../../database/models/WorkflowCheckpointModel');

    // If only workflowId provided, list recent executions with their checkpoints
    if (!executionId) {
      const recentExecs = await WorkflowCheckpointModel.recentExecutions(workflowId, 5);

      if (recentExecs.length === 0) {
        return {
          successBoolean: false,
          responseString: `No checkpoints found for workflow "${ workflowId }". The workflow must have been executed at least once with checkpointing enabled.`,
        };
      }

      const execList = recentExecs.map((cp: any) => {
        const attrs = cp.attributes;
        return `  - executionId: ${ attrs.execution_id }\n    lastNode: ${ attrs.node_label } (${ attrs.node_id })\n    sequence: ${ attrs.sequence }\n    at: ${ attrs.created_at }`;
      }).join('\n');

      return {
        successBoolean: true,
        responseString: `Recent executions for workflow "${ workflowId }":\n${ execList }\n\nTo restart, call again with executionId and nodeId.`,
      };
    }

    // If no nodeId, list all checkpoints for this execution
    if (!nodeId) {
      const checkpoints = await WorkflowCheckpointModel.findByExecution(executionId);

      if (checkpoints.length === 0) {
        return {
          successBoolean: false,
          responseString: `No checkpoints found for execution "${ executionId }".`,
        };
      }

      const cpList = checkpoints.map((cp: any) => {
        const attrs = cp.attributes;
        return `  ${ attrs.sequence }. ${ attrs.node_label } (${ attrs.node_id }) — ${ attrs.node_subtype }`;
      }).join('\n');

      return {
        successBoolean: true,
        responseString: `Checkpoints for execution "${ executionId }":\n${ cpList }\n\nTo restart from a node, call again with nodeId set to the node you want to restart FROM.`,
      };
    }

    // Restart from a specific node — load the checkpoint BEFORE that node
    const beforeCheckpoint = await WorkflowCheckpointModel.findCheckpointBefore(executionId, nodeId);

    // If no checkpoint before (node is first), use the node's own checkpoint but reset it
    let checkpointToUse = beforeCheckpoint;
    if (!checkpointToUse) {
      // Try the node's own checkpoint — we'll rebuild state to just before it
      const nodeCheckpoint = await WorkflowCheckpointModel.findByNode(executionId, nodeId);
      if (!nodeCheckpoint) {
        return {
          successBoolean: false,
          responseString: `Node "${ nodeId }" not found in execution "${ executionId }". List checkpoints first to see available nodes.`,
        };
      }
      checkpointToUse = nodeCheckpoint;
    }

    const savedState = checkpointToUse.attributes.playbook_state as unknown as WorkflowPlaybookState;
    if (!savedState?.definition) {
      return {
        successBoolean: false,
        responseString: `Checkpoint state is corrupted for execution "${ executionId }".`,
      };
    }

    // Rebuild the playbook state: keep everything up to (but not including) the target node
    const rebuiltState: WorkflowPlaybookState = {
      ...savedState,
      // Generate a new execution ID so we don't collide with the old one
      executionId:     `${ savedState.executionId }-restart-${ Date.now() }`,
      status:          'running',
      completedAt:     undefined,
      error:           undefined,
      pendingDecision: undefined,
    };

    // If we used the "before" checkpoint, the target node hasn't run yet — it's in the frontier
    if (beforeCheckpoint) {
      // The saved state already has the correct frontier (nodes after the checkpoint node)
      // We need to make sure our target nodeId is in currentNodeIds
      if (!rebuiltState.currentNodeIds.includes(nodeId)) {
        rebuiltState.currentNodeIds = [nodeId, ...rebuiltState.currentNodeIds];
      }
      // Remove the target node from completed if it was there
      rebuiltState.completedNodeIds = rebuiltState.completedNodeIds.filter(id => id !== nodeId);
      delete rebuiltState.nodeOutputs[nodeId];
    } else {
      // We're restarting from the first node — reset to initial frontier
      // Remove the target node from completed and put it back in currentNodeIds
      rebuiltState.completedNodeIds = rebuiltState.completedNodeIds.filter(id => id !== nodeId);
      delete rebuiltState.nodeOutputs[nodeId];
      if (!rebuiltState.currentNodeIds.includes(nodeId)) {
        rebuiltState.currentNodeIds = [nodeId];
      }
    }

    // Load the rebuilt state into the agent's metadata
    if (this.state) {
      (this.state).metadata.activeWorkflow = rebuiltState;
    }

    const nodeLabel = checkpointToUse.attributes.node_label || nodeId;
    console.log(`[RestartFromCheckpoint] Restarting workflow "${ savedState.definition.name }" from node "${ nodeLabel }" — new executionId=${ rebuiltState.executionId }`);

    return {
      successBoolean: true,
      responseString: JSON.stringify({
        executionId:      rebuiltState.executionId,
        originalExecId:   savedState.executionId,
        workflowId:       savedState.workflowId,
        workflowName:     savedState.definition.name,
        restartFromNode:  nodeId,
        restartFromLabel: nodeLabel,
        completedNodes:   rebuiltState.completedNodeIds.length,
        frontierNodes:    rebuiltState.currentNodeIds,
        status:           'restarted',
        message:          `Workflow "${ savedState.definition.name }" restarted from node "${ nodeLabel }". The workflow orchestration system has taken over from this point.`,
      }, null, 2),
    };
  }
}
