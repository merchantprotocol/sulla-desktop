import { ObservationsModel } from '../../database/models/ObservationsModel';
import { generateClaudeCodeMemoryFile } from '../../prompts/generateClaudeCodeMemoryFile';
import { BaseTool, ToolResponse } from '../base';

/**
 * Remove (archive) an observational memory by ID.
 *
 * Sets archived = true — the row is NEVER hard-deleted so the observation
 * history is always recoverable.  The observation will no longer appear in
 * listActive() / search() results unless include_archived is requested.
 */
export class RemoveObservationalMemoryWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { id } = input;

    try {
      const existing = await ObservationsModel.getById(id);
      if (!existing) {
        return {
          successBoolean: false,
          responseString: `Observation with ID "${ id }" not found.`,
        };
      }

      await ObservationsModel.archive(id);
      generateClaudeCodeMemoryFile().catch(() => {});
      return {
        successBoolean: true,
        responseString: `Archived (soft-deleted): "${ existing.content }" (id: ${ id })`,
      };
    } catch (err: any) {
      return {
        successBoolean: false,
        responseString: `Failed to archive observation: ${ err?.message }`,
      };
    }
  }
}
