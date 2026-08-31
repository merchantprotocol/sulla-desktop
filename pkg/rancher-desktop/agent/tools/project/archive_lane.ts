import { getProjectsApplicationService } from '../../projects/application/ProjectsApplicationService';
import { BaseTool, ToolResponse } from '../base';

export class ArchiveLaneWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    try {
      const result = await getProjectsApplicationService().archiveLane(
        String(input.id || '').trim(), input.destination_lane_key || undefined,
        { actor: input.actor || 'sulla', source: 'tool' },
      );
      return { successBoolean: true, responseString: JSON.stringify(result) };
    } catch (err: any) {
      return { successBoolean: false, responseString: `Archive lane failed: ${ err?.message }` };
    }
  }
}
