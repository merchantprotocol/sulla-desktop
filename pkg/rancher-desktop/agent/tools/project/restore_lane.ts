import { getProjectsApplicationService } from '../../projects/application/ProjectsApplicationService';
import { BaseTool, ToolResponse } from '../base';

export class RestoreLaneWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    try {
      const row = await getProjectsApplicationService().restoreLane(
        String(input.id || '').trim(), { actor: input.actor || 'sulla', source: 'tool' },
      );
      if (!row) return { successBoolean: false, responseString: `No restorable lane found with id: ${ input.id }` };
      return { successBoolean: true, responseString: JSON.stringify(row) };
    } catch (err: any) {
      return { successBoolean: false, responseString: `Restore lane failed: ${ err?.message }` };
    }
  }
}
