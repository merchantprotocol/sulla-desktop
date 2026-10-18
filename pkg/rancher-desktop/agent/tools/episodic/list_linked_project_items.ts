import { getProjectsApplicationService } from '../../projects/application/ProjectsApplicationService';
import { BaseTool, ToolResponse } from '../base';
import { formatJson, parseNodeId } from '../knowledgeAssociationAdapter';

export class ListLinkedProjectItemsWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    try {
      const rows = await getProjectsApplicationService().listWorkForKnowledge(parseNodeId(input), {
        includeArchived: Boolean(input.include_archived ?? false),
        relationType:    input.relation_type,
        limit:           input.limit,
      });
      return { successBoolean: true, responseString: formatJson(rows) };
    } catch (err: any) {
      return { successBoolean: false, responseString: `List linked project items failed: ${ err?.message ?? String(err) }` };
    }
  }
}
