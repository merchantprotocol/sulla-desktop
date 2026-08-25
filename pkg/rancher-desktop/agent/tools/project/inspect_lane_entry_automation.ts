import { getProjectsApplicationService } from '../../projects/application/ProjectsApplicationService';
import { BaseTool, ToolResponse } from '../base';

export class InspectLaneEntryAutomationWorker extends BaseTool {
  name = ''; description = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    try {
      const rows = await getProjectsApplicationService().listLaneEntries(String(input.task_id || '').trim());
      return { successBoolean: true, responseString: JSON.stringify(rows, null, 2) };
    } catch (error) {
      return { successBoolean: false, responseString: `Failed to inspect lane-entry automation: ${ error instanceof Error ? error.message : String(error) }` };
    }
  }
}
