import { getProjectsApplicationService } from '../../projects/application/ProjectsApplicationService';
import { BaseTool, ToolResponse } from '../base';

/** Claim the lease-governed lifecycle capability for a task's current stage. */
export class ClaimTaskLeaseWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const taskId = typeof input.task_id === 'string' ? input.task_id.trim() : '';
    const owner = typeof input.owner === 'string' ? input.owner.trim() : '';
    const runtimeInstanceId = typeof input.runtime_instance_id === 'string' ? input.runtime_instance_id.trim() : '';
    if (!taskId || !owner || !runtimeInstanceId) {
      return { successBoolean: false, responseString: 'task_id, owner, and runtime_instance_id are required.' };
    }
    try {
      const result = await getProjectsApplicationService().claimTaskLease({ taskId, owner, runtimeInstanceId });
      return { successBoolean: result.claimed, responseString: JSON.stringify(result, null, 2) };
    } catch (error: any) {
      return { successBoolean: false, responseString: `Failed to claim task lease: ${ error?.message ?? String(error) }` };
    }
  }
}
