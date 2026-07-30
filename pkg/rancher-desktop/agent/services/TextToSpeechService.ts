/**
 * TextToSpeechService – converts text to speech audio bytes (mp3).
 *
 * Provider-aware: routes to the cloud TTS provider selected in Audio Settings
 * (`audioTtsProvider`). Supported providers:
 *   - `elevenlabs` — ElevenLabs streaming endpoint, eleven_flash_v2_5 (lowest latency).
 *   - `grok`       — xAI Grok Text-to-Speech (`POST https://api.x.ai/v1/tts`).
 * (The keyless `system` / native-OS voice is handled entirely in the renderer by
 * TTSPlayerService and never reaches this main-process service.)
 * Includes retry with exponential backoff and request timeouts.
 */

import { getIntegrationService } from './IntegrationService';

let instance: TextToSpeechService | null = null;

export function getTextToSpeechService(): TextToSpeechService {
  if (!instance) {
    instance = new TextToSpeechService();
  }

  return instance;
}

// Jessica — ElevenLabs default voice
const DEFAULT_VOICE_ID = 'cgSgspJ2msm6clMCkdW9';

// Grok TTS — https://api.x.ai/v1/tts. `eve` is xAI's default voice.
const GROK_TTS_URL = 'https://api.x.ai/v1/tts';
const GROK_DEFAULT_VOICE = 'eve';

const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 500;
const REQUEST_TIMEOUT_MS = 15_000;

// Status codes that are worth retrying (transient failures)
const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);

export class TextToSpeechService {
  private readonly baseUrl = 'https://api.elevenlabs.io/v1';

  /**
   * Convert text to speech audio using the provider selected in Audio Settings.
   * @param text     The text to speak
   * @param voiceId  Provider-specific voice id (falls back to the saved setting)
   * @returns Audio buffer (mp3) and MIME type
   */
  async speak(text: string, voiceId?: string): Promise<{ audio: Buffer; mimeType: string }> {
    const provider = await this.getProvider();

    if (provider === 'grok') {
      return this.speakGrok(text, voiceId);
    }

    return this.speakElevenLabs(text, voiceId);
  }

  /**
   * ElevenLabs TTS via the streaming endpoint (eleven_flash_v2_5).
   */
  private async speakElevenLabs(text: string, voiceId?: string): Promise<{ audio: Buffer; mimeType: string }> {
    const apiKey = await this.getApiKey();

    if (!apiKey) {
      throw new Error('ElevenLabs API key is not configured. Add it in Integrations → ElevenLabs.');
    }

    const resolvedVoiceId = voiceId || await this.getConfiguredVoice() || DEFAULT_VOICE_ID;

    let lastError: Error | null = null;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const delay = INITIAL_BACKOFF_MS * Math.pow(2, attempt - 1);
        await new Promise(r => setTimeout(r, delay));
      }

      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

        const response = await fetch(`${ this.baseUrl }/text-to-speech/${ resolvedVoiceId }/stream`, {
          method:  'POST',
          signal:  controller.signal,
          headers: {
            'xi-api-key':   apiKey,
            'Content-Type': 'application/json',
            Accept:         'audio/mpeg',
          },
          body: JSON.stringify({
            text,
            model_id:       'eleven_flash_v2_5',
            voice_settings: {
              stability:        0.5,
              similarity_boost: 0.75,
            },
            optimize_streaming_latency: 3,
          }),
        });

        clearTimeout(timeout);

        if (!response.ok) {
          const errorBody = await response.text().catch(() => '');
          lastError = new Error(`ElevenLabs TTS failed (${ response.status }): ${ errorBody }`);

          if (RETRYABLE_STATUS_CODES.has(response.status)) {
            continue; // retry
          }
          throw lastError; // non-retryable (e.g. 401, 400)
        }

        const arrayBuffer = await response.arrayBuffer();

