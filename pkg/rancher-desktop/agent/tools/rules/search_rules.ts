import { RulesModel } from '../../database/models/RulesModel';
import { BaseTool, ToolResponse } from '../base';

/**
 * Search Rules Tool
 *
 * Keyword search across the title + content of user-created rules in the
 * `sulla_rules` table. The query is split into words and any rule matching
 * ANY meaningful word is returned (stopwords ignored), ranked by phrase hit
 * then word-match count. Use before adding a new rule to check for an
 * existing similar one, or to surface rules relevant to the current action.
 */
export class SearchRulesWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { query, limit = 20 } = input;
    const includeArchived = Boolean(input.include_archived ?? input.includeArchived ?? false);
    const includeDisabled = Boolean(input.include_disabled ?? input.includeDisabled ?? false);

    if (!query || typeof query !== 'string' || !query.trim()) {
      return { successBoolean: false, responseString: 'A non-empty query is required.' };
    }

    try {
      await RulesModel.ensureTable();
      const rows = await RulesModel.search(query, Number(limit) || 20, { includeArchived, includeDisabled });

      if (rows.length === 0) {
        return {
          successBoolean: true,
          responseString: `No rules matched "${ query }".`,
        };
      }

      const lines = rows.map(r =>
        `[id:${ r.id }] ${ r.severity } (${ r.category }) ${ r.title } — ${ r.content }` +
        `${ r.enabled ? '' : ' (disabled)' }${ r.archived ? ' (archived)' : '' }`,
      );

      return {
        successBoolean: true,
        responseString: `${ rows.length } rule(s) matched "${ query }":\n${ lines.join('\n') }`,
      };
    } catch (err: any) {
      return {
        successBoolean: false,
        responseString: `Search rules failed: ${ err?.message }`,
      };
    }
  }
}
