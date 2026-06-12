import { ObservationsModel } from '../../database/models/ObservationsModel';
import { generateClaudeCodeMemoryFile } from '../../prompts/generateClaudeCodeMemoryFile';
import { BaseTool, ToolResponse } from '../base';

/**
 * Add Observational Memory Tool
 *
 * Inserts a new observation row into the `observations` table.
 * No 50-cap pruning — observations are never automatically removed.
 * De-duplication: if a substantially similar active observation already
 * exists, the existing row is updated in place (priority + content refreshed).
 */
export class AddObservationalMemoryWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { priority, content, source } = input;

    try {
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
