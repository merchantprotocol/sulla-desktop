import { getProjectsApplicationService } from '../../projects/application/ProjectsApplicationService';
import { BaseTool, ToolResponse } from '../base';
import { associationInput, formatJson } from '../knowledgeAssociationAdapter';

export class LinkProjectItemWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    try {
      const actor = typeof input.actor === 'string' && input.actor.trim() ? input.actor.trim() : 'sulla';
      const link = await getProjectsApplicationService().linkKnowledge(
        associationInput({ ...input, actor }), { actor, source: 'tool' },
      );
      return { successBoolean: true, responseString: formatJson(link) };
    } catch (err: any) {
      return { successBoolean: false, responseString: `Link project item failed: ${ err?.message ?? String(err) }` };
    }
  }
}
