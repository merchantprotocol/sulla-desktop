import { callCaptureStudio, isCaptureStudioReady } from '@pkg/main/captureStudioRpc';

import { BaseTool, ToolResponse } from '../base';

interface RecorderStatusResult {
  recording:      boolean;
  elapsedSeconds: number;
  bytesWritten:   number;
  sessionDir:     string | null;
  error:          string | null;
}

export class RecorderStatusWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(_input: any): Promise<ToolResponse> {
    // Fast path: if no CaptureStudio is registered, we can report idle
    // without forcing the studio window to open just to answer a status
    // query.
    if (!isCaptureStudioReady()) {
      return {
        successBoolean: true,
        responseString: 'Capture Studio is not running — recorder is idle.',
      };
    }
    try {
      const r = await callCaptureStudio<RecorderStatusResult>('recorder.status', {}, { timeoutMs: 5_000 });
      const lines = [
        `Recording: ${ r.recording ? 'yes' : 'no' }`,
        `Elapsed:   ${ r.elapsedSeconds.toFixed(1) }s`,
        `Bytes:     ${ r.bytesWritten }`,
        `Session:   ${ r.sessionDir ?? '(none)' }`,
      ];
      if (r.error) lines.push(`Error:     ${ r.error }`);
      return { successBoolean: true, responseString: lines.join('\n') };
    } catch (err: any) {
      return { successBoolean: false, responseString: `recorder.status failed: ${ err?.message || String(err) }` };
    }
  }
}
