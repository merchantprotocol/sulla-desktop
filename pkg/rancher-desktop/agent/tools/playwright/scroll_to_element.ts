import { BaseTool, ToolResponse } from '../base';
import { resolveBridge, isBridgeResolved } from './resolve_bridge';

/**
 * Scroll To Element Tool - Scrolls a matching element into view on a website asset.
 */
export class ScrollToElementWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { selector } = input;
    const result = await resolveBridge(input.assetId);
    if (!isBridgeResolved(result)) return result;

    try {
      const scrolled = await result.bridge.scrollTo(selector);
      if (scrolled) {
        return {
          successBoolean: true,
          responseString: `[${ result.assetId }] Scrolled to element matching "${ selector }".`,
        };
      }

      return {
        successBoolean: false,
        responseString: `[${ result.assetId }] Element not found: "${ selector }".`,
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error scrolling to element: ${ (error as Error).message }`,
      };
    }
  }
}
