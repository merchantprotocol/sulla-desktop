import { callCaptureStudio } from '@pkg/main/captureStudioRpc';

import { BaseTool, ToolResponse } from '../base';

interface RecorderStartResult {
  started:    boolean;
  sessionDir: string | null;
  reason:     string | null;
}

export class RecorderStartWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(_input: any): Promise<ToolResponse> {
    try {
      const r = await callCaptureStudio<RecorderStartResult>('recorder.start', {}, { timeoutMs: 30_000 });
      if (!r.started) {
        return { successBoolean: false, responseString: `Recorder did not start: ${ r.reason || 'unknown reason' }.` };
      }
      return { successBoolean: true, responseString: `Recording started. Session dir: ${ r.sessionDir }` };
    } catch (err: any) {
      return { successBoolean: false, responseString: `recorder.start failed: ${ err?.message || String(err) }` };
    }
  }
}
