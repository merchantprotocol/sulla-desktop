import { BaseLanguageModel, type ChatMessage, type NormalizedResponse, type LLMServiceConfig, FinishReason } from './BaseLanguageModel';
import { getOllamaService } from './OllamaService';
import { writeLLMConversationEvent } from './LLMConversationFileLogger';

/**
 * OpenAI-compatible remote LLM provider base class.
 *
 * Handles:
 * - /chat/completions endpoint (standard OpenAI shape)
 * - Automatic retry on 429/5xx
 * - Fallback to local Ollama on final failure
 * - Normalized token usage & timing
 *
 * Providers that use the OpenAI-compatible API (Grok, OpenAI, Kimi, NVIDIA, Custom)
 * extend this class directly. Non-compatible providers (Anthropic, Google) extend
 * BaseLanguageModel instead.
 *
 * @extends BaseLanguageModel
 */
export class OpenAICompatibleService extends BaseLanguageModel {
  protected declare config: LLMServiceConfig;
  protected retryCount = 3;
  protected defaultTimeoutMs = 60_000;
  protected chatEndpoint = '/chat/completions';

  constructor(config: LLMServiceConfig) {
    super(config);
    this.config = config;
  }

  /**
   * Set number of retries on rate-limit/server errors.
   */
  public setRetryCount(count: number): void {
    this.retryCount = Math.max(0, Math.min(10, count));
  }

  /**
   * Lightweight health check — verifies config presence.
   * Override in subclass for real ping if needed.
   */
  protected async healthCheck(): Promise<boolean> {
    return !!this.apiKey && !!this.baseUrl;
  }

  /**
   * Send request to remote provider with retry + Ollama fallback.
   */
  protected async sendRawRequest(messages: ChatMessage[], options: any): Promise<any> {
    const url = `${this.baseUrl}${this.chatEndpoint}`;
    const body = this.buildRequestBody(messages, options);
    const conversationId = typeof options?.conversationId === 'string' ? options.conversationId : undefined;
    const nodeName = typeof options?.nodeName === 'string' ? options.nodeName : undefined;

    let lastError: unknown = null;

    for (let attempt = 0; attempt <= this.retryCount; attempt++) {
      try {
        if (options?.signal?.aborted) throw new Error('Aborted');

        if (attempt > 0) {
          console.log(`[${this.constructor.name}] Retry ${attempt}/${this.retryCount} after ${Math.pow(2, attempt-1)}s backoff`);
          await new Promise(r => setTimeout(r, Math.pow(2, attempt - 1) * 1000));
        }

        writeLLMConversationEvent({
          direction: 'request',
          provider: this.config.id,
          model: options.model ?? this.model,
          endpoint: this.chatEndpoint,
          nodeName,
          conversationId,
          attempt,
          payload: body,
        });

        const payload = this.buildFetchOptions(body, options?.signal);
        const res = await fetch(url, payload);

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
          provider: this.config.id,
          model: options.model ?? this.model,
          endpoint: this.chatEndpoint,
          nodeName,
          conversationId,
          attempt,
          payload: rawResponse,
        });

        return rawResponse;
      } catch (err) {
        lastError = err;
        console.log(`[${this.constructor.name}] Error on attempt ${attempt}:`, err);
        writeLLMConversationEvent({
          direction: 'error',
          provider: this.config.id,
          model: options.model ?? this.model,
          endpoint: this.chatEndpoint,
          nodeName,
          conversationId,
          attempt,
          payload: err instanceof Error ? { message: err.message, stack: err.stack } : err,
        });

        // Do not retry non-rate-limit 4xx client errors
        if (err instanceof Error && /HTTP 4\d\d:/.test(err.message) && !err.message.startsWith('HTTP 429:')) {
          break;
        }
      }
    }

    // Final fallback to Ollama
    const ollama = await this.getFallbackLocalService();
    await ollama.initialize();
    if (ollama.isAvailable()) {
      const localModel = ollama.getModel();
      const fallbackOptions = {
        ...(options ?? {}),
        model: localModel,
      };

      const localResponse = await ollama.chat(messages, fallbackOptions);
      if (localResponse) {
        return this.toOpenAiCompatibleRawResponse(localResponse, localModel);
      }
    }

    throw lastError ?? new Error('All retries failed and Ollama unavailable');
  }

  protected async getFallbackLocalService() {
    return getOllamaService();
  }

  /**
   * Build OpenAI-compatible request body.
   * Subclasses can override for custom body shapes.
   */
  protected buildRequestBody(messages: ChatMessage[], options: any): any {
    const sanitizedMessages = this.sanitizeMessages(messages);
    const baseMessages: any[] = sanitizedMessages.map(m => ({ role: m.role, content: m.content }));

    // Some servers (e.g. vLLM with DeepSeek chat templates) require system
    // messages to appear before any other role. Hoist them to the front while
    // preserving relative order within each group.
    const systemMsgs = baseMessages.filter(m => m.role === 'system');
    const otherMsgs  = baseMessages.filter(m => m.role !== 'system');
    const orderedMessages = [...systemMsgs, ...otherMsgs];

    const body: any = {
      model: options.model ?? this.model,
      messages: orderedMessages,
    };

    if (options.maxTokens) {
      body.max_tokens = options.maxTokens;
    }

    if (options.tools?.length) {
      body.tools = options.tools;
    }

    if (options.format === 'json') {
      body.response_format = { type: 'json_object' };
    }

    return body;
  }

  /**
   * Sanitize messages: trim string content, strip role:tool legacy messages,
   * preserve native content arrays (tool_use/tool_result blocks).
   */
  protected sanitizeMessages(messages: ChatMessage[]): ChatMessage[] {
    return messages
      .filter(m => m.role !== 'tool')
      .map(m => {
        if (Array.isArray(m.content)) {
          // Flatten Anthropic-style content blocks (tool_result, text, etc.)
          // into a plain string for OpenAI-compatible endpoints.
          const flat = m.content
            .map((block: any) => {
              if (typeof block === 'string') return block;
              if (typeof block.content === 'string') return block.content;
              if (typeof block.text === 'string') return block.text;
              return '';
            })
            .filter(Boolean)
            .join('\n');
          return { ...m, content: flat.trim() };
        }
        return {
          ...m,
          content: typeof m.content === 'string' ? m.content.trim() : String(m.content ?? '').trim(),
        };
      })
      .filter(m => typeof m.content === 'string' && m.content.length > 0);
  }

  /**
   * Build fetch options with Bearer token auth.
   * Override in subclass for custom auth headers.
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

  private toOpenAiCompatibleRawResponse(localResponse: NormalizedResponse, model: string): any {
    const toolCalls = localResponse.metadata.tool_calls?.map((tc) => ({
      id: tc.id,
      type: 'function',
      function: {
        name: tc.name,
        arguments: JSON.stringify(tc.args ?? {}),
      },
    }));

    return {
      choices: [
        {
          message: {
            content: localResponse.content,
            ...(toolCalls?.length ? { tool_calls: toolCalls } : {}),
          },
          finish_reason: localResponse.metadata.finish_reason ?? FinishReason.Stop,
        },
      ],
      usage: {
        prompt_tokens: localResponse.metadata.prompt_tokens ?? 0,
        completion_tokens: localResponse.metadata.completion_tokens ?? 0,
        total_tokens: localResponse.metadata.tokens_used
          ?? ((localResponse.metadata.prompt_tokens ?? 0) + (localResponse.metadata.completion_tokens ?? 0)),
      },
      model,
    };
  }
}
