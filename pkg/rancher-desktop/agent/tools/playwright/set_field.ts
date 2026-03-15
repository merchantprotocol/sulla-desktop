import { BaseTool, ToolResponse } from '../base';
import { resolveBridge, isBridgeResolved } from './resolve_bridge';

/**
 * Set Field Tool - Sets the value of a form field on a website asset.
 */
export class SetFieldWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { handle, value } = input;
    const result = await resolveBridge(input.assetId);
    if (!isBridgeResolved(result)) return result;

    try {
      const success = await result.bridge.setValue(handle, value);
      if (success) {
        return {
          successBoolean: true,
          responseString: `[${ result.assetId }] Successfully set field ${ handle } to "${ value }"`,
        };
      }

      return {
        successBoolean: false,
        responseString: `[${ result.assetId }] Field not found: ${ handle }. Use get_page_snapshot to see available form fields.`,
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error setting field value: ${ (error as Error).message }`,
      };
    }
  }
}
