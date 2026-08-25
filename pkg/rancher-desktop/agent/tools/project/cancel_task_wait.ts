import { getProjectsApplicationService } from '../../projects/application/ProjectsApplicationService';
import { BaseTool, ToolResponse } from '../base';

export class CancelTaskWaitWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const id = typeof input.id === 'string' ? input.id.trim() : '';
    const reason = typeof input.reason === 'string' && input.reason.trim() ? input.reason.trim() : 'cancelled by operator';
    if (!id) return { successBoolean: false, responseString: 'id is required.' };
    try {
      const wait = await getProjectsApplicationService().cancelWait(id, reason);
      return wait
        ? { successBoolean: true, responseString: `Cancelled task wait ${ id } (${ reason }).` }
        : { successBoolean: false, responseString: `No active task wait found with id ${ id }.` };
    } catch (err: any) {
      return { successBoolean: false, responseString: `Failed to cancel task wait: ${ err?.message }` };
    }
  }
}
