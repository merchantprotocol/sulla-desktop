import { getProjectsApplicationService } from '../../projects/application/ProjectsApplicationService';
import { BaseTool, ToolResponse } from '../base';
import { associationInput } from '../knowledgeAssociationAdapter';

export class UnlinkProjectItemWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    try {
      const actor = typeof input.actor === 'string' && input.actor.trim() ? input.actor.trim() : 'sulla';
      const removed = await getProjectsApplicationService().unlinkKnowledge(
        associationInput({ ...input, actor }), { actor, source: 'tool' },
      );
      return {
        successBoolean: true,
        responseString: removed ? 'Direct project association archived.' : 'No matching active direct association.',
      };
    } catch (err: any) {
      return { successBoolean: false, responseString: `Unlink project item failed: ${ err?.message ?? String(err) }` };
    }
  }
}
