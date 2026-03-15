import { BaseTool, ToolResponse } from '../base';
import { resolveBridge, isBridgeResolved } from './resolve_bridge';

/**
 * Click Element Tool - Clicks a button, link, or element on a website asset.
 */
export class ClickElementWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { handle } = input;
    console.log('[SULLA_CLICK_TOOL] _validatedCall', { handle, assetId: input.assetId });
    const result = resolveBridge(input.assetId);
    if (!isBridgeResolved(result)) {
      console.log('[SULLA_CLICK_TOOL] bridge resolution failed', result);
      return result;
    }
    console.log('[SULLA_CLICK_TOOL] bridge resolved', { assetId: result.assetId, bridgeInjected: result.bridge.isInjected() });

    try {
      const clicked = await result.bridge.click(handle);
      console.log('[SULLA_CLICK_TOOL] bridge.click returned', { clicked, handle });
      if (clicked) {
        return {
          successBoolean: true,
          responseString: `[${ result.assetId }] Successfully clicked element: ${ handle }`,
        };
      }

      return {
        successBoolean: false,
        responseString: `[${ result.assetId }] Element not found or not clickable: ${ handle }. Use get_page_snapshot to see available elements.`,
      };
    } catch (error) {
      console.error('[SULLA_CLICK_TOOL] bridge.click threw', error);
      return {
        successBoolean: false,
        responseString: `Error clicking element: ${ (error as Error).message }`,
      };
    }
  }
}
