import { isTeleprompterOpen } from '@pkg/main/teleprompterWindow';

import { BaseTool, ToolResponse } from '../base';

export class TeleprompterStatusWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(_input: any): Promise<ToolResponse> {
    const open = isTeleprompterOpen();
    return {
      successBoolean: true,
      responseString: open ? 'Teleprompter is open.' : 'Teleprompter is closed.',
    };
  }
}
