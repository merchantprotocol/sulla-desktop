import { BaseTool, ToolResponse } from '../base';
import { resolveBridge, isBridgeResolved } from './resolve_bridge';
import { wrapWithBlockingWarning } from './detect_blocking';

/**
 * Get Page Snapshot Tool - Returns an actionable Markdown snapshot of the
 * currently active website asset (buttons, links, form fields).
 */
export class GetPageSnapshotWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const result = await resolveBridge(input.assetId);
    if (!isBridgeResolved(result)) return result;

    try {
      const markdown = await result.bridge.getActionableMarkdown();
      if (!markdown.trim()) {
        return {
          successBoolean: true,
          responseString: `[${ result.assetId }] Page snapshot is empty — the page may have no interactive elements.`,
        };
      }

      const url = await result.bridge.getPageUrl();
      const raw = `[asset: ${ result.assetId }]\n${ markdown }`;
      const { responseString, detection } = wrapWithBlockingWarning(raw, markdown, url);

      return {
        successBoolean: !detection.blocked,
        responseString,
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error getting page snapshot: ${ (error as Error).message }`,
      };
    }
  }
}
