import { callCaptureStudio } from '@pkg/main/captureStudioRpc';

import { BaseTool, ToolResponse } from '../base';

export class ScreenSetWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const sourceId = typeof input.sourceId === 'string' ? input.sourceId.trim() : '';
    if (!sourceId) {
      return { successBoolean: false, responseString: 'sourceId is required — call capture/list_screens for valid ids.' };
    }
    try {
      await callCaptureStudio('screen.set', { sourceId }, { timeoutMs: 10_000 });
      return { successBoolean: true, responseString: `Screen source set to ${ sourceId }.` };
    } catch (err: any) {
      return { successBoolean: false, responseString: `screen.set failed: ${ err?.message || String(err) }` };
    }
  }
}