        return {
          audio:    Buffer.from(arrayBuffer),
          mimeType: 'audio/mpeg',
        };
      } catch (err: any) {
        lastError = err;
        // Retry on network errors and aborts (timeout), but not on non-retryable HTTP errors
        if (err.name === 'AbortError') {
          lastError = new Error(`ElevenLabs TTS request timed out after ${ REQUEST_TIMEOUT_MS }ms`);
          continue;
        }
        if (err.message?.includes('fetch failed') || err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
          continue; // network error, retry
        }
        throw err; // non-retryable
      }
    }

    throw lastError || new Error('ElevenLabs TTS failed after retries');
  }

  private async getApiKey(): Promise<string | null> {
    const integrationService = getIntegrationService();
    const value = await integrationService.getIntegrationValue('elevenlabs', 'api_key');

    return value?.value ?? null;
  }

  private async getConfiguredVoice(): Promise<string | null> {
    try {
      const { SullaSettingsModel } = await import('../database/models/SullaSettingsModel');
      const voice = await SullaSettingsModel.get('audioTtsVoice', '') || null;

      // ElevenLabs voice IDs are 20-char alphanumeric strings.
      // Reject old invalid values (e.g. plain names like "Rachel").
      if (voice && /^[a-zA-Z0-9]{15,}$/.test(voice)) {
        return voice;
      }

      return null;
    } catch {
      return null;
    }
  }

  // ─── Grok TTS ─────────────────────────────────────────────────

  /**
   * xAI Grok Text-to-Speech (`POST https://api.x.ai/v1/tts`). Returns mp3 bytes.
   * Uses the metered xAI API key (Bearer) — the Grok OAuth subscription token is
   * rejected by api.x.ai, so TTS specifically needs the pasted api_key.
   */
  private async speakGrok(text: string, voiceId?: string): Promise<{ audio: Buffer; mimeType: string }> {
    const apiKey = await this.getGrokApiKey();

    if (!apiKey) {
      throw new Error('Grok API key is not configured. Add your xAI API key in Integrations → Grok.');
    }

    const voice = voiceId || await this.getConfiguredVoiceRaw() || GROK_DEFAULT_VOICE;

    let lastError: Error | null = null;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const delay = INITIAL_BACKOFF_MS * Math.pow(2, attempt - 1);
        await new Promise(r => setTimeout(r, delay));
      }

      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

        const response = await fetch(GROK_TTS_URL, {
          method:  'POST',
          signal:  controller.signal,
          headers: {
            Authorization:  `Bearer ${ apiKey }`,
            'Content-Type': 'application/json',
          },
          // Default output is MP3 24kHz/128kbps; `auto` lets Grok detect the language.
          body: JSON.stringify({
            text,
            voice_id: voice,
            language: 'auto',
          }),
        });

        clearTimeout(timeout);

        if (!response.ok) {
          const errorBody = await response.text().catch(() => '');
          lastError = new Error(`Grok TTS failed (${ response.status }): ${ errorBody }`);

          if (RETRYABLE_STATUS_CODES.has(response.status)) {
            continue; // retry
          }
          throw lastError; // non-retryable (e.g. 401, 400)
        }

        const arrayBuffer = await response.arrayBuffer();

        return {
          audio:    Buffer.from(arrayBuffer),
          mimeType: 'audio/mpeg',
        };
      } catch (err: any) {
        lastError = err;
        if (err.name === 'AbortError') {
          lastError = new Error(`Grok TTS request timed out after ${ REQUEST_TIMEOUT_MS }ms`);
          continue;
        }
        if (err.message?.includes('fetch failed') || err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
          continue; // network error, retry
        }
        throw err; // non-retryable
      }
    }

    throw lastError || new Error('Grok TTS failed after retries');
  }

  private async getGrokApiKey(): Promise<string | null> {
    const integrationService = getIntegrationService();
    const value = await integrationService.getIntegrationValue('grok', 'api_key');

    return value?.value ?? null;
  }

  // ─── Provider / voice resolution ──────────────────────────────

  private async getProvider(): Promise<string> {
    try {
      const { SullaSettingsModel } = await import('../database/models/SullaSettingsModel');

      return (await SullaSettingsModel.get('audioTtsProvider', 'elevenlabs')) || 'elevenlabs';
    } catch {
      return 'elevenlabs';
    }
  }

  /** Raw saved voice id, no provider-specific validation (Grok voice ids are short words). */
  private async getConfiguredVoiceRaw(): Promise<string | null> {
    try {
      const { SullaSettingsModel } = await import('../database/models/SullaSettingsModel');

      return (await SullaSettingsModel.get('audioTtsVoice', '')) || null;
    } catch {
      return null;
    }
  }
}
