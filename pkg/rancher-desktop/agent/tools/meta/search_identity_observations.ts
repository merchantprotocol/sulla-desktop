import { IdentityObservationsModel } from '../../database/models/IdentityObservationsModel';
import { ObservationsModel } from '../../database/models/ObservationsModel';
import { BaseTool, ToolResponse } from '../base';

/**
 * Search Identity Observations Tool
 *
 * Word-level ILIKE search within one domain of the `identity_observations`
 * table. Ranked phrase-hit → word-match count → level (stated facts first)
 * → recency. Only active (non-archived) rows are searched by default.
 */
export class SearchIdentityObservationsWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { query, limit = 20 } = input;
    const domain = (typeof input.domain === 'string' && input.domain.trim()) || 'human';
    const includeArchived = Boolean(input.include_archived ?? input.includeArchived ?? false);

    if (!query || typeof query !== 'string' || !query.trim()) {
      return {
        successBoolean: false,
        responseString: 'A non-empty search query is required.',
      };
    }

    try {
      const rows = await IdentityObservationsModel.search(domain, query.trim(), Number(limit) || 20, includeArchived);
      const words = ObservationsModel.tokenizeQuery(query.trim());
      const matchDesc = words.length > 1 ? `"${ query }" (any of: ${ words.join(', ') })` : `"${ query }"`;

      if (rows.length === 0) {
        return {
          successBoolean: true,
          responseString: `No ${ domain } identity observations found matching ${ matchDesc }.`,
        };
      }

      const lines = rows.map(r =>
        `[id:${ r.id }] L${ r.level }${ r.category ? `·${ r.category }` : '' } ${ r.created_at } — ${ r.content }${ r.basis ? ` (basis: ${ r.basis })` : '' }${ r.archived ? ' (archived)' : '' }`,
      );

      return {
        successBoolean: true,
        responseString: `Found ${ rows.length } ${ domain } identity observation(s) matching ${ matchDesc }, best matches first:\n${ lines.join('\n') }`,
      };
    } catch (err: any) {
      return {
        successBoolean: false,
        responseString: `Search failed: ${ err?.message }`,
      };
    }
  }
}
