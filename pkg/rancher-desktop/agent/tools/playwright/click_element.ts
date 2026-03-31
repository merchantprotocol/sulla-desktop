import { BaseTool, ToolResponse } from '../base';
import { resolveBridge, isBridgeResolved } from './resolve_bridge';
import { waitForNavigation, formatPageState } from './wait_for_navigation';

/**
 * Click Element Tool - Clicks a button, link, or element on a website asset.
 *
 * If the click triggers navigation (new page, SPA route change), this tool
 * waits for the page to load and returns the full page state.
 * Bridge readiness is handled by the state machine in WebviewHostBridge —
 * commands auto-wait for READY state after navigation.
 */
export class ClickElementWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { handle } = input;
    const result = await resolveBridge(input.assetId);
    if (!isBridgeResolved(result)) return result;

    try {
      const navPromise = waitForNavigation(result.assetId);

      const clicked = await result.bridge.click(handle);

      if (!clicked) {
        return {
          successBoolean: false,
          responseString: `[${ result.assetId }] Element not found or not clickable: ${ handle }. Use get_page_snapshot to see available elements.`,
        };
      }

      const navResult = await navPromise;

      if (navResult && navResult.navigated) {
        const pageState = formatPageState(result.assetId, navResult);
        return {
          successBoolean: true,
          responseString: `[${ result.assetId }] Clicked "${ handle }" → page navigated.\n\n${ pageState }`,
        };
      }

      // No navigation — read current state. Bridge auto-waits if it's recovering.
      try {
        const snapshot = await result.bridge.getActionableMarkdown();
        const readerContent = await result.bridge.getReaderContent();
        const stateInfo = readerContent?.content
          ? `\n\nCurrent page content (may have updated):\n${ readerContent.content.slice(0, 3000) }`
          : (snapshot ? `\n\nCurrent interactive elements:\n${ snapshot.slice(0, 2000) }` : '');

        return {
          successBoolean: true,
          responseString: `[${ result.assetId }] Clicked "${ handle }" — no navigation detected (page may have updated in place).${ stateInfo }`,
        };
      } catch {
        return {
          successBoolean: true,
          responseString: `[${ result.assetId }] Clicked "${ handle }" successfully.`,
        };
      }
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error clicking element: ${ (error as Error).message }`,
      };
    }
  }
}
