import { callCaptureStudio } from '@pkg/main/captureStudioRpc';

import { BaseTool, ToolResponse } from '../base';

interface CameraDevice {
  deviceId: string;
  label:    string;
}

export class CameraListWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(_input: any): Promise<ToolResponse> {
    try {
      const devices = await callCaptureStudio<CameraDevice[]>('camera.list', {}, { timeoutMs: 8_000 });
      if (!Array.isArray(devices) || devices.length === 0) {
        return { successBoolean: true, responseString: 'No camera devices enumerable — check OS permissions.' };
      }
      const lines = [`${ devices.length } camera device(s):\n`];
      for (const d of devices) {
        lines.push(`- **${ d.deviceId }** ${ d.label || '(unnamed)' }`);
      }
      return { successBoolean: true, responseString: lines.join('\n') };
    } catch (err: any) {
      return { successBoolean: false, responseString: `camera.list failed: ${ err?.message || String(err) }` };
    }
  }
}
