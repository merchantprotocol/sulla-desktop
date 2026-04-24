import { isTeleprompterOpen, sendStyle } from '@pkg/main/teleprompterWindow';

import { BaseTool, ToolResponse } from '../base';

export class TeleprompterStyleWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    if (!isTeleprompterOpen()) {
      return { successBoolean: false, responseString: 'Teleprompter is not open — call capture/teleprompter_open first.' };
    }

    const opts: { fontSize?: number; highlightColor?: string } = {};
    if (input.fontSize !== undefined && input.fontSize !== null) {
      const n = Number(input.fontSize);
      if (!Number.isFinite(n) || n < 10 || n > 120) {
        return { successBoolean: false, responseString: 'fontSize must be a number between 10 and 120.' };
      }
      opts.fontSize = n;
    }
    if (typeof input.highlightColor === 'string' && input.highlightColor.trim()) {
      opts.highlightColor = input.highlightColor.trim();
    }

    if (Object.keys(opts).length === 0) {
      return { successBoolean: false, responseString: 'At least one of { fontSize, highlightColor } is required.' };
    }

    sendStyle(opts);
    return { successBoolean: true, responseString: `Teleprompter style updated: ${ JSON.stringify(opts) }.` };
  }
}
