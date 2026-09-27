import { IdentityObservationsModel, normalizeIdentityDomain, normalizeIdentityLevel } from '../../database/models/IdentityObservationsModel';
import { BaseTool, ToolResponse } from '../base';

/**
 * Add Identity Observation Tool
 *
 * Inserts or updates a row in the `identity_observations` table — the
 * focused, domain-keyed observation subsystem (human / business / world /
 * agent). If an id is provided, that exact row is updated in place.
 * Otherwise, an exact/substring match in the same domain is updated, and a
 * paraphrase (trigram similarity ≥ IDENTITY_DUPLICATE_SIMILARITY) of any
 * active row in ANY domain is skipped rather than inserted again.
 *
 * Levels are CERTAINTY, not priority:
 *   3 — stated fact (the subject directly told us)
 *   2 — derived fact (established from conversation evidence)
 *   1 — conclusion (reasoned from L3/L2 facts)
 */
export class AddIdentityObservationWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { id, level, category, content, basis, subject, evidence, confidence, kind, skillSlug, source } = input;
    const existingId = typeof id === 'string' ? id.trim() : '';

    try {
      const domain = normalizeIdentityDomain(input.domain);

      if (existingId) {
        const updated = await IdentityObservationsModel.update(existingId, { level, category, content, basis, subject, evidence, confidence, kind, skillSlug, source });
        if (!updated) {
          return {
            successBoolean: false,
            responseString: `No identity observation found with id: ${ existingId }`,
          };
        }
        return {
          successBoolean: true,
          responseString: `Remembering (updated): "${ updated.content }" (id: ${ updated.id }, domain: ${ updated.domain }, L${ updated.level }${ updated.category ? `, ${ updated.category }` : '' })`,
        };
      }

      // Check for an existing similar row in this domain to avoid duplicates.
      const duplicate = await IdentityObservationsModel.findDuplicate(domain, content);

      if (duplicate) {
        await IdentityObservationsModel.update(duplicate.id, { level, category, content, basis, subject, evidence, confidence, kind, skillSlug, source });
        return {
          successBoolean: true,
          responseString: `Remembering (updated): "${ content }" (id: ${ duplicate.id }, domain: ${ domain }, L${ level })`,
        };
      }

      // Fail closed on a bad level before any lookup, so an invalid write
      // can never be reported as "already remembered".
      normalizeIdentityLevel(level);

      // Paraphrase gate: the same fact re-worded, or already filed under
      // another domain, is not a new observation. Skip — never overwrite a
      // distinct row on a fuzzy match; the writer can update by id if this
      // is a genuine refinement.
      const similar = await IdentityObservationsModel.findSimilar(content);

      if (similar) {
        return {
          successBoolean: true,
          responseString: `Already remembered (not added): ${ (similar.similarity * 100).toFixed(0) }% similar to [${ similar.id }] in domain "${ similar.domain }": "${ similar.content.slice(0, 200) }". ` +
            (similar.domain === domain
              ? `If the new wording adds something real, update that row by passing id "${ similar.id }".`
              : `Each fact belongs to exactly one domain — do not duplicate it here.`),
        };
      }

      const record = await IdentityObservationsModel.insert({ domain, level, category, content, basis, subject, evidence, confidence, kind, skillSlug, source });
      return {
        successBoolean: true,
        responseString: `Remembering: "${ content }" (id: ${ record.id }, domain: ${ record.domain }, L${ record.level }${ record.category ? `, ${ record.category }` : '' })`,
      };
    } catch (err: any) {
      return {
        successBoolean: false,
        responseString: `Failed to save identity observation: ${ err?.message }`,
      };
    }
  }
}
