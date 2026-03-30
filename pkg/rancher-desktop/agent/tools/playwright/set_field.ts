import { BaseTool, ToolResponse } from '../base';
import { resolveBridge, isBridgeResolved } from './resolve_bridge';
import { waitForNavigation, formatPageState } from './wait_for_navigation';

/**
 * Set Field Tool - Sets the value of a form field on a website asset.
 *
 * If setting the field triggers navigation (e.g., form auto-submit),
 * waits for the new page and returns the full page state.
 */
export class SetFieldWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { handle, value } = input;
    const result = await resolveBridge(input.assetId);
    if (!isBridgeResolved(result)) return result;

    try {
      // Listen for navigation before setting the field
      const navPromise = waitForNavigation(result.assetId);

      const success = await result.bridge.setValue(handle, value);

      if (!success) {
        return {
          successBoolean: false,
          responseString: `[${ result.assetId }] Field not found: ${ handle }. Use get_page_snapshot to see available form fields.`,
        };
      }

      // Submit the form by pressing Enter if requested
      if (input.submit) {
        await result.bridge.pressKey('Enter', handle);
        // Give the page time to process the submission and update
        await new Promise(r => setTimeout(r, 1500));
      }

      // Check if setting the field triggered navigation (auto-submit, etc.)
      const navResult = await navPromise;

      if (navResult && navResult.navigated) {
        const pageState = formatPageState(result.assetId, navResult);
        return {
          successBoolean: true,
          responseString: `[${ result.assetId }] Set field ${ handle } = "${ value }"${ input.submit ? ' and submitted' : '' } → page navigated.\n\n${ pageState }`,
        };
      }

      // When submit was requested, read the page state even without navigation
      // (SPA pages update in place without triggering navigation events)
      if (input.submit) {
        try {
          const snapshot = await result.bridge.getActionableMarkdown();
          const readerContent = await result.bridge.getReaderContent();
          const content = readerContent?.content
            ? `\n\nPage content:\n${ readerContent.content.slice(0, 4000) }`
            : (snapshot ? `\n\nInteractive elements:\n${ snapshot.slice(0, 2000) }` : '');
          return {
            successBoolean: true,
            responseString: `[${ result.assetId }] Set field ${ handle } = "${ value }" and submitted.${ content }`,
          };
        } catch {
          return {
            successBoolean: true,
            responseString: `[${ result.assetId }] Set field ${ handle } = "${ value }" and submitted. Use get_page_snapshot to see results.`,
          };
        }
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
