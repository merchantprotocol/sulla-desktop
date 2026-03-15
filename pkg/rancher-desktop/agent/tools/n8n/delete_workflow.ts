import { BaseTool, ToolResponse } from '../base';
import { createN8nService } from '../../services/N8nService';

/**
 * Delete Workflow Tool - Worker class for execution
 */
export class DeleteWorkflowWorker extends BaseTool {
  name = '';
  description = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    try {
      const service = await createN8nService();
      const result = await service.deleteWorkflow(input.id);

      const responseString = `Workflow deleted successfully:
ID: ${ input.id }
Deletion completed at: ${ new Date().toLocaleString() }`;

      return {
        successBoolean: true,
        responseString,
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error deleting workflow: ${ (error as Error).message }`,
      };
    }
  }
}
