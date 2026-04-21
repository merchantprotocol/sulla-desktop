import { BaseTool, ToolResponse } from '../base';
import { saveScreenshot } from './screenshot_store';
import { resolveBridge, isBridgeResolved } from './resolve_bridge';

/**
 * Type At Coordinates Tool - Clicks to focus then types text via CDP.
 *
 * First clicks at the given coordinates to focus the target element
 * (input, textarea, contenteditable, etc.), then types the text
 * character-by-character using trusted CDP keyboard events. After
 * typing, captures a screenshot so the model can verify.
 *
 * Useful for chat widgets, shadow DOM inputs, and other elements
 * that DOM-based set_field can't reach.
 */
export class TypeCoordinatesWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { x, y, text } = input;
    const result = await resolveBridge(input.assetId);
    if (!isBridgeResolved(result)) return result;
    try {
      // Click to focus the target element
      const clicked = await result.bridge.clickAtCoordinate(x, y);
      if (!clicked) {
        return {
          successBoolean: false,
          responseString: `[${ result.assetId }] Failed to click at (${ x }, ${ y }) to focus element.`,
        };
      }

      // Brief wait for focus
      await new Promise(r => setTimeout(r, 200));

      // Type the text character by character
      const typed = await result.bridge.typeText(text);
      if (!typed) {
        return {
          successBoolean: false,
          responseString: `[${ result.assetId }] Focused at (${ x }, ${ y }) but failed to type text.`,
        };
      }

      // Optional: press Enter if submit flag is set
      if (input.submit) {
        await result.bridge.pressKey('Enter');
        await new Promise(r => setTimeout(r, 500));
      }

      // Auto-capture screenshot to show the result
      const screenshot = await result.bridge.captureScreenshot({
        format:  'jpeg',
        quality: 80,
      });

      const title = await result.bridge.getPageTitle();
      const url = await result.bridge.getPageUrl();

      const responseObj: any = {
        successBoolean: true,
        responseString: `[${ result.assetId }] Typed "${ text.slice(0, 50) }${ text.length > 50 ? '...' : '' }" at (${ x }, ${ y }) on ${ title } (${ url })`,
      };

      if (screenshot) {
        const ref = await saveScreenshot(screenshot.base64, screenshot.mediaType);
        responseObj.screenshot = ref;
        responseObj.responseString += ` — screenshot at ${ ref.path } (${ ref.width }×${ ref.height }, ${ ref.bytes } bytes). Use Read on that path to inspect visually.`;
      }

      return responseObj;
    } catch (err) {
      return {
        successBoolean: false,
        responseString: `[${ result.assetId }] Type at (${ x }, ${ y }) failed: ${ String(err) }`,
      };
    }
  }
}
