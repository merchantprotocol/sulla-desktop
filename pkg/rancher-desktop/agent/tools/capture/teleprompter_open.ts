import { openTeleprompterWindow } from '@pkg/main/teleprompterWindow';

import { BaseTool, ToolResponse } from '../base';

export class TeleprompterOpenWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(_input: any): Promise<ToolResponse> {
    openTeleprompterWindow();
    return { successBoolean: true, responseString: 'Teleprompter window opened.' };
  }
}
