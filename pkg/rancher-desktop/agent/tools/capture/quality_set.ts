import { callCaptureStudio } from '@pkg/main/captureStudioRpc';

import { BaseTool, ToolResponse } from '../base';

const VALID_TARGETS = ['screen', 'camera'] as const;
const VALID_PRESETS = ['auto', '480p', '720p', '1080p', '4k'] as const;

export class QualitySetWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const target = String(input.target || '').toLowerCase() as typeof VALID_TARGETS[number];
    const preset = String(input.preset || '').toLowerCase() as typeof VALID_PRESETS[number];

    if (!VALID_TARGETS.includes(target)) {
      return { successBoolean: false, responseString: `target must be one of: ${ VALID_TARGETS.join(', ') }` };
    }
    if (!VALID_PRESETS.includes(preset)) {
      return { successBoolean: false, responseString: `preset must be one of: ${ VALID_PRESETS.join(', ') }` };
    }

    try {
      await callCaptureStudio(`${ target }.quality`, { preset }, { timeoutMs: 5_000 });
      return { successBoolean: true, responseString: `${ target } quality set to ${ preset }.` };
    } catch (err: any) {
      return { successBoolean: false, responseString: `quality.set failed: ${ err?.message || String(err) }` };
    }
  }
}
