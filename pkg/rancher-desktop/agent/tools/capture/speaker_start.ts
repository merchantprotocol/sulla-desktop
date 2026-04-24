import { SpeakerDriverController } from '@pkg/main/audio-driver/controller/SpeakerDriverController';

import { BaseTool, ToolResponse } from '../base';

const SERVICE_ID = 'agent-capture-tool';

export class SpeakerStartWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(_input: any): Promise<ToolResponse> {
    const speaker = SpeakerDriverController.getInstance();
    await speaker.start(SERVICE_ID, undefined);
    return {
      successBoolean: true,
      responseString: `Desktop-audio (speaker) capture started (device: ${ speaker.speakerName || 'default loopback' }).`,
    };
  }
}
