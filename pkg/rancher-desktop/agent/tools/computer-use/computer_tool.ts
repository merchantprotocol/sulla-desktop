import { BaseTool, ToolResponse } from '../base';
import { resolveBridge, isBridgeResolved } from '../playwright/resolve_bridge';

/**
 * Computer Use Tool - Anthropic's native computer_20250124 protocol.
 *
 * Handles all visual interaction actions:
 * - screenshot: capture the current page
 * - click: click at (x, y) coordinates
 * - type: type text using keyboard
 * - scroll: scroll at coordinates
 * - key: press key combinations
 * - mouse_move: move cursor to coordinates
 * - left_click_drag: click-and-drag from one point to another
 * - double_click: double-click at coordinates
 * - triple_click: triple-click at coordinates (select line)
 *
 * Every action (except screenshot and mouse_move) automatically
 * captures a screenshot after execution, which is returned as
 * an image content block in the tool result.
 */
export class ComputerToolWorker extends BaseTool {
  name = 'computer';
  description = 'Anthropic native computer use tool';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const action = input.action;
    const result = await resolveBridge();
    if (!isBridgeResolved(result)) return result;

    const { bridge, assetId } = result;

    try {
      switch (action) {
      case 'screenshot': {
        const screenshot = await bridge.captureScreenshot({ format: 'jpeg', quality: 80 });
        if (!screenshot) {
          return { successBoolean: false, responseString: `[${ assetId }] Screenshot failed` };
        }
        return {
          successBoolean:      true,
          responseString:      `[${ assetId }] Screenshot captured`,
          screenshotBase64:    screenshot.base64,
          screenshotMediaType: screenshot.mediaType,
        } as any;
      }

      case 'left_click':
      case 'click': {
        const [x, y] = input.coordinate || [0, 0];
        await this.emitCursorEvent(assetId, x, y, 'click');
        await bridge.clickAtCoordinate(x, y);
        return await this.screenshotResult(bridge, assetId, `Clicked at (${ x }, ${ y })`);
      }

      case 'right_click': {
        const [x, y] = input.coordinate || [0, 0];
        await this.emitCursorEvent(assetId, x, y, 'click');
        await bridge.clickAtCoordinate(x, y, { button: 'right' });
        return await this.screenshotResult(bridge, assetId, `Right-clicked at (${ x }, ${ y })`);
      }

      case 'double_click': {
        const [x, y] = input.coordinate || [0, 0];
        await this.emitCursorEvent(assetId, x, y, 'click');
        await bridge.clickAtCoordinate(x, y, { clickCount: 2 });
        return await this.screenshotResult(bridge, assetId, `Double-clicked at (${ x }, ${ y })`);
      }

      case 'triple_click': {
        const [x, y] = input.coordinate || [0, 0];
        await this.emitCursorEvent(assetId, x, y, 'click');
        await bridge.clickAtCoordinate(x, y, { clickCount: 3 });
        return await this.screenshotResult(bridge, assetId, `Triple-clicked at (${ x }, ${ y })`);
      }

      case 'type': {
        const text = input.text || '';
        await bridge.typeText(text);
        return await this.screenshotResult(bridge, assetId, `Typed "${ text.slice(0, 50) }${ text.length > 50 ? '...' : '' }"`);
      }

      case 'key': {
        const key = input.text || '';
        await bridge.pressKey(key);
        return await this.screenshotResult(bridge, assetId, `Pressed key: ${ key }`);
      }

      case 'scroll': {
        const [x, y] = input.coordinate || [0, 0];
        const [deltaX, deltaY] = input.delta || [0, -300];
        await this.emitCursorEvent(assetId, x, y, 'scroll');
        await bridge.scrollAtCoordinate(x, y, deltaX, deltaY);
        return await this.screenshotResult(bridge, assetId, `Scrolled at (${ x }, ${ y }) by (${ deltaX }, ${ deltaY })`);
      }

      case 'mouse_move': {
        const [x, y] = input.coordinate || [0, 0];
        await this.emitCursorEvent(assetId, x, y, 'move');
        return { successBoolean: true, responseString: `[${ assetId }] Moved cursor to (${ x }, ${ y })` };
      }

      case 'left_click_drag': {
        const [startX, startY] = input.start_coordinate || [0, 0];
        const [endX, endY] = input.coordinate || [0, 0];
        await this.emitCursorEvent(assetId, startX, startY, 'drag');
        await bridge.dragFromTo(startX, startY, endX, endY);
        await this.emitCursorEvent(assetId, endX, endY, 'drag');
        return await this.screenshotResult(bridge, assetId, `Dragged from (${ startX }, ${ startY }) to (${ endX }, ${ endY })`);
      }

      default:
        return { successBoolean: false, responseString: `Unknown action: ${ action }` };
      }
    } catch (err) {
      return {
        successBoolean: false,
        responseString: `[${ assetId }] Computer use action "${ action }" failed: ${ String(err) }`,
      };
    }
  }

  /** Capture screenshot and return as tool response with image data. */
  private async screenshotResult(bridge: any, assetId: string, message: string): Promise<any> {
    // Brief wait for DOM updates after interaction
    await new Promise(r => setTimeout(r, 300));

    const screenshot = await bridge.captureScreenshot({ format: 'jpeg', quality: 80 });
    const responseObj: any = {
      successBoolean: true,
      responseString: `[${ assetId }] ${ message }`,
    };

    if (screenshot) {
      responseObj.screenshotBase64 = screenshot.base64;
      responseObj.screenshotMediaType = screenshot.mediaType;
    }

    return responseObj;
  }

  /** Emit cursor position event to the frontend for the cursor overlay. */
  private async emitCursorEvent(assetId: string, x: number, y: number, action: string): Promise<void> {
    if (this.emitProgress) {
      await this.emitProgress({ type: 'cursor_move', x, y, action, assetId });
    }
  }
}
