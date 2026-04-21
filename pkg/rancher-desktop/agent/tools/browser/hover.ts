import { BaseTool, ToolResponse } from '../base';
import { saveScreenshot } from './screenshot_store';
import { resolveBridge, isBridgeResolved } from './resolve_bridge';

/**
 * Move Mouse Tool - Moves the mouse to coordinates without clicking.
 *
 * Triggers hover effects, dropdown menus, tooltips, and any UI that
 * responds to mouseover/mouseenter events. Injects a visible cursor
 * at the position and takes a screenshot.
 */
export class MoveMouseWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { x, y } = input;
    const result = await resolveBridge(input.assetId);
    if (!isBridgeResolved(result)) return result;

    try {
      // Send CDP mouseMoved event (triggers hover effects)
      await result.bridge.moveMouse(x, y);

      // Brief wait for hover effects to render
      await new Promise(r => setTimeout(r, 300));

      // Inject visible cursor
      try {
        await result.bridge.execInPage(`
(function() {
  document.querySelectorAll('[data-sulla-cursor]').forEach(el => el.remove());
  const c = document.createElement('div');
  c.setAttribute('data-sulla-cursor', '1');
  c.style.cssText = 'position:fixed;pointer-events:none;z-index:999999;top:${ y }px;left:${ x }px;';
  c.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24"><path d="M3 2L3 20L8.5 14.5L13 21L16 19.5L11.5 13L18 13L3 2Z" fill="white" stroke="black" stroke-width="1.5" stroke-linejoin="round"/></svg>';
  document.body.appendChild(c);
})()`);
      } catch { /* best effort */ }

      // Screenshot showing hover state + cursor
      const screenshot = await result.bridge.captureScreenshot({ format: 'jpeg', quality: 80 });
      const title = await result.bridge.getPageTitle();
      const url = await result.bridge.getPageUrl();

      const responseObj: any = {
        successBoolean: true,
        responseString: `[${ result.assetId }] Hovered at (${ x }, ${ y }) on ${ title } (${ url })`,
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
        responseString: `[${ result.assetId }] Move mouse failed: ${ String(err) }`,
      };
    }
  }
}
