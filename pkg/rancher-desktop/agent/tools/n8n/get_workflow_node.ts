import { BaseTool, ToolResponse } from '../base';
import { createN8nService } from '../../services/N8nService';
import { countNodeConnections, resolveNodeIndex } from './workflow_node_utils';

export class GetWorkflowNodeWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    try {
      const workflowId = String(input.workflowId || '').trim();
      if (!workflowId) {
        throw new Error('Workflow ID is required.');
      }

      const service = await createN8nService();
      const workflow = await service.getWorkflow(workflowId, input.excludePinnedData);

      const nodeIndex = resolveNodeIndex(workflow.nodes || [], {
        nodeId:   input.nodeId,
        nodeName: input.nodeName,
      });
      const node = workflow.nodes[nodeIndex];
      const nodeName = String(node?.name || '');

      const response = {
        workflowId:   workflow.id,
        workflowName: workflow.name,
        nodeIndex,
        node,
        connections:  countNodeConnections(workflow.connections || {}, nodeName),
      };

      return {
        successBoolean: true,
        responseString: JSON.stringify(response, null, 2),
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error getting workflow node: ${ (error as Error).message }`,
      };
    }
  }
}
