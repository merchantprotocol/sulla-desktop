import { BaseTool, ToolResponse } from '../base';

import { MicrophoneDriverController } from '@pkg/main/audio-driver/controller/MicrophoneDriverController';
import { SpeakerDriverController } from '@pkg/main/audio-driver/controller/SpeakerDriverController';
import { callCaptureStudio, isCaptureStudioReady } from '@pkg/main/captureStudioRpc';

export class AudioStateWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(_input: any): Promise<ToolResponse> {
    const mic = MicrophoneDriverController.getInstance();
    const speaker = SpeakerDriverController.getInstance();
    let speakerState = speaker.running ? `running (BlackHole${ speaker.speakerName ? `: ${ speaker.speakerName }` : '' })` : 'idle';
    if (isCaptureStudioReady()) {
      try {
        const state = await callCaptureStudio<{ active: boolean; mode: string }>('system.status', {}, { timeoutMs: 5_000 });
        speakerState = state.active ? `running (${ state.mode } loopback)` : 'idle';
      } catch {
        // Fall back to the main-process driver state above.
      }
    }

    const lines = [
      `Mic:     ${ mic.running ? 'running' : 'idle' }${ mic.micName ? ` (${ mic.micName })` : '' }`,
      `Speaker: ${ speakerState }`,
    ];

    return { successBoolean: true, responseString: lines.join('\n') };
  }
}
