import { ObservationsModel } from '../../database/models/ObservationsModel';
import { BaseTool, ToolResponse } from '../base';

/**
 * Search Observations Tool
 *
 * ILIKE full-text search against the `observations` table content column.
 * Returns compact rows: id, priority, content, created_at.
 * Only active (non-archived) observations are searched by default.
 */
export class SearchObservationsWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { query, limit = 20, include_archived = false } = input;

    if (!query || typeof query !== 'string' || !query.trim()) {
      return {
        successBoolean: false,
        responseString: 'A non-empty search query is required.',
      };
    }

    try {
      const rows = await ObservationsModel.search(query.trim(), Number(limit) || 20, Boolean(include_archived));
      const words = ObservationsModel.tokenizeQuery(query.trim());
      const matchDesc = words.length > 1 ? `"${ query }" (any of: ${ words.join(', ') })` : `"${ query }"`;

      if (rows.length === 0) {
        return {
          successBoolean: true,
          responseString: `No observations found matching ${ matchDesc }.`,
        };
      }

      const lines = rows.map(r =>
        `[id:${ r.id }] ${ r.priority } ${ r.created_at } — ${ r.content }${ r.archived ? ' (archived)' : '' }`,
      );

      return {
        successBoolean: true,
        responseString: `Found ${ rows.length } observation(s) matching ${ matchDesc }, best matches first:\n${ lines.join('\n') }`,
      };
    } catch (err: any) {
      return {
        successBoolean: false,
        responseString: `Search failed: ${ err?.message }`,
      };
    }
  }
}
