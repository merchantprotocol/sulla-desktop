import { ObservationsModel } from '../../database/models/ObservationsModel';
import { generateClaudeCodeMemoryFile } from '../../prompts/generateClaudeCodeMemoryFile';
import { BaseTool, ToolResponse } from '../base';

/**
 * Add Observational Memory Tool
 *
 * Inserts or updates an observation row in the `observations` table.
 * No 50-cap pruning — observations are never automatically removed.
 * If an id is provided, that exact row is updated in place. Otherwise,
 * de-duplication updates a substantially similar active observation.
 */
export class AddObservationalMemoryWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { id, priority, content, source } = input;
    const existingId = typeof id === 'string' ? id.trim() : '';

    try {
      if (existingId) {
        const updated = await ObservationsModel.update(existingId, { priority, content, source });
        if (!updated) {
          return {
            successBoolean: false,
            responseString: `No observation found with id: ${ existingId }`,
          };
        }

        generateClaudeCodeMemoryFile().catch(() => {});
        return {
          successBoolean: true,
          responseString: `Remembering (updated): "${ content }" (id: ${ updated.id }, priority: ${ updated.priority })`,
        };
      }

      // Check for an existing similar observation to avoid duplicates.
      const duplicate = await ObservationsModel.findDuplicate(content);

      if (duplicate) {
        // Update the existing row: refresh priority and content.
        await ObservationsModel.update(duplicate.id, { priority, content, source });
        generateClaudeCodeMemoryFile().catch(() => {});
        return {
          successBoolean: true,
          responseString: `Remembering (updated): "${ content }" (id: ${ duplicate.id }, priority: ${ priority })`,
        };
      }

      // Insert a new observation row.
      const record = await ObservationsModel.insert({ id: generateTinyId(), priority, content, source });
      generateClaudeCodeMemoryFile().catch(() => {});
      return {
        successBoolean: true,
        responseString: `Remembering: "${ content }" (id: ${ record.id }, priority: ${ priority })`,
      };
    } catch (err: any) {
      return {
        successBoolean: false,
        responseString: `Failed to save observation: ${ err?.message }`,
      };
    }
  }
}

// Generate a 4-character random ID using lowercase, uppercase, and numbers.
function generateTinyId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let id = '';
  for (let i = 0; i < 4; i++) {
    id += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return id;
}
