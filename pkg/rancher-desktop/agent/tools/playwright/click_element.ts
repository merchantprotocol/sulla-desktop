import { BaseTool, ToolResponse } from '../base';
import { resolveBridge, isBridgeResolved } from './resolve_bridge';

/**
 * Click Element Tool - Clicks a button, link, or element on a website asset.
 *
 * After clicking, returns the dehydrated DOM so the model immediately knows
 * the new page state. Bridge methods auto-wait for READY via state machine.
 */
export class ClickElementWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { handle } = input;
    const result = await resolveBridge(input.assetId);
    if (!isBridgeResolved(result)) return result;

    try {
      const clicked = await result.bridge.click(handle);

      if (!clicked) {
        return {
          successBoolean: false,
          responseString: `[${ result.assetId }] Element not found or not clickable: ${ handle }. Use get_page_snapshot to see available elements.`,
        };
      }

      // Read dehydrated DOM — bridge auto-waits if page is navigating/reinjecting
      const title = await result.bridge.getPageTitle();
      const url = await result.bridge.getPageUrl();

      let tree = '';
      let stats: any = {};
      try {
        const raw = await result.bridge.execInPage(
          'window.__sulla ? window.__sulla.dehydrate({ maxTokens: 4000 }) : null',
        );
        if (raw && typeof raw === 'object') {
          const d = raw as any;
          tree = d.tree || '';
          stats = d.stats || {};
        }
      } catch { /* runtime not available */ }

      const parts: string[] = [];
      parts.push(`[${ result.assetId }] Clicked "${ handle }"`);
      parts.push(`# ${ title }`);
      parts.push(`**URL**: ${ url }`);

      if (tree) {
        parts.push(`**Stats**: ${ stats.tokens ?? '?' } tokens | ${ stats.interactiveCount ?? '?' } interactive | depth ${ stats.depth ?? '?' }`);
        parts.push('');
        parts.push(tree);
      } else {
        // Fallback
        try {
          const text = await result.bridge.getPageText();
          if (text) parts.push('\n' + text.substring(0, 2000));
        } catch { /* */ }
      }

      return { successBoolean: true, responseString: parts.join('\n') };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error clicking element: ${ (error as Error).message }`,
      };
    }
  }
}
