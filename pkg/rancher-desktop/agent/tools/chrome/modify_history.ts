import { BaseTool, ToolResponse } from '../base';

import { getChromeApi } from '@pkg/main/chromeApi';

/**
 * Modify History Tool — add, delete, or clear browsing history entries.
 */
export class ModifyHistoryWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const chrome = getChromeApi();
    const action = input.action as string;

    try {
      switch (action) {
      case 'add': {
        if (!input.url) {
          return { successBoolean: false, responseString: '"url" is required for add action.' };
        }

        await chrome.history.addUrl({ url: input.url, title: input.title });

        return {
          successBoolean: true,
          responseString: `Added to history: ${ input.title || input.url }`,
        };
      }

      case 'delete': {
        if (!input.url) {
          return { successBoolean: false, responseString: '"url" is required for delete action.' };
        }

        await chrome.history.deleteUrl({ url: input.url });

        return {
          successBoolean: true,
          responseString: `Deleted history entries for: ${ input.url }`,
        };
      }

      case 'deleteAll': {
        await chrome.history.deleteAll();

        return {
          successBoolean: true,
          responseString: 'All browsing history cleared.',
        };
      }

      default:
        return { successBoolean: false, responseString: `Unknown action: ${ action }. Use add, delete, or deleteAll.` };
      }
    } catch (error) {
      return { successBoolean: false, responseString: `History operation failed: ${ (error as Error).message }` };
    }
  }
}
