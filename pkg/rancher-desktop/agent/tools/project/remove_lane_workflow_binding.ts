import { getProjectsApplicationService } from '../../projects/application/ProjectsApplicationService';
import { BaseTool, ToolResponse } from '../base';

export class RemoveLaneWorkflowBindingWorker extends BaseTool {
  name = ''; description = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    try {
      const row = await getProjectsApplicationService().removeLaneBinding(
        String(input.id || '').trim(), { actor: input.actor || 'sulla', source: 'tool' },
      );
      return row
        ? { successBoolean: true, responseString: `Lane workflow binding removed: ${ row.id }` }
        : { successBoolean: false, responseString: `No active lane workflow binding found: ${ input.id }` };
    } catch (error) {
      return { successBoolean: false, responseString: `Failed to remove lane workflow binding: ${ error instanceof Error ? error.message : String(error) }` };
    }
  }
}
