import { BaseTool, ToolResponse } from '../base';
import { saveScreenshot } from './screenshot_store';
import { resolveBridge, isBridgeResolved } from './resolve_bridge';

/**
 * Screenshot Tool - Captures a visual screenshot of a website asset.
 *
 * Options:
 *   annotate — draws numbered bounding boxes on interactive elements
 *   grid     — overlays a labeled coordinate grid so the AI knows exact positions
 *
 * Both overlays are removed after the screenshot is captured.
 */
export class ScreenshotWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const result = await resolveBridge(input.assetId);
    if (!isBridgeResolved(result)) return result;

    let annotations: any[] = [];
    const addGrid = input.grid !== false; // grid on by default
    const addAnnotations = !!input.annotate;

    try {
      // Inject coordinate grid overlay
      if (addGrid) {
        await result.bridge.execInPage(INJECT_GRID_JS);
      }

      // Annotate interactive elements if requested
      if (addAnnotations) {
        annotations = await result.bridge.annotateElements();
      }

      // Capture screenshot via CDP
      const screenshot = await result.bridge.captureScreenshot({
        format:  'jpeg',
        quality: 80,
      });

      // Clean up overlays after capture
      if (addGrid) {
        await result.bridge.execInPage(`document.querySelectorAll('[data-sulla-grid]').forEach(el => el.remove())`);
      }
      if (addAnnotations) {
        await result.bridge.removeAnnotations();
      }

      if (!screenshot) {
        return {
          successBoolean: false,
          responseString: `[${ result.assetId }] Failed to capture screenshot. The tab may not be ready.`,
        };
      }

      // Build annotation legend
      let legend = '';
      if (annotations.length > 0) {
        legend = '\n\nAnnotated elements:\n' + annotations
          .map(a => `  [${ a.index }] "${ a.label }" at (${ a.x }, ${ a.y }) ${ a.width }x${ a.height }`)
          .join('\n');
      }

      const title = await result.bridge.getPageTitle();
      const url = await result.bridge.getPageUrl();
      const ref = await saveScreenshot(screenshot.base64, screenshot.mediaType);

      return {
        successBoolean: true,
        responseString: `[${ result.assetId }] Screenshot captured: ${ title } (${ url }) — ${ ref.width }×${ ref.height }, ${ ref.bytes } bytes at ${ ref.path }. Use Read on that path to load the image into vision context.${ legend }`,
        screenshot:     ref,
      } as any;
    } catch (err) {
      // Clean up on error
      try { await result.bridge.execInPage(`document.querySelectorAll('[data-sulla-grid],[data-sulla-annotation]').forEach(el => el.remove())`) } catch { /* */ }
      return {
        successBoolean: false,
        responseString: `[${ result.assetId }] Screenshot failed: ${ String(err) }`,
      };
    }
  }
}

/**
 * JavaScript injected into the page to draw a coordinate grid overlay.
 * Creates a fixed-position grid with labeled tick marks every 100px.
 * The grid is semi-transparent so page content is still visible.
 */
const INJECT_GRID_JS = `
(function() {
  // Remove existing grid
  document.querySelectorAll('[data-sulla-grid]').forEach(el => el.remove());

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const step = 200;

  const container = document.createElement('div');
  container.setAttribute('data-sulla-grid', '1');
  container.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:999998;overflow:hidden;';

  // Vertical lines + X labels along top
  for (let x = 0; x <= vw; x += step) {
    const line = document.createElement('div');
    line.style.cssText = 'position:absolute;top:0;height:100%;width:1px;background:rgba(255,0,0,0.25);'
      + 'left:' + x + 'px;';
    container.appendChild(line);

    const label = document.createElement('div');
    label.style.cssText = 'position:absolute;top:2px;font:bold 12px monospace;color:rgba(255,0,0,0.85);background:rgba(255,255,255,0.85);padding:1px 3px;border-radius:2px;'
      + 'left:' + (x + 2) + 'px;';
    label.textContent = String(x);
    container.appendChild(label);
  }

  // Horizontal lines + Y labels along left
  for (let y = 0; y <= vh; y += step) {
    const line = document.createElement('div');
    line.style.cssText = 'position:absolute;left:0;width:100%;height:1px;background:rgba(255,0,0,0.25);'
      + 'top:' + y + 'px;';
    container.appendChild(line);

    const label = document.createElement('div');
    label.style.cssText = 'position:absolute;left:2px;font:bold 12px monospace;color:rgba(255,0,0,0.85);background:rgba(255,255,255,0.85);padding:1px 3px;border-radius:2px;'
      + 'top:' + (y + 2) + 'px;';
    label.textContent = String(y);
    container.appendChild(label);
  }

  document.body.appendChild(container);
})()
`;
