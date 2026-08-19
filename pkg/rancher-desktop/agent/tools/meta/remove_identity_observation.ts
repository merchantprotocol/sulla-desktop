import { IdentityObservationsModel } from '../../database/models/IdentityObservationsModel';
import { BaseTool, ToolResponse } from '../base';

/**
 * Remove Identity Observation Tool
 *
 * Soft-archives a row in the `identity_observations` table by id.
 * The record is never hard-deleted — archived = true keeps the full
 * history recoverable.
 */
export class RemoveIdentityObservationWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const id = typeof input.id === 'string' ? input.id.trim() : '';

    if (!id) {
      return {
        successBoolean: false,
        responseString: 'An observation id is required.',
      };
    }

    try {
      const archived = await IdentityObservationsModel.archive(id);
      if (!archived) {
        return {
          successBoolean: false,
          responseString: `No identity observation found with id: ${ id }`,
        };
      }
      return {
        successBoolean: true,
        responseString: `Archived identity observation ${ id } (soft-deleted — recoverable).`,
      };
    } catch (err: any) {
      return {
        successBoolean: false,
        responseString: `Failed to archive identity observation: ${ err?.message }`,
      };
    }
  }
}
