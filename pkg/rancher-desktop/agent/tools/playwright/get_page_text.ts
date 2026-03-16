import { BaseTool, ToolResponse } from '../base';
import { resolveBridge, isBridgeResolved } from './resolve_bridge';
import { wrapWithBlockingWarning } from './detect_blocking';

/**
 * Get Page Text Tool - Returns the visible text content of a website asset.
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
      const text = await result.bridge.getPageText();

      if (!text.trim()) {
        return {
          successBoolean: true,
          responseString: `[${ result.assetId }] Page "${ title }" (${ url }) has no visible text content.`,
        };
      }

      const raw = `[asset: ${ result.assetId }]\n# ${ title }\n**URL**: ${ url }\n\n${ text }`;
      const { responseString, detection } = wrapWithBlockingWarning(raw, text, url);

      return {
        successBoolean: !detection.blocked,
        responseString,
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error getting page text: ${ (error as Error).message }`,
      };
    }
  }
}
