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
    const openaiMessages = this.convertToOpenAIMessages(messages);

    // Some servers (e.g. vLLM with DeepSeek chat templates) require system
    // messages to appear before any other role. Hoist them to the front while
    // preserving relative order within each group.
    const systemMsgs = openaiMessages.filter((m: any) => m.role === 'system');
    const otherMsgs  = openaiMessages.filter((m: any) => m.role !== 'system');
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
   * Convert internal state messages (which may contain Anthropic-style
   * tool_use/tool_result content blocks) into proper OpenAI chat format:
   *
   * - Assistant messages with tool_use blocks → { role: "assistant", content, tool_calls }
   * - User messages with tool_result blocks → one { role: "tool", content, tool_call_id } per result
   * - Everything else → { role, content } with string content
   */
  protected convertToOpenAIMessages(messages: ChatMessage[]): any[] {
    const result: any[] = [];

    for (const m of messages) {
      // Skip legacy role:tool messages (we reconstruct them from content blocks)
      if (m.role === 'tool') continue;

      // --- Assistant message with Anthropic-style tool_use content blocks ---
      if (m.role === 'assistant' && Array.isArray(m.content)) {
        const toolUseBlocks = m.content.filter((b: any) => b?.type === 'tool_use');
        const textBlocks = m.content.filter((b: any) => b?.type === 'text' && b?.text?.trim());
        const textContent = textBlocks.map((b: any) => b.text).join('\n').trim() || null;

        if (toolUseBlocks.length > 0) {
          const toolCalls = toolUseBlocks.map((b: any) => ({
            id: b.id,
            type: 'function' as const,
            function: {
              name: b.name,
              arguments: typeof b.input === 'string' ? b.input : JSON.stringify(b.input ?? {}),
            },
          }));
          result.push({
            role: 'assistant',
            content: textContent,
            tool_calls: toolCalls,
          });
          continue;
        }

        // Array content but no tool_use — flatten to string
        if (textContent) {
          result.push({ role: 'assistant', content: textContent });
        }
        continue;
      }

      // --- User message with Anthropic-style tool_result content blocks ---
      if (m.role === 'user' && Array.isArray(m.content)) {
        const toolResultBlocks = m.content.filter((b: any) => b?.type === 'tool_result');
        const textBlocks = m.content.filter((b: any) => b?.type !== 'tool_result');

        // Emit one role:tool message per tool_result block
        for (const block of toolResultBlocks) {
          const content = typeof block.content === 'string'
            ? block.content
            : JSON.stringify(block.content ?? '');
          result.push({
            role: 'tool',
            tool_call_id: block.tool_use_id,
            content,
          });
        }

        // If there were also non-tool text blocks, emit them as a user message
        const remainingText = textBlocks
          .map((b: any) => {
            if (typeof b === 'string') return b;
            if (typeof b.content === 'string') return b.content;
            if (typeof b.text === 'string') return b.text;
            return '';
          })
          .filter(Boolean)
          .join('\n')
          .trim();
        if (remainingText) {
          result.push({ role: 'user', content: remainingText });
        }
        continue;
      }

      // --- Standard string-content message ---
      const content = typeof m.content === 'string'
        ? m.content.trim()
        : String(m.content ?? '').trim();
      if (content) {
        result.push({ role: m.role, content });
      }
    }

    return result;
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
