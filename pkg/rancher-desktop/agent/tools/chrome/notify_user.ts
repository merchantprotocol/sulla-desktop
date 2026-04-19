import { BaseTool, ToolResponse } from '../base';

import { getChromeApi } from '@pkg/main/chromeApi';

/**
 * Notify User Tool — send a desktop notification.
 *
 * Use this to alert the user when async work completes, errors occur,
 * or anything needs their attention while they're in another app.
 */
export class NotifyUserWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const chrome = getChromeApi();

    try {
      const id = input.id || `notify-${ Date.now() }`;

      await chrome.notifications.create(id, {
        title:   input.title,
        message: input.message,
        silent:  input.silent ?? false,
      });

      return {
        successBoolean: true,
        responseString: `Desktop notification sent: "${ input.title }"`,
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Failed to send notification: ${ (error as Error).message }`,
      };
    }
  }
}
