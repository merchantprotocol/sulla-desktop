import { BaseTool, ToolResponse } from '../base';

import { callCaptureStudio, isCaptureStudioReady } from '@pkg/main/captureStudioRpc';

export class SpeakerStopWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(_input: any): Promise<ToolResponse> {
    if (!isCaptureStudioReady()) {
      return { successBoolean: true, responseString: 'Speaker capture is already stopped.' };
    }
    try {
      await callCaptureStudio('system.disable', {}, { timeoutMs: 10_000 });
      return { successBoolean: true, responseString: 'Speaker capture stopped.' };
    } catch (err: any) {
      return { successBoolean: false, responseString: `speaker_stop failed: ${ err?.message || String(err) }` };
    }
  }
}
