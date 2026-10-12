import { SkillDefinitionModel } from '../../database/models/SkillDefinitionModel';
import { BaseTool, ToolResponse } from '../base';

export class SkillListWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const query = String(input.query ?? '').trim();
    const limit = Math.max(1, Math.min(500, Number(input.limit) || 100));
    const rows = query
      ? await SkillDefinitionModel.search(query, limit)
      : (await SkillDefinitionModel.list({ includeDisabled: input.include_disabled === true, includeDeleted: input.include_deleted === true })).slice(0, limit);

    if (rows.length === 0) {
      return { successBoolean: true, responseString: query ? `No skills match "${ query }".` : 'No skills in the database.' };
    }

    const lines = rows.map((row) => {
      const state = row.deleted_at ? ' [deleted]' : row.enabled ? '' : ' [disabled]';
      const triggers = row.triggers.length ? ` — use when: ${ row.triggers.slice(0, 6).join('; ') }` : '';
      return `- ${ row.slug }${ state } (${ row.source_kind }): ${ row.title }${ triggers }`;
    });
    return { successBoolean: true, responseString: `${ rows.length } skill(s):\n${ lines.join('\n') }` };
  }
}
