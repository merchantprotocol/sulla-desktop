import { SpeakerDriverController } from '@pkg/main/audio-driver/controller/SpeakerDriverController';

import { BaseTool, ToolResponse } from '../base';

const SERVICE_ID = 'agent-capture-tool';

export class SpeakerStopWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(_input: any): Promise<ToolResponse> {
    const speaker = SpeakerDriverController.getInstance();
    if (!speaker.running) {
      return { successBoolean: true, responseString: 'Speaker capture is already stopped.' };
    }
    await speaker.stop(SERVICE_ID);
    return {
      successBoolean: true,
      responseString: speaker.running
        ? 'Speaker still running — other services are holding the capture open.'
        : 'Speaker capture stopped.',
    };
  }
}
