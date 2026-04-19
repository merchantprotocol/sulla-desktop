import { SullaSettingsModel } from '../../database/models/SullaSettingsModel';
import { parseJson } from '../../services/JsonParseService';
import { BaseTool, ToolResponse } from '../base';

/**
 * Remove Observational Memory Tool - Worker class for execution
 */
export class RemoveObservationalMemoryWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { id } = input;

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

    // Find and remove the memory
    const index = memoryArray.findIndex((mem: any) => mem.id === id);
    if (index === -1) {
      return {
        successBoolean: false,
        responseString: `Memory with ID "${ id }" not found.`,
      };
    }

    const removedMemory = memoryArray.splice(index, 1)[0];

    // Test round-trip to ensure valid JSON before saving
    try {
      const testString = JSON.stringify(memoryArray);
      JSON.parse(testString);
    } catch (e: any) {
      return {
        successBoolean: false,
        responseString: `Memory data corruption detected, aborting save: ${ e?.message }`,
      };
    }

    // Save back to settings
    try {
      await SullaSettingsModel.set('observationalMemory', JSON.stringify(memoryArray));
    } catch (e: any) {
      return {
        successBoolean: false,
        responseString: `Failed to save memory: ${ e?.message }`,
      };
    }

    return {
      successBoolean: true,
      responseString: `Forgetting: "${ removedMemory.content }" (id: ${ removedMemory.id })`,
    };
  }
}
