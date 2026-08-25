import { getProjectsApplicationService } from '../../projects/application/ProjectsApplicationService';
import { BaseTool, ToolResponse } from '../base';

export class ReorderLanesWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    try {
      const changed = await getProjectsApplicationService().reorderLanes(
        input.scope, input.ordered_lane_keys, input.project_id || undefined,
        { actor: input.actor || 'sulla', source: 'tool' },
      );
      return { successBoolean: true, responseString: `${ changed } lane definition(s) reordered.` };
    } catch (err: any) {
      return { successBoolean: false, responseString: `Reorder lanes failed: ${ err?.message }` };
    }
  }
}
