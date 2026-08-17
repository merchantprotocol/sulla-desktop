import { WorkItemsModel } from '../../database/models/WorkItemsModel';
import { BaseTool, ToolResponse } from '../base';

/**
 * Keyword search across projects, epics, and tasks.
 */
export class SearchWorkItemsWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const query = typeof input.query === 'string' ? input.query.trim() : '';
    if (!query) return { successBoolean: false, responseString: 'query is required.' };
    const kind = input.kind || undefined;
    const limit = Number(input.limit) || 20;
    const includeArchived = Boolean(input.include_archived ?? input.includeArchived ?? false);

    try {
      await WorkItemsModel.ensureTables();
      const rows = await WorkItemsModel.search({ query, kind, limit, includeArchived });
      if (rows.length === 0) {
        return { successBoolean: true, responseString: `No project items matched "${ query }".` };
      }
      const lines = rows.map(r =>
        `[${ r.kind } ${ r.id }] ${ r.priority } ${ r.status } ${ r.title }${ r.archived ? ' (archived)' : '' }`,
      );
      return {
        successBoolean: true,
        responseString: `${ rows.length } match(es) for "${ query }":\n${ lines.join('\n') }`,
      };
    } catch (err: any) {
      return { successBoolean: false, responseString: `Search project items failed: ${ err?.message }` };
    }
  }
}
