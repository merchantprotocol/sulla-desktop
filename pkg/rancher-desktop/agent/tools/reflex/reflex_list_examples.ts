import { ReflexModel } from '../../database/models/ReflexModel';
import { normalizeToolName } from '../../reflex/reflexTraining';
import { BaseTool, ToolResponse } from '../base';

export class ReflexListExamplesWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const rows = await ReflexModel.listExamples({
      query:           typeof input.query === 'string' ? input.query : undefined,
      toolName:        typeof input.tool === 'string' && input.tool.trim() ? normalizeToolName(input.tool) : undefined,
      limit:           typeof input.limit === 'number' ? input.limit : undefined,
      includeArchived: !!input.include_archived,
    });
    if (!rows.length) return { successBoolean: true, responseString: 'No reflex examples found.' };
    const lines = rows.map(r => `[${ r.id }] ${ r.archived ? '(forgotten) ' : '' }"${ r.utterance }" → ${ r.positive ? '' : 'NOT ' }${ r.tool_name } ${ JSON.stringify(r.params) } · ${ r.source }`);
    return { successBoolean: true, responseString: `${ rows.length } example(s):\n${ lines.join('\n') }` };
  }
}
