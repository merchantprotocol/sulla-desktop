import { callCaptureStudio } from '@pkg/main/captureStudioRpc';

import { BaseTool, ToolResponse } from '../base';

interface RecorderStopResult {
  stopped:    boolean;
  sessionDir: string | null;
}

export class RecorderStopWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(_input: any): Promise<ToolResponse> {
    try {
      const r = await callCaptureStudio<RecorderStopResult>('recorder.stop', {}, { timeoutMs: 30_000 });
      if (!r.stopped) {
        return { successBoolean: false, responseString: 'Recorder was not running.' };
      }
      return {
        successBoolean: true,
        responseString: `Recording stopped. Session saved to: ${ r.sessionDir ?? '(unknown)' }`,
      };
    } catch (err: any) {
      return { successBoolean: false, responseString: `recorder.stop failed: ${ err?.message || String(err) }` };
    }
  }
}
