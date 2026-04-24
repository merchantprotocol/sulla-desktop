import { MicrophoneDriverController } from '@pkg/main/audio-driver/controller/MicrophoneDriverController';
import { SpeakerDriverController }    from '@pkg/main/audio-driver/controller/SpeakerDriverController';

import { BaseTool, ToolResponse } from '../base';

export class AudioStateWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(_input: any): Promise<ToolResponse> {
    const mic     = MicrophoneDriverController.getInstance();
    const speaker = SpeakerDriverController.getInstance();

    const lines = [
      `Mic:     ${ mic.running ? 'running' : 'idle' }${ mic.micName ? ` (${ mic.micName })` : '' }`,
      `Speaker: ${ speaker.running ? 'running' : 'idle' }${ speaker.speakerName ? ` (${ speaker.speakerName })` : '' }`,
    ];

    return { successBoolean: true, responseString: lines.join('\n') };
  }
}
