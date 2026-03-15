import { BaseTool, ToolResponse } from '../base';
import { createN8nService } from '../../services/N8nService';

/**
 * Deactivate Workflow Tool - Worker class for execution
 */
export class DeactivateWorkflowWorker extends BaseTool {
  name = '';
  description = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    try {
      const service = await createN8nService();
      const result = await service.deactivateWorkflow(input.id);

      const responseString = `Workflow deactivated successfully:
ID: ${ input.id }
Deactivation completed at: ${ new Date().toLocaleString() }`;

      return {
        successBoolean: true,
        responseString,
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error deactivating workflow: ${ (error as Error).message }`,
      };
    }
  }
}
