import { BaseTool, ToolResponse } from '../base';
import { createN8nService } from '../../services/N8nService';
import { countNodeConnections } from './workflow_node_utils';

function collectConnectionEdges(connections: Record<string, any>): { fromNode: string; toNode: string }[] {
  const edges: { fromNode: string; toNode: string }[] = [];
  const seen = new Set<string>();

  const walk = (value: any, sourceName?: string) => {
    if (Array.isArray(value)) {
      for (const item of value) {
        walk(item, sourceName);
      }
      return;
    }

    if (!value || typeof value !== 'object') {
      return;
    }

    if (sourceName && typeof value.node === 'string') {
      const key = `${ sourceName }=>${ value.node }`;
      if (!seen.has(key)) {
        seen.add(key);
        edges.push({ fromNode: sourceName, toNode: value.node });
      }
    }

    for (const key of Object.keys(value)) {
      walk(value[key], sourceName);
    }
  };

  for (const [sourceName, sourceValue] of Object.entries(connections || {})) {
    walk(sourceValue, sourceName);
  }

  return edges;
}

export class GetWorkflowNodeListWorker extends BaseTool {
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

      const nodes = Array.isArray(workflow?.nodes) ? workflow.nodes : [];
      const connections = workflow?.connections && typeof workflow.connections === 'object' ? workflow.connections : {};

      const nodeList = nodes.map((node: any, nodeIndex: number) => {
        const nodeName = String(node?.name || '');
        const connectionCounts = countNodeConnections(connections, nodeName);

        return {
          nodeId:              String(node?.id || ''),
          nodeName,
          nodeType:            String(node?.type || ''),
          nodeIndex,
          position:            Array.isArray(node?.position) ? node.position : undefined,
          inboundConnections:  connectionCounts.inbound,
          outboundConnections: connectionCounts.outbound,
        };
      });

      const response = {
        workflowId:   String(workflow?.id || ''),
        workflowName: String(workflow?.name || ''),
        nodeCount:    nodeList.length,
        nodes:        nodeList,
        edges:        collectConnectionEdges(connections),
      };

      return {
        successBoolean: true,
        responseString: JSON.stringify(response, null, 2),
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error getting workflow node list: ${ (error as Error).message }`,
      };
    }
  }
}
