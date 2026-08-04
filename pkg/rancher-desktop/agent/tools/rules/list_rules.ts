import { RulesModel } from '../../database/models/RulesModel';
import { BaseTool, ToolResponse } from '../base';

/**
 * List Rules Tool
 *
 * Returns active (non-archived, enabled) user-created rules from the
 * `sulla_rules` table, most severe first then recency. Optionally filter
 * by category or severity. This is the DB half of the rules system — the
 * Security Conscience reads it alongside the global rule files under
 * `~/sulla/rules/global/`.
 */
export class ListRulesWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { category, severity, limit = 100 } = input;
    const includeDisabled = Boolean(input.include_disabled ?? input.includeDisabled ?? false);

    try {
      await RulesModel.ensureTable();
      const rows = await RulesModel.listActive({
        category: category || undefined,
        severity: severity || undefined,
        limit:    Number(limit) || 100,
        includeDisabled,
      });

      if (rows.length === 0) {
        return {
          successBoolean: true,
          responseString: 'No user-created rules found.',
        };
      }

      const lines = rows.map(r =>
        `[id:${ r.id }] ${ r.severity } (${ r.category }) ${ r.title } — ${ r.content }${ r.enabled ? '' : ' (disabled)' }`,
      );

      return {
        successBoolean: true,
        responseString: `${ rows.length } rule(s):\n${ lines.join('\n') }`,
      };
    } catch (err: any) {
      return {
        successBoolean: false,
        responseString: `List rules failed: ${ err?.message }`,
      };
    }
  }
}
