/**
 * TextToSpeechService – sends text to ElevenLabs Text-to-Speech API
 * and returns audio bytes (mp3).
 */

import { getIntegrationService } from './IntegrationService';

let instance: TextToSpeechService | null = null;

export function getTextToSpeechService(): TextToSpeechService {
  if (!instance) {
    instance = new TextToSpeechService();
  }

  return instance;
}

export class TextToSpeechService {
  private readonly baseUrl = 'https://api.elevenlabs.io/v1';

  /**
   * Convert text to speech audio using ElevenLabs TTS.
   * @param text     The text to speak
   * @param voiceId  ElevenLabs voice ID (falls back to settings if not provided)
   * @returns Audio buffer (mp3) and MIME type
   */
  async speak(text: string, voiceId?: string): Promise<{ audio: Buffer; mimeType: string }> {
    const apiKey = await this.getApiKey();

    if (!apiKey) {
      throw new Error('ElevenLabs API key is not configured. Add it in Integrations → ElevenLabs.');
    }

    const resolvedVoiceId = voiceId || await this.getConfiguredVoice();

    if (!resolvedVoiceId) {
      throw new Error('No ElevenLabs voice selected. Configure one in Audio Settings → Voice.');
    }

    const response = await fetch(`${ this.baseUrl }/text-to-speech/${ resolvedVoiceId }`, {
      method:  'POST',
      headers: {
        'xi-api-key':  apiKey,
        'Content-Type': 'application/json',
        'Accept':       'audio/mpeg',
      },
      body: JSON.stringify({
        text,
        model_id:          'eleven_multilingual_v2',
        voice_settings: {
          stability:        0.5,
          similarity_boost:  0.75,
        },
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      throw new Error(`ElevenLabs TTS failed (${ response.status }): ${ errorBody }`);
    }

    const arrayBuffer = await response.arrayBuffer();

    return {
      audio:    Buffer.from(arrayBuffer),
      mimeType: 'audio/mpeg',
    };
  }

  private async getApiKey(): Promise<string | null> {
    const integrationService = getIntegrationService();
    const value = await integrationService.getIntegrationValue('elevenlabs', 'api_key');

    return value?.value ?? null;
  }

  private async getConfiguredVoice(): Promise<string | null> {
    try {
      const { SullaSettingsModel } = await import('../database/models/SullaSettingsModel');

      return await SullaSettingsModel.get('audioTtsVoice', '') || null;
    } catch {
      return null;
    }
  }
}
