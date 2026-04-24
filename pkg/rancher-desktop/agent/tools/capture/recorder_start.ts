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

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    // Normalize auto-acquire params for the renderer handler. "auto"
    // means "any available source" → we pass boolean true. An explicit
    // id/deviceId string passes through. If the agent omits everything,
    // toggleRecord() uses whatever sources the user already picked in
    // the Capture Studio UI.
    const params: Record<string, unknown> = {};
    if (typeof input.screen === 'string' && input.screen.trim()) {
      params.screen = input.screen.trim().toLowerCase() === 'auto' ? true : input.screen.trim();
    }
    if (typeof input.camera === 'string' && input.camera.trim()) {
      params.camera = input.camera.trim().toLowerCase() === 'auto' ? true : input.camera.trim();
    }
    if (input.mic === true)     params.mic = true;
    if (input.speaker === true) params.speaker = true;

    try {
      const r = await callCaptureStudio<RecorderStartResult>('recorder.start', params, { timeoutMs: 30_000 });
      if (!r.started) {
        return { successBoolean: false, responseString: `Recorder did not start: ${ r.reason || 'unknown reason' }.` };
      }
      return { successBoolean: true, responseString: `Recording started. Session dir: ${ r.sessionDir }` };
    } catch (err: any) {
      return { successBoolean: false, responseString: `recorder.start failed: ${ err?.message || String(err) }` };
    }
  }
}
