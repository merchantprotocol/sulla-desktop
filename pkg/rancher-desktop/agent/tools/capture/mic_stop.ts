import { MicrophoneDriverController } from '@pkg/main/audio-driver/controller/MicrophoneDriverController';

import { BaseTool, ToolResponse } from '../base';

const SERVICE_ID = 'agent-capture-tool';

export class MicStopWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(_input: any): Promise<ToolResponse> {
    const mic = MicrophoneDriverController.getInstance();
    if (!mic.running) {
      return { successBoolean: true, responseString: 'Microphone is already stopped.' };
    }
    await mic.stop(SERVICE_ID);
    return {
      successBoolean: true,
      responseString: mic.running
        ? 'Microphone still running — other services are holding the capture open.'
        : 'Microphone capture stopped.',
    };
  }
}
