import { IdentityObservationsModel, normalizeIdentityDomain } from '../../database/models/IdentityObservationsModel';
import { BaseTool, ToolResponse } from '../base';

/**
 * Add Identity Observation Tool
 *
 * Inserts or updates a row in the `identity_observations` table — the
 * focused, domain-keyed observation subsystem (human / business / world /
 * agent). If an id is provided, that exact row is updated in place.
 * Otherwise, de-duplication updates a substantially similar active row
 * within the same domain.
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
