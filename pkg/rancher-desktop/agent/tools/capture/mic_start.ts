import { systemPreferences } from 'electron';

import { MicrophoneDriverController } from '@pkg/main/audio-driver/controller/MicrophoneDriverController';

import { BaseTool, ToolResponse } from '../base';

const SERVICE_ID = 'agent-capture-tool';

export class MicStartWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    // Validate/normalize formats list.
    let formats: string[] | undefined;
    if (Array.isArray(input.formats)) {
      formats = input.formats.filter((s: unknown) => typeof s === 'string' && s.trim())
        .map((s: string) => s.trim());
      if (formats!.length === 0) formats = undefined;
    }

    // macOS needs an explicit permission dance before the capture starts.
    if (process.platform === 'darwin' && systemPreferences.askForMediaAccess) {
      const status = systemPreferences.getMediaAccessStatus('microphone');
      if (status !== 'granted') {
        const granted = await systemPreferences.askForMediaAccess('microphone');
        if (!granted) {
          return { successBoolean: false, responseString: 'Microphone permission denied by the OS.' };
        }
      }
    }

    const mic = MicrophoneDriverController.getInstance();
    await mic.start(SERVICE_ID, undefined, formats ? { formats } : undefined);

    return {
      successBoolean: true,
      responseString: `Microphone capture started (device: ${ mic.micName || 'default' }, formats: ${ formats ? formats.join(',') : 'default' }).`,
    };
  }
}
