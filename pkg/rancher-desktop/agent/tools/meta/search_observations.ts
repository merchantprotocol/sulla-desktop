import { ObservationsModel } from '../../database/models/ObservationsModel';
import { OBSERVATION_DOMAIN } from '../../memory/MemoryRecallService';
import { BaseTool, ToolResponse } from '../base';
import { rankedDomainSearch } from './rankedSearch';

/**
 * Search Observations Tool
 *
 * Ranked by meaning with the ranked recall engine (BM25 + potion embeddings +
 * learned ranker), so paraphrases match. Falls back to the any-word ILIKE
 * search when include_archived is set (the engine indexes active rows only)
 * or the engine is unavailable. Returns compact rows: id, priority, date, content.
 */
export class SearchObservationsWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { query, limit = 20 } = input;
    const includeArchived = Boolean(input.include_archived ?? input.includeArchived ?? false);

    if (!query || typeof query !== 'string' || !query.trim()) {
      return {
        successBoolean: false,
        responseString: 'A non-empty search query is required.',
      };
    }

    try {
      const ranked = includeArchived
        ? null
        : await rankedDomainSearch(query.trim(), OBSERVATION_DOMAIN, Number(limit) || 20, id => ObservationsModel.getById(id));

      if (ranked) {
        if (ranked.length === 0) {
          return { successBoolean: true, responseString: `No observations found for "${ query }".` };
        }
        const lines = ranked.map(({ row: r, score }) => `[id:${ r.id }] ${ r.priority } ${ r.created_at } (score ${ score.toFixed(2) }) — ${ r.content }`);

        return {
          successBoolean: true,
          responseString: `Found ${ ranked.length } observation(s) for "${ query }", ranked by meaning, best first:\n${ lines.join('\n') }`,
        };
      }

      const rows = await ObservationsModel.search(query.trim(), Number(limit) || 20, includeArchived);
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
