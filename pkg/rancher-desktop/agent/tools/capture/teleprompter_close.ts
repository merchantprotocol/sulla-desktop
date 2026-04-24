import { closeTeleprompterWindow, isTeleprompterOpen } from '@pkg/main/teleprompterWindow';

import { BaseTool, ToolResponse } from '../base';

export class TeleprompterCloseWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(_input: any): Promise<ToolResponse> {
    if (!isTeleprompterOpen()) {
      return { successBoolean: true, responseString: 'Teleprompter was already closed.' };
    }
    closeTeleprompterWindow();
    return { successBoolean: true, responseString: 'Teleprompter window closed.' };
  }
}
