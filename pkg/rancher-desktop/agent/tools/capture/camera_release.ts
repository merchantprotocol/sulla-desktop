import { callCaptureStudio, isCaptureStudioReady } from '@pkg/main/captureStudioRpc';

import { BaseTool, ToolResponse } from '../base';

export class CameraReleaseWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(_input: any): Promise<ToolResponse> {
    if (!isCaptureStudioReady()) {
      return { successBoolean: true, responseString: 'Capture Studio is not running — nothing to release.' };
    }
    try {
      await callCaptureStudio('camera.release', {}, { timeoutMs: 5_000 });
      return { successBoolean: true, responseString: 'Camera released.' };
    } catch (err: any) {
      return { successBoolean: false, responseString: `camera.release failed: ${ err?.message || String(err) }` };
    }
  }
}
