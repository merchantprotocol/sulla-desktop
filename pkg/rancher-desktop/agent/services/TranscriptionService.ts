/**
 * TranscriptionService – sends audio to ElevenLabs Speech-to-Text API
 * and returns transcribed text.
 */

import { getIntegrationService } from './IntegrationService';

let instance: TranscriptionService | null = null;

export function getTranscriptionService(): TranscriptionService {
  if (!instance) {
    instance = new TranscriptionService();
  }

  return instance;
}

export class TranscriptionService {
  private readonly baseUrl = 'https://api.elevenlabs.io/v1';

  /**
   * Transcribe an audio buffer using ElevenLabs Speech-to-Text.
   * @param audio    Raw audio bytes (WAV, WebM, MP3, etc.)
   * @param mimeType MIME type of the audio (e.g. 'audio/webm')
   * @returns The transcribed text
   */
  async transcribe(audio: Buffer, mimeType: string): Promise<string> {
    const apiKey = await this.getApiKey();

    if (!apiKey) {
      throw new Error('ElevenLabs API key is not configured. Add it in Integrations → ElevenLabs.');
    }

    const ext = this.mimeToExtension(mimeType);
    const blob = new Blob([audio], { type: mimeType });

    const formData = new FormData();
    formData.append('file', blob, `recording.${ ext }`);
    formData.append('model_id', 'scribe_v1');

    const response = await fetch(`${ this.baseUrl }/speech-to-text`, {
      method:  'POST',
      headers: { 'xi-api-key': apiKey },
      body:    formData,
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      throw new Error(`ElevenLabs transcription failed (${ response.status }): ${ errorBody }`);
    }

    const result = await response.json() as { text?: string };

    if (!result.text || !result.text.trim()) {
      throw new Error('ElevenLabs returned empty transcription.');
    }

    return result.text.trim();
  }

  private async getApiKey(): Promise<string | null> {
    const integrationService = getIntegrationService();
    const value = await integrationService.getIntegrationValue('elevenlabs', 'api_key');

    return value?.value ?? null;
  }

  private mimeToExtension(mimeType: string): string {
    const map: Record<string, string> = {
      'audio/webm':       'webm',
      'audio/ogg':        'ogg',
      'audio/wav':        'wav',
      'audio/x-wav':      'wav',
      'audio/mp3':        'mp3',
      'audio/mpeg':       'mp3',
      'audio/mp4':        'mp4',
      'audio/x-m4a':      'm4a',
      'audio/webm;codecs=opus': 'webm',
    };

    return map[mimeType] || 'webm';
  }
}
