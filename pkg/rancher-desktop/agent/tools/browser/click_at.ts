import { BaseTool, ToolResponse } from '../base';
import { saveScreenshot } from './screenshot_store';
import { resolveBridge, isBridgeResolved } from './resolve_bridge';

const CURSOR_JS = (x: number, y: number) => `
(function() {
  document.querySelectorAll('[data-sulla-cursor]').forEach(el => el.remove());
  const c = document.createElement('div');
  c.setAttribute('data-sulla-cursor', '1');
  c.style.cssText = 'position:fixed;pointer-events:none;z-index:999999;top:${ y }px;left:${ x }px;';
  c.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">'
    + '<path d="M3 2L3 20L8.5 14.5L13 21L16 19.5L11.5 13L18 13L3 2Z" fill="white" stroke="black" stroke-width="1.5" stroke-linejoin="round"/>'
    + '</svg>'
    + '<div style="position:absolute;top:12px;left:12px;width:20px;height:20px;border-radius:50%;background:rgba(59,130,246,0.3);border:2px solid rgba(59,130,246,0.7);animation:sulla-click-ring 1.5s ease-in-out infinite;"></div>';
  const style = document.createElement('style');
  style.setAttribute('data-sulla-cursor', '1');
  style.textContent = '@keyframes sulla-click-ring{0%,100%{transform:scale(0.8);opacity:0.6}50%{transform:scale(1.5);opacity:1}}';
  document.head.appendChild(style);
  document.body.appendChild(c);
})()`;

const REMOVE_CURSOR_JS = `document.querySelectorAll('[data-sulla-cursor]').forEach(el => el.remove())`;

/**
 * Click At Coordinates Tool - Clicks at pixel coordinates via CDP.
 *
 * Injects a visible cursor + click animation at the coordinates,
 * captures a screenshot showing where the click happened, then cleans up.
 */
export class ClickCoordinatesWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { x, y } = input;
    const result = await resolveBridge(input.assetId);
    if (!isBridgeResolved(result)) return result;

    try {
      const clickCount = input.double_click ? 2 : 1;
      const clicked = await result.bridge.clickAtCoordinate(x, y, {
        button: input.button || 'left',
        clickCount,
      });

      if (!clicked) {
        return {
          successBoolean: false,
          responseString: `[${ result.assetId }] Failed to click at (${ x }, ${ y }).`,
        };
      }

      // Brief wait for DOM update
      await new Promise(r => setTimeout(r, 500));

      // Inject cursor + click animation at the click point
      try {
        await result.bridge.execInPage(CURSOR_JS(x, y));
      } catch { /* best effort */ }

      // Capture screenshot with cursor visible
      const screenshot = await result.bridge.captureScreenshot({
        format:  'jpeg',
        quality: 80,
      });

      // Don't remove the cursor — leave it visible on screen so the user
      // can see where the click happened. The next click_at call will
      // remove the old cursor before placing a new one.

      const title = await result.bridge.getPageTitle();
      const url = await result.bridge.getPageUrl();

      const responseObj: any = {
        successBoolean: true,
        responseString: `[${ result.assetId }] Clicked at (${ x }, ${ y }) on ${ title } (${ url })`,
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
        responseString: `[${ result.assetId }] Click at (${ x }, ${ y }) failed: ${ String(err) }`,
      };
    }
  }
}
