import { BaseTool, ToolResponse } from '../base';
import { createN8nService } from '../../services/N8nService';

/**
 * Get Workflows Tool - Worker class for execution
 */
export class GetWorkflowsWorker extends BaseTool {
  name = '';
  description = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    try {
      const service = await createN8nService();
      const result = await service.getWorkflows(input);
      const workflows = result;

      if (!workflows || workflows.length === 0) {
        return {
          successBoolean: false,
          responseString: `No workflows found with the specified filters.`,
        };
      }

      let responseString = `n8n Workflows (${ workflows.length } found):\n\n`;
      workflows.forEach((workflow: any, index: number) => {
        responseString += `${ index + 1 }. ID: ${ workflow.id }\n`;
        responseString += `   Name: ${ workflow.name }\n`;
        responseString += `   Active: ${ workflow.active ? 'Yes' : 'No' }\n`;
        responseString += `   Created: ${ new Date(workflow.createdAt).toLocaleString() }\n`;
        responseString += `   Updated: ${ new Date(workflow.updatedAt).toLocaleString() }\n`;
        responseString += `   Tags: ${ (workflow.tags || []).map((tag: any) => tag.name).join(', ') || 'None' }\n`;
        responseString += `   Nodes: ${ workflow.nodes?.length || 0 }\n`;
        responseString += `   Owner: ${ workflow.owner?.email || 'N/A' }\n\n`;
      });

      return {
        successBoolean: true,
        responseString,
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error getting workflows: ${ (error as Error).message }`,
      };
    }
  }
}
