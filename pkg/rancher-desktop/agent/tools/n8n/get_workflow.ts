import { BaseTool, ToolResponse } from '../base';
import { createN8nService } from '../../services/N8nService';

/**
 * Get Workflow Tool - Worker class for execution
 */
export class GetWorkflowWorker extends BaseTool {
  name = '';
  description = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    try {
      const service = await createN8nService();
      const workflow = await service.getWorkflowWithCredentials(input.id, input.excludePinnedData);

      const responseString = JSON.stringify(workflow, null, 2);

      return {
        successBoolean: true,
        responseString,
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error getting workflow: ${ (error as Error).message }`,
      };
    }
  }
}
