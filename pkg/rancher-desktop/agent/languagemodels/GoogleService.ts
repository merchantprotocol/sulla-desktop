import { BaseLanguageModel, type ChatMessage, type NormalizedResponse, type LLMServiceConfig } from './BaseLanguageModel';
import { getOllamaService } from './OllamaService';
import { writeLLMConversationEvent } from './LLMConversationFileLogger';
import { getIntegrationService } from '../services/IntegrationService';

/**
 * Google Gemini LLM provider.
 *
 * Handles Google-specific:
 * - /v1beta/models/{model}:generateContent endpoint
 * - API key as query param
 * - Gemini content/parts response format
 *
 * @extends BaseLanguageModel
 */
export class GoogleService extends BaseLanguageModel {
  protected declare config: LLMServiceConfig;
  private retryCount = 3;

  /**
   * Create from IntegrationService credentials (active account).
   */
  static async create(): Promise<GoogleService> {
    const integrationService = getIntegrationService();
    const values = await integrationService.getFormValues('google');
    const valMap: Record<string, string> = {};
    for (const v of values) {
      valMap[v.property] = v.value;
    }

    return new GoogleService({
      id: 'google',
      model: valMap.model || 'gemini-2.0-flash',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      apiKey: valMap.api_key || '',
    });
  }

  constructor(config: LLMServiceConfig) {
    super(config);
    this.config = config;
  }

  public setRetryCount(count: number): void {
    this.retryCount = Math.max(0, Math.min(10, count));
  }

  protected async healthCheck(): Promise<boolean> {
    return !!this.apiKey && !!this.baseUrl;
  }

  protected async sendRawRequest(messages: ChatMessage[], options: any): Promise<any> {
    const effectiveModel = options.model ?? this.model;
    const endpoint = `/models/${effectiveModel}:generateContent`;
    const url = `${this.baseUrl}${endpoint}`;
    const body = this.buildRequestBody(messages, options);
    const conversationId = typeof options?.conversationId === 'string' ? options.conversationId : undefined;
    const nodeName = typeof options?.nodeName === 'string' ? options.nodeName : undefined;

    let lastError: unknown = null;

    for (let attempt = 0; attempt <= this.retryCount; attempt++) {
      try {
        if (options?.signal?.aborted) throw new DOMException('Operation aborted', 'AbortError');

        if (attempt > 0) {
          console.log(`[GoogleService] Retry ${attempt}/${this.retryCount} after ${Math.pow(2, attempt-1)}s backoff`);
          await new Promise(r => setTimeout(r, Math.pow(2, attempt - 1) * 1000));
          if (options?.signal?.aborted) throw new DOMException('Aborted during retry backoff', 'AbortError');
        }

        writeLLMConversationEvent({
          direction: 'request',
          provider: 'google',
          model: effectiveModel,
          endpoint,
          nodeName,
          conversationId,
          attempt,
          payload: body,
        });

        const fetchOpts = this.buildFetchOptions(body, options?.signal);
        const res = await fetch(url, fetchOpts);

        if (!res.ok) {
          const text = await res.text().catch(() => '');
          if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
            continue;
          }
          throw new Error(`HTTP ${res.status}: ${text || res.statusText}`);
        }

        const rawResponse = await res.json();
        writeLLMConversationEvent({
          direction: 'response',
          provider: 'google',
          model: effectiveModel,
          endpoint,
          nodeName,
          conversationId,
          attempt,
          payload: rawResponse,
        });

        return rawResponse;
      } catch (err) {
        lastError = err;
        console.log(`[GoogleService] Error on attempt ${attempt}:`, err);
        writeLLMConversationEvent({
          direction: 'error',
          provider: 'google',
          model: effectiveModel,
          endpoint,
          nodeName,
          conversationId,
          attempt,
          payload: err instanceof Error ? { message: err.message, stack: err.stack } : err,
        });

        if (err instanceof Error && /HTTP 4\d\d:/.test(err.message) && !err.message.startsWith('HTTP 429:')) {
          break;
        }
      }
    }

    // Fallback to Ollama
    const ollama = await getOllamaService();
    await ollama.initialize();
    if (ollama.isAvailable()) {
      return ollama.chat(messages, { ...(options ?? {}), model: ollama.getModel() });
    }

    throw lastError ?? new Error('All retries failed and Ollama unavailable');
  }

  /**
   * Build Google Gemini generateContent request body.
   */
  private buildRequestBody(messages: ChatMessage[], options: any): any {
    const sanitizedMessages = messages
      .filter(m => m.role !== 'tool')
      .map(m => {
        if (Array.isArray(m.content)) return { ...m };
        return {
          ...m,
          content: typeof m.content === 'string' ? m.content.trim() : String(m.content ?? '').trim(),
        };
      })
      .filter(m => {
        if (Array.isArray(m.content)) return m.content.length > 0;
        return typeof m.content === 'string' && m.content.length > 0;
      });

    const contents: any[] = sanitizedMessages.map(m => ({
      role: m.role === 'assistant' ? 'model' : m.role,
      parts: Array.isArray(m.content) ? [{ text: JSON.stringify(m.content) }] : [{ text: m.content }],
    }));

    return {
      contents,
      generationConfig: { maxOutputTokens: options.maxTokens },
    };
  }

  /**
   * Google uses API key as query param (or Bearer token).
   */
  protected buildFetchOptions(body: any, signal?: AbortSignal): RequestInit {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }

    return {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    };
  }

  /**
   * Normalize Google Gemini response.
   */
  protected normalizeResponse(raw: any): NormalizedResponse {
    const finishReason = raw.candidates?.[0]?.finishReason;
    const content = raw.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    const usage = raw.usageMetadata ?? {};

    return {
      content: content.trim(),
      metadata: {
        tokens_used: (usage.promptTokenCount ?? 0) + (usage.candidatesTokenCount ?? 0),
        time_spent: 0,
        prompt_tokens: usage.promptTokenCount ?? 0,
        completion_tokens: usage.candidatesTokenCount ?? 0,
        model: this.model,
        tool_calls: undefined,
        finish_reason: this.normalizeFinishReason(finishReason),
        reasoning: undefined,
        parsed_content: undefined,
      },
    };
  }
}

// Factory
let googleInstance: GoogleService | null = null;

export async function getGoogleService(): Promise<GoogleService> {
  if (!googleInstance) {
    googleInstance = await GoogleService.create();
  }
  return googleInstance;
}

export function resetGoogleService(): void {
  googleInstance = null;
}
