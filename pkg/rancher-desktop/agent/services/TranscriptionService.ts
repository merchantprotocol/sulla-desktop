/**
 * TranscriptionService – sends audio to ElevenLabs Speech-to-Text API
 * and returns transcribed text.
 *
 * Includes retry with exponential backoff and request timeouts.
 */

import { getIntegrationService } from './IntegrationService';

let instance: TranscriptionService | null = null;

export function getTranscriptionService(): TranscriptionService {
  if (!instance) {
    instance = new TranscriptionService();
  }

  return instance;
}

const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 500;
const REQUEST_TIMEOUT_MS = 30_000; // STT can take longer than TTS

// Status codes that are worth retrying (transient failures)
const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);

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
    const arrayBuffer = audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength) as ArrayBuffer;
    const blob = new Blob([arrayBuffer], { type: mimeType });

    let lastError: Error | null = null;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const delay = INITIAL_BACKOFF_MS * Math.pow(2, attempt - 1);
        await new Promise(r => setTimeout(r, delay));
      }

      try {
        const formData = new FormData();
        formData.append('file', blob, `recording.${ ext }`);
        formData.append('model_id', 'scribe_v1_experimental');

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

        const response = await fetch(`${ this.baseUrl }/speech-to-text`, {
          method:  'POST',
          signal:  controller.signal,
          headers: { 'xi-api-key': apiKey },
          body:    formData,
        });

        clearTimeout(timeout);

        if (!response.ok) {
          const errorBody = await response.text().catch(() => '');
          lastError = new Error(`ElevenLabs transcription failed (${ response.status }): ${ errorBody }`);

          if (RETRYABLE_STATUS_CODES.has(response.status)) {
            continue; // retry
          }
          throw lastError; // non-retryable
        }

        const result = await response.json() as { text?: string };

        if (!result.text || !result.text.trim()) {
          throw new Error('ElevenLabs returned empty transcription.');
        }

        return result.text.trim();
      } catch (err: any) {
        lastError = err;
        if (err.name === 'AbortError') {
          lastError = new Error(`ElevenLabs STT request timed out after ${ REQUEST_TIMEOUT_MS }ms`);
          continue;
        }
        if (err.message?.includes('fetch failed') || err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
          continue; // network error, retry
        }
        throw err; // non-retryable
      }
    }

    throw lastError || new Error('ElevenLabs transcription failed after retries');
  }

  private async getApiKey(): Promise<string | null> {
    const integrationService = getIntegrationService();
    const value = await integrationService.getIntegrationValue('elevenlabs', 'api_key');

    return value?.value ?? null;
  }

  private mimeToExtension(mimeType: string): string {
    const map: Record<string, string> = {
      'audio/webm':              'webm',
      'audio/ogg':               'ogg',
      'audio/wav':               'wav',
      'audio/x-wav':             'wav',
      'audio/mp3':               'mp3',
      'audio/mpeg':              'mp3',
      'audio/mp4':               'mp4',
      'audio/x-m4a':             'm4a',
      'audio/webm;codecs=opus':  'webm',
    };

    return map[mimeType] || 'webm';
  }
}
