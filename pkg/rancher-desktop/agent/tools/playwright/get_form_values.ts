import { BaseTool, ToolResponse } from '../base';
import { resolveBridge, isBridgeResolved } from './resolve_bridge';

/**
 * Get Form Values Tool - Returns all visible form field values from a website asset.
 */
export class GetFormValuesWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const result = await resolveBridge(input.assetId);
    if (!isBridgeResolved(result)) return result;
    try {
      const values = await result.bridge.getFormValues();
      const entries = Object.entries(values);
      if (entries.length === 0) {
        return {
          successBoolean: true,
          responseString: `[${ result.assetId }] No visible form fields found on the page.`,
        };
      }

      const lines = entries.map(([key, val]) => `- **@field-${ key }** = "${ val }"`);
      return {
        successBoolean: true,
        responseString: `[asset: ${ result.assetId }]\n## Form Field Values (${ entries.length } fields)\n${ lines.join('\n') }`,
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error getting form values: ${ (error as Error).message }`,
      };
    }
  }
}
