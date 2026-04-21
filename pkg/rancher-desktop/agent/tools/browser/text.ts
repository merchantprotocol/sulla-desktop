import { BaseTool, ToolResponse } from '../base';
import { wrapWithBlockingWarning } from './detect_blocking';
import { resolveBridge, isBridgeResolved } from './resolve_bridge';

/**
 * Get Page Text Tool - Returns the full visible text content of a page
 * with title, URL, and scroll position context.
 */
export class GetPageTextWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const result = await resolveBridge(input.assetId);
    if (!isBridgeResolved(result)) return result;

    try {
      const title = await result.bridge.getPageTitle();
      const url = await result.bridge.getPageUrl();

      // Try reader content first (cleaner, structured)
      const readerContent = await result.bridge.getReaderContent();
      let text = readerContent?.content || '';

      // Fallback to raw innerText
      if (!text.trim()) {
        text = await result.bridge.getPageText();
      }

      if (!text.trim()) {
        return {
          successBoolean: true,
          responseString: `[asset: ${ result.assetId }] Page "${ title }" (${ url }) has no visible text content.`,
        };
      }

      const scrollInfo = await result.bridge.getScrollInfo();
      const scrollNote = scrollInfo.moreBelow
        ? `\n\n---\nScroll: ${ scrollInfo.percent }% — more content below. Use browse_page(action: 'scroll_down') to continue.`
        : '';

      const raw = `[asset: ${ result.assetId }]\n# ${ title }\n**URL**: ${ url }\n\n${ text }${ scrollNote }`;
      const { responseString, detection } = wrapWithBlockingWarning(raw, text, url);

      return { successBoolean: !detection.blocked, responseString };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error getting page text: ${ (error as Error).message }`,
      };
    }
  }
}
