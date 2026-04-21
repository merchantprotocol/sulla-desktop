import { BaseTool, ToolResponse } from '../base';
import { resolveBridge, isBridgeResolved } from './resolve_bridge';

/**
 * Wait For Element Tool - Waits for a CSS selector to become visible on a website asset.
 */
export class WaitForElementWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { selector, timeout = 5000 } = input;
    const result = await resolveBridge(input.assetId);
    if (!isBridgeResolved(result)) return result;
    try {
      const found = await result.bridge.waitForSelector(selector, timeout);
      if (found) {
        return {
          successBoolean: true,
          responseString: `[${ result.assetId }] Element matching "${ selector }" is now visible.`,
        };
      }

      return {
        successBoolean: false,
        responseString: `[${ result.assetId }] Timed out after ${ timeout }ms waiting for "${ selector }" to become visible.`,
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error waiting for element: ${ (error as Error).message }`,
      };
    }
  }
}
