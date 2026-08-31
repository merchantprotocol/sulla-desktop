import { getProjectsApplicationService } from '../../projects/application/ProjectsApplicationService';
import { BaseTool, ToolResponse } from '../base';

/** Renew liveness on an active task lease claim so it is not recovered as abandoned. */
export class HeartbeatTaskLeaseWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const claimId = typeof input.claim_id === 'string' ? input.claim_id.trim() : '';
    if (!claimId) return { successBoolean: false, responseString: 'claim_id is required.' };
    try {
      const claim = await getProjectsApplicationService().heartbeatTaskLease({ claimId });
      return claim
        ? { successBoolean: true, responseString: JSON.stringify(claim, null, 2) }
        : { successBoolean: false, responseString: `No active task lease found with id ${ claimId }.` };
    } catch (error: any) {
      return { successBoolean: false, responseString: `Failed to heartbeat task lease: ${ error?.message ?? String(error) }` };
    }
  }
}
