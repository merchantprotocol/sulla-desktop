import { BaseTool, ToolResponse } from '../base';
import { createN8nService } from '../../services/N8nService';

/**
 * Get Template Workflow Tool - Worker class for execution
 */
export class GetTemplateWorkflowWorker extends BaseTool {
  name = '';
  description = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    try {
      const service = await createN8nService();
      const template = await service.getTemplateWorkflow(input.id);

      const responseString = `Template Workflow Details:
ID: ${ template.id }
Name: ${ template.name }
Description: ${ template.description || 'N/A' }
Category: ${ template.category || 'N/A' }
Tags: ${ (template.tags || []).join(', ') || 'None' }
Nodes: ${ template.nodes?.length || 0 }
Created: ${ template.createdAt ? new Date(template.createdAt).toLocaleString() : 'N/A' }
Updated: ${ template.updatedAt ? new Date(template.updatedAt).toLocaleString() : 'N/A' }`;

      return {
        successBoolean: true,
        responseString,
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error getting template workflow: ${ (error as Error).message }`,
      };
    }
  }
}
