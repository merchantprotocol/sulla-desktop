import { BaseTool, ToolResponse } from '../base';
import { resolveBridge, isBridgeResolved } from './resolve_bridge';

/**
 * Set Field Tool - Sets the value of a form field on a website asset.
 *
 * If submit is true, presses Enter after setting the value and returns
 * the dehydrated DOM so the model sees the new page state immediately.
 */
export class SetFieldWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { handle, value } = input;
    const result = await resolveBridge(input.assetId);
    if (!isBridgeResolved(result)) return result;

    try {
      const success = await result.bridge.setValue(handle, value);

      if (!success) {
        return {
          successBoolean: false,
          responseString: `[${ result.assetId }] Field not found: ${ handle }. Use get_page_snapshot to see available form fields.`,
        };
      }

      // Submit by pressing Enter if requested
      if (input.submit) {
        await result.bridge.pressKey('Enter', handle);
      }

      // If submitted, return dehydrated DOM showing the result
      if (input.submit) {
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
        } catch { /* */ }

        const parts: string[] = [];
        parts.push(`[${ result.assetId }] Set ${ handle } = "${ value }" and submitted`);
        parts.push(`# ${ title }`);
        parts.push(`**URL**: ${ url }`);
        if (tree) {
          parts.push(`**Stats**: ${ stats.tokens ?? '?' } tokens | ${ stats.interactiveCount ?? '?' } interactive | depth ${ stats.depth ?? '?' }`);
          parts.push('');
          parts.push(tree);
        }
        return { successBoolean: true, responseString: parts.join('\n') };
      }

      return {
        successBoolean: true,
        responseString: `[${ result.assetId }] Set field ${ handle } = "${ value }"`,
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error setting field value: ${ (error as Error).message }`,
      };
    }
  }
}
