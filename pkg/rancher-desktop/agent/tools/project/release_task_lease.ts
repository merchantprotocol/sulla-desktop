import { getProjectsApplicationService } from '../../projects/application/ProjectsApplicationService';
import { BaseTool, ToolResponse } from '../base';

/** Release an active task lease claim by id. */
export class ReleaseTaskLeaseWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const claimId = typeof input.claim_id === 'string' ? input.claim_id.trim() : '';
    if (!claimId) return { successBoolean: false, responseString: 'claim_id is required.' };
    const status = input.status === 'cancelled' ? 'cancelled' : 'released';
    try {
      await getProjectsApplicationService().releaseTaskLease({ claimId, status });
      return { successBoolean: true, responseString: `Task lease ${ claimId } ${ status }.` };
    } catch (error: any) {
      return { successBoolean: false, responseString: `Failed to release task lease: ${ error?.message ?? String(error) }` };
    }
  }
}
