import { BaseTool, ToolResponse } from '../base';

import { callCaptureStudio } from '@pkg/main/captureStudioRpc';

export class SpeakerStartWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(_input: any): Promise<ToolResponse> {
    try {
      const result = await callCaptureStudio<{ ok: boolean; mode: 'native' | 'blackhole' }>(
        'system.enable', {}, { timeoutMs: 30_000 },
      );
      return {
        successBoolean: result.ok,
        responseString: `Desktop-audio capture ready (${ result.mode === 'native' ? 'Electron native loopback' : 'BlackHole fallback' }).`,
      };
    } catch (err: any) {
      return { successBoolean: false, responseString: `speaker_start failed: ${ err?.message || String(err) }` };
    }
  }
}
