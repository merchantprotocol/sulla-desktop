/**
 * TranscriptionService – sends audio for Speech-to-Text transcription.
 *
 * When the Enterprise Sulla integration is configured, audio is routed
 * through the Enterprise Gateway (which proxies to ElevenLabs server-side).
 * Otherwise, falls back to calling ElevenLabs directly using the local API key.
 *
 * Includes retry with exponential backoff and request timeouts.
 */

import { getIntegrationService } from './IntegrationService';

/** Options for transcription requests. */
export interface TranscriptionOptions {
  /** Enable speaker diarization (ElevenLabs returns per-word speaker IDs). */
  diarize?: boolean;
}

/** A single word with optional speaker attribution (from diarization). */
export interface TranscriptionWord {
  text: string;
  speaker_id?: string;
  start?: number;
  end?: number;
}

/** Result from a transcription request. */
export interface TranscriptionResult {
  text: string;
  /** Per-word breakdown with speaker IDs. Only present when diarize=true. */
  words?: TranscriptionWord[];
}

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
  private readonly elevenLabsBaseUrl = 'https://api.elevenlabs.io/v1';

  /**
   * Transcribe an audio buffer.
   *
   * Routes through Enterprise Gateway when configured, otherwise
   * falls back to direct ElevenLabs API.
   */
  async transcribe(audio: Buffer, mimeType: string, options?: TranscriptionOptions): Promise<TranscriptionResult> {
    const gateway = await this.getGatewayConfig();

    if (gateway) {
      return this.transcribeViaGateway(audio, mimeType, gateway, options);
    }

    return this.transcribeViaElevenLabs(audio, mimeType, options);
  }

  // ─── Enterprise Gateway path ────────────────────────────────

  /**
   * Send audio to the Enterprise Gateway for transcription.
   * The gateway proxies to ElevenLabs server-side and returns { text }.
   */
  private async transcribeViaGateway(
    audio: Buffer,
    mimeType: string,
    gateway: { url: string; apiKey: string },
    options?: TranscriptionOptions,
  ): Promise<TranscriptionResult> {
    let lastError: Error | null = null;
    const endpoint = `${ gateway.url.replace(/\/+$/, '') }/api/desktop/transcribe`;

    // Build query params for diarization
    const url = new URL(endpoint);
    if (options?.diarize) {
      url.searchParams.set('diarize', 'true');
    }

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const delay = INITIAL_BACKOFF_MS * Math.pow(2, attempt - 1);
        await new Promise(r => setTimeout(r, delay));
      }

      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

        const response = await fetch(url.toString(), {
          method:  'POST',
          signal:  controller.signal,
          headers: {
            'Content-Type':  mimeType,
            'X-Mime-Type':   mimeType,
            'Authorization': `Bearer ${ gateway.apiKey }`,
          },
          body: new Blob([audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength) as ArrayBuffer], { type: mimeType }),
        });

        clearTimeout(timeout);

        if (!response.ok) {
          const errorBody = await response.text().catch(() => '');
          lastError = new Error(`Gateway transcription failed (${ response.status }): ${ errorBody }`);

          if (RETRYABLE_STATUS_CODES.has(response.status)) {
            continue;
          }
          throw lastError;
        }

        const result = await response.json() as { text?: string; words?: TranscriptionWord[] };

        if (!result.text || !result.text.trim()) {
          throw new Error('Gateway returned empty transcription.');
        }

        return {
          text:  result.text.trim(),
          words: result.words,
        };
      } catch (err: any) {
        lastError = err;
        if (err.name === 'AbortError') {
          lastError = new Error(`Gateway STT request timed out after ${ REQUEST_TIMEOUT_MS }ms`);
          continue;
        }
        if (err.message?.includes('fetch failed') || err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
          continue;
        }
        throw err;
      }
    }

    throw lastError || new Error('Gateway transcription failed after retries');
  }

  // ─── Direct ElevenLabs path (fallback) ──────────────────────

  private async transcribeViaElevenLabs(audio: Buffer, mimeType: string, options?: TranscriptionOptions): Promise<TranscriptionResult> {
    const apiKey = await this.getElevenLabsApiKey();

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
        formData.append('model_id', 'scribe_v2');
        if (options?.diarize) {
          formData.append('diarize', 'true');
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

        const response = await fetch(`${ this.elevenLabsBaseUrl }/speech-to-text`, {
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
            continue;
          }
          throw lastError;
        }

        const result = await response.json() as { text?: string; words?: TranscriptionWord[] };

        if (!result.text || !result.text.trim()) {
          throw new Error('ElevenLabs returned empty transcription.');
        }

        return {
          text:  result.text.trim(),
          words: result.words,
        };
      } catch (err: any) {
        lastError = err;
        if (err.name === 'AbortError') {
          lastError = new Error(`ElevenLabs STT request timed out after ${ REQUEST_TIMEOUT_MS }ms`);
          continue;
        }
        if (err.message?.includes('fetch failed') || err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
          continue;
        }
        throw err;
      }
    }

    throw lastError || new Error('ElevenLabs transcription failed after retries');
  }

  // ─── Config helpers ─────────────────────────────────────────

  /**
   * Check if Enterprise Sulla gateway is configured.
   * Returns { url, apiKey } if both are set, null otherwise.
   */
  private async getGatewayConfig(): Promise<{ url: string; apiKey: string } | null> {
    const integrationService = getIntegrationService();

    const [urlValue, keyValue] = await Promise.all([
      integrationService.getIntegrationValue('enterprise_sulla', 'gateway_url'),
      integrationService.getIntegrationValue('enterprise_sulla', 'api_key'),
    ]);

    const url = urlValue?.value?.trim();
    const apiKey = keyValue?.value?.trim();

    if (url && apiKey) {
      return { url, apiKey };
    }

    return null;
  }

  private async getElevenLabsApiKey(): Promise<string | null> {
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
