import { SullaSettingsModel } from '../../database/models/SullaSettingsModel';
import { parseJson } from '../../services/JsonParseService';
import { BaseTool, ToolResponse } from '../base';
import { generateClaudeCodeMemoryFile } from '../../prompts/generateClaudeCodeMemoryFile';

// Generate a 4-character random ID using lowercase, uppercase, and numbers
function generateTinyId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let id = '';
  for (let i = 0; i < 4; i++) {
    id += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return id;
}

/**
 * Add Observational Memory Tool - Worker class for execution
 */
export class AddObservationalMemoryWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { priority, content } = input;

    // Get current observational memories
    const observationalMemory = await SullaSettingsModel.get('observationalMemory', []);
    let memoryArray: any[] = [];

    try {
      const parsed = parseJson(observationalMemory);
      if (Array.isArray(parsed)) {
        memoryArray = parsed;
      } else {
        memoryArray = [];
      }
    } catch (e: any) {
      return {
        successBoolean: false,
        responseString: `Failed to parse observational memory: ${ e?.message }`,
      };
    }

    // Dedup: check if a substantially similar observation already exists
    const normalizeForComparison = (s: string) =>
      s.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
    const newNormalized = normalizeForComparison(content);
    const duplicateIndex = memoryArray.findIndex((mem: any) => {
      const existingNormalized = normalizeForComparison(mem.content || '');
      // Exact match after normalization
      if (existingNormalized === newNormalized) return true;
      // Substring containment (one contains the other)
      if (existingNormalized.includes(newNormalized) || newNormalized.includes(existingNormalized)) return true;
      return false;
    });

    if (duplicateIndex >= 0) {
      // Replace the older entry with the newer one (preserves latest context)
      memoryArray[duplicateIndex] = {
        ...memoryArray[duplicateIndex],
        priority,
        content,
        timestamp: new Date().toISOString(),
      };
      await SullaSettingsModel.set('observationalMemory', JSON.stringify(memoryArray));
      generateClaudeCodeMemoryFile().catch(() => {});
      return {
        successBoolean: true,
        responseString: `Remembering (updated): "${ content }" (id: ${ memoryArray[duplicateIndex].id }, priority: ${ priority })`,
      };
    }

    // Add new memory
    const newMemory = {
      id:        generateTinyId(),
      priority,
      content,
      timestamp: new Date().toISOString(),
    };

    memoryArray.push(newMemory);

    // Keep only the most recent 50 memories
    if (memoryArray.length > 50) {
      memoryArray = memoryArray.slice(-50);
    }

    // Test round-trip to ensure valid JSON before saving
    try {
      const testString = JSON.stringify(memoryArray);
      JSON.parse(testString);
    } catch (e: any) {
      return {
        successBoolean: false,
        responseString: `Failed to parse observational memory: ${ e?.message }`,
      };
    }

    // Save back to settings
    await SullaSettingsModel.set('observationalMemory', JSON.stringify(memoryArray));
    generateClaudeCodeMemoryFile().catch(() => {});

    return {
      successBoolean: true,
      responseString: `Remembering: "${ content }" (id: ${ newMemory.id }, priority: ${ priority })`,
    };
  }
}
