import { BaseTool, ToolResponse } from '../base';
import { createN8nService } from '../../services/N8nService';

/**
 * Archive/Unarchive Workflow Tool - Worker class for execution
 */
export class ArchiveWorkflowWorker extends BaseTool {
  name = '';
  description = '';

  private normalizeAction(input: any): 'archive' | 'unarchive' {
    const action = String(input?.action || 'archive').trim().toLowerCase();
    if (action !== 'archive' && action !== 'unarchive') {
      throw new Error('action must be either "archive" or "unarchive"');
    }
    return action;
  }

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    try {
      const service = await createN8nService();
      const action = this.normalizeAction(input);
      const archived = action === 'archive';
      const workflow = await service.setWorkflowArchived(input.id, archived);

      const responseString = `Workflow ${ action }d successfully:
ID: ${ input.id }
Archived: ${ archived ? 'Yes' : 'No' }
Name: ${ workflow?.name || 'N/A' }
Updated: ${ workflow?.updatedAt ? new Date(workflow.updatedAt).toLocaleString() : 'N/A' }`;

      return {
        successBoolean: true,
        responseString,
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error changing workflow archive state: ${ (error as Error).message }`,
      };
    }
  }
}
