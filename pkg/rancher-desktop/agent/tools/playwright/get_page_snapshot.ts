import { BaseTool, ToolResponse } from '../base';
import { resolveBridge, isBridgeResolved } from './resolve_bridge';
import { wrapWithBlockingWarning } from './detect_blocking';

/**
 * Get Page Snapshot Tool - Returns the full page state: title, URL,
 * interactive elements (buttons, links, forms), reader-mode content,
 * and scroll position.
 */
export class GetPageSnapshotWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const result = await resolveBridge(input.assetId);
    if (!isBridgeResolved(result)) return result;

    try {
      const title = await result.bridge.getPageTitle();
      const url = await result.bridge.getPageUrl();
      const markdown = await result.bridge.getActionableMarkdown();
      const readerContent = await result.bridge.getReaderContent();
      const scrollInfo = await result.bridge.getScrollInfo();

      const parts: string[] = [];
      parts.push(`[asset: ${ result.assetId }]`);
      parts.push(`# ${ title }`);
      parts.push(`**URL**: ${ url }`);

      if (scrollInfo.moreBelow) {
        parts.push(`**Scroll**: ${ scrollInfo.percent }% — more content below`);
      }

      if (markdown && markdown.trim()) {
        parts.push('');
        parts.push(markdown);
      }

      if (readerContent && readerContent.content && readerContent.content.trim()) {
        parts.push('');
        parts.push('---');
        parts.push('## Page Content');
        parts.push(readerContent.content);
        if (readerContent.truncated) {
          parts.push('\n[Content truncated — use browse_page to read more]');
        }
      }

      if (!markdown?.trim() && !readerContent?.content?.trim()) {
        parts.push('\nPage has no visible content or interactive elements.');
      }

      const raw = parts.join('\n');
      const { responseString, detection } = wrapWithBlockingWarning(raw, readerContent?.content || markdown || '', url);

      return { successBoolean: !detection.blocked, responseString };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error getting page snapshot: ${ (error as Error).message }`,
      };
    }
  }
}
