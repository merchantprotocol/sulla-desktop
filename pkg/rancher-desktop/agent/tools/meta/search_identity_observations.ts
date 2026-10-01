import { formatIdentityObservationDate, IdentityObservationsModel, normalizeIdentityDomain } from '../../database/models/IdentityObservationsModel';
import { ObservationsModel } from '../../database/models/ObservationsModel';
import { BaseTool, ToolResponse } from '../base';
import { rankedDomainSearch } from './rankedSearch';

/**
 * Search Identity Observations Tool
 *
 * Ranked by meaning within one domain using the ranked recall engine (BM25 +
 * potion embeddings + learned ranker), so paraphrases match. Falls back to the
 * word-level ILIKE search (phrase-hit → word count → level → recency) when
 * include_archived is set or the engine is unavailable.
 */
export class SearchIdentityObservationsWorker extends BaseTool {
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
      const domain = normalizeIdentityDomain(input.domain);
      const ranked = includeArchived
        ? null
        : await rankedDomainSearch(query.trim(), domain, Number(limit) || 20, id => IdentityObservationsModel.getById(id));
      const scores = new Map(ranked?.map(h => [h.row.id, h.score]) ?? []);
      const rows = ranked
        ? ranked.map(h => h.row)
        : await IdentityObservationsModel.search(domain, query.trim(), Number(limit) || 20, includeArchived);
      const words = ObservationsModel.tokenizeQuery(query.trim());
      const matchDesc = ranked ? `"${ query }" (ranked by meaning)` : words.length > 1 ? `"${ query }" (any of: ${ words.join(', ') })` : `"${ query }"`;

      if (rows.length === 0) {
        return {
          successBoolean: true,
          responseString: `No ${ domain } identity observations found matching ${ matchDesc }.`,
        };
      }

      const lines = rows.map(r => {
        const labels = [
          `L${ r.level }`,
          r.category,
          r.subject ? `subject:${ r.subject }` : null,
          r.kind ? `kind:${ r.kind }` : null,
          r.confidence !== null && r.confidence !== undefined ? `confidence:${ r.confidence }` : null,
        ].filter(Boolean).join('·');
        const score = scores.has(r.id) ? ` (score ${ scores.get(r.id)!.toFixed(2) })` : '';

        return `[id:${ r.id }] ${ labels } ${ formatIdentityObservationDate(r.created_at) }${ score } — ${ r.content }${ r.evidence ? ` (evidence: ${ r.evidence })` : '' }${ r.basis ? ` (basis: ${ r.basis })` : '' }${ r.archived ? ' (archived)' : '' }`;
      });

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
