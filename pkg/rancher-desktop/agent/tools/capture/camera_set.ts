import { callCaptureStudio } from '@pkg/main/captureStudioRpc';

import { BaseTool, ToolResponse } from '../base';

export class CameraSetWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const params: Record<string, unknown> = {};
    if (typeof input.deviceId === 'string' && input.deviceId.trim()) {
      params.deviceId = input.deviceId.trim();
    }
    if (typeof input.quality === 'string' && input.quality.trim()) {
      params.quality = input.quality.trim();
    }

    try {
      const r = await callCaptureStudio<{ ok: boolean; deviceId: string | null }>(
        'camera.set', params, { timeoutMs: 10_000 },
      );
      if (!r.ok) return { successBoolean: false, responseString: 'Camera could not be acquired.' };
      return {
        successBoolean: true,
        responseString: `Camera set${ r.deviceId ? ` to device ${ r.deviceId }` : ' to default device' }.`,
      };
    } catch (err: any) {
      return { successBoolean: false, responseString: `camera.set failed: ${ err?.message || String(err) }` };
    }
  }
}
