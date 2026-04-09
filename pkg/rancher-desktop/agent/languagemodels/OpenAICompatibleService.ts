import { BaseLanguageModel, type ChatMessage, type NormalizedResponse, type StreamCallbacks, type LLMServiceConfig, FinishReason } from './BaseLanguageModel';
import { readSSEEvents } from './SSEStreamReader';
import { getOllamaService } from './OllamaService';

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
  protected defaultTimeoutMs = 180_000;
  protected chatEndpoint = '/chat/completions';

  constructor(config: LLMServiceConfig) {
    super(config);
    this.config = config;
  }

  override getContextWindow(): number {
    return 128_000;
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
   * Send request to remote provider with retry + local LLM fallback.
   */
  protected async sendRawRequest(messages: ChatMessage[], options: any): Promise<any> {
    const url = `${ this.baseUrl }${ this.chatEndpoint }`;
    const body = this.buildRequestBody(messages, options);
    const conversationId = typeof options?.conversationId === 'string' ? options.conversationId : undefined;
    const nodeName = typeof options?.nodeName === 'string' ? options.nodeName : undefined;

    let lastError: unknown = null;

    for (let attempt = 0; attempt <= this.retryCount; attempt++) {
      try {
        if (options?.signal?.aborted) throw new DOMException('Operation aborted', 'AbortError');

        if (attempt > 0) {
          console.log(`[${ this.constructor.name }] Retry ${ attempt }/${ this.retryCount } after ${ Math.pow(2, attempt - 1) }s backoff`);
          await new Promise(r => setTimeout(r, Math.pow(2, attempt - 1) * 1000));
          if (options?.signal?.aborted) throw new DOMException('Aborted during retry backoff', 'AbortError');
        }

        const timeoutMs = options?.timeoutSeconds ? options.timeoutSeconds * 1000 : this.defaultTimeoutMs;
        const signal = this.combinedSignal(options?.signal, timeoutMs);
        const payload = this.buildFetchOptions(body, signal);
        const res = await fetch(url, payload);

        if (!res.ok) {
          const text = await res.text().catch(() => '');

          // 429 with insufficient_quota is permanent — don't retry
          if (res.status === 429 && text.includes('insufficient_quota')) {
            const parsed = this.parseProviderError(text);
            throw new Error(`Quota exhausted for ${ this.model }: ${ parsed }`);
          }

          if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
            lastError = new Error(`HTTP ${ res.status }: ${ text || res.statusText }`);
            console.warn(`[${ this.constructor.name }] ${ res.status } on attempt ${ attempt + 1 }/${ this.retryCount + 1 }: ${ text || res.statusText }`);
            continue;
          }
          throw new Error(`HTTP ${ res.status }: ${ text || res.statusText }`);
        }

        const rawResponse = await res.json();

        // Detect empty completions — provider returned 200 but no usable content
        const choice = rawResponse?.choices?.[0];
        if (!choice || (!choice.message?.content?.trim() && !choice.message?.tool_calls?.length)) {
          const finishReason = choice?.finish_reason ?? 'unknown';
          console.warn(`[${ this.constructor.name }] Provider returned empty response (finish_reason=${ finishReason }, model=${ this.model })`);
          lastError = new Error(`Provider returned empty completion (finish_reason=${ finishReason }, model=${ this.model }) — possible quota exhaustion, content filter, or model unavailability`);
          continue;
        }

        return rawResponse;
      } catch (err) {
        lastError = err;
        console.log(`[${ this.constructor.name }] Error on attempt ${ attempt }:`, err);

        // On 401, try refreshing credentials from DB and retry once
        if (err instanceof Error && err.message.startsWith('HTTP 401:')) {
          const refreshed = await this.refreshCredentials();
          if (refreshed && attempt === 0) {
            console.log(`[${ this.constructor.name }] Credentials refreshed after 401 — retrying`);
            continue;
          }
          break;
        }

        // Do not retry non-rate-limit 4xx client errors
        if (err instanceof Error && /HTTP 4\d\d:/.test(err.message) && !err.message.startsWith('HTTP 429:')) {
          break;
        }
      }
    }

    // Final fallback to local LLM (llama.cpp) — only if it's actually healthy and has a model
    try {
      const local = await this.getFallbackLocalService();
      await local.initialize();
      if (local.isAvailable()) {
        console.log(`[${ this.constructor.name }] Falling back to local LLM (${ local.getModel() })`);
        const localModel = local.getModel();
        const fallbackOptions = {
          ...(options ?? {}),
          model: localModel,
        };

        const localResponse = await local.chat(messages, fallbackOptions);
        if (localResponse) {
          return this.toOpenAiCompatibleRawResponse(localResponse, localModel);
        }
      } else {
        console.log(`[${ this.constructor.name }] Local LLM fallback skipped — not available`);
      }
    } catch (localErr) {
      console.warn(`[${ this.constructor.name }] Local LLM fallback failed:`, localErr instanceof Error ? localErr.message : String(localErr));
    }

    throw lastError ?? new Error(`All retries failed for ${ this.model } and local LLM unavailable`);
  }

  // ─────────────────────────────────────────────────────────────
  // Streaming support
  // ─────────────────────────────────────────────────────────────

  /**
   * Initiate a streaming request to the OpenAI-compatible endpoint.
   * Returns the raw Response whose body is an SSE stream.
   */
  protected override async sendStreamRequest(
    messages: ChatMessage[],
    options: any,
  ): Promise<Response | null> {
    const url = `${ this.baseUrl }${ this.chatEndpoint }`;
    const body = this.buildRequestBody(messages, options);

    body.stream = true;

    let lastError: unknown = null;

    for (let attempt = 0; attempt <= this.retryCount; attempt++) {
      try {
        if (options?.signal?.aborted) {
          throw new DOMException('Operation aborted', 'AbortError');
        }

        if (attempt > 0) {
          console.log(`[${ this.constructor.name }] Stream retry ${ attempt }/${ this.retryCount }`);
          await new Promise(r => setTimeout(r, Math.pow(2, attempt - 1) * 1000));
          if (options?.signal?.aborted) {
            throw new DOMException('Aborted during retry backoff', 'AbortError');
          }
        }

        const timeoutMs = options?.timeoutSeconds
          ? options.timeoutSeconds * 1000
          : this.defaultTimeoutMs;
        const signal = this.combinedSignal(options?.signal, timeoutMs);
        const payload = this.buildFetchOptions(body, signal);
        const res = await fetch(url, payload);

        if (!res.ok) {
          const text = await res.text().catch(() => '');

          // 429 with insufficient_quota is permanent — don't retry, throw immediately
          if (res.status === 429 && text.includes('insufficient_quota')) {
            const parsed = this.parseProviderError(text);
            throw new Error(`Quota exhausted for ${ this.model }: ${ parsed }`);
          }

          if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
            console.warn(`[${ this.constructor.name }] Stream ${ res.status } on attempt ${ attempt + 1 }/${ this.retryCount + 1 }: ${ text || res.statusText }`);
            continue;
          }
          throw new Error(`HTTP ${ res.status }: ${ text || res.statusText }`);
        }

        return res;
      } catch (err) {
        lastError = err;

        if (err instanceof Error && /HTTP 4\d\d:/.test(err.message) && !err.message.startsWith('HTTP 429:')) {
          break;
        }
      }
    }

    // On stream failure, return null to fall back to non-streaming chat()
    console.warn(`[${ this.constructor.name }] Streaming failed, falling back to non-streaming:`, lastError);

    return null;
  }

  /**
   * Parse an OpenAI-compatible SSE stream into token callbacks + NormalizedResponse.
   *
   * SSE format: data: {"choices":[{"delta":{"content":"..."},"finish_reason":null}]}
   * Terminator: data: [DONE]
   */
  protected override async parseStreamResponse(
    response: Response,
    callbacks: StreamCallbacks,
    signal?: AbortSignal,
  ): Promise<NormalizedResponse> {
    if (!response.body) {
      throw new Error('Response has no body for streaming');
    }

    let content = '';
    let finishReason: string | undefined;
    let reasoning = '';
    const toolCallDeltas: Map<number, { id?: string; name: string; arguments: string }> = new Map();
    let promptTokens = 0;
    let completionTokens = 0;

    for await (const event of readSSEEvents(response.body, signal)) {
      if (event.data === '[DONE]') {
        break;
      }

      let parsed: any;

      try {
        parsed = JSON.parse(event.data);
      } catch {
        continue;
      }

      const choice = parsed.choices?.[0];

      if (!choice) {
        // Usage-only chunk (some providers send usage in a separate final chunk)
        if (parsed.usage) {
          promptTokens = parsed.usage.prompt_tokens ?? promptTokens;
          completionTokens = parsed.usage.completion_tokens ?? completionTokens;
        }
        continue;
      }

      const delta = choice.delta;

      if (delta?.content) {
        content += delta.content;
        callbacks.onToken(delta.content);
      }

      if (delta?.reasoning_content || delta?.reasoning) {
        reasoning += delta.reasoning_content || delta.reasoning || '';
      }

      // Accumulate streamed tool calls by index
      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;

          if (!toolCallDeltas.has(idx)) {
            toolCallDeltas.set(idx, {
              id:        tc.id || '',
              name:      tc.function?.name || '',
              arguments: '',
            });
          }

          const existing = toolCallDeltas.get(idx)!;

          if (tc.id) {
            existing.id = tc.id;
          }
          if (tc.function?.name) {
            existing.name = tc.function.name;
          }
          if (tc.function?.arguments) {
            existing.arguments += tc.function.arguments;
          }
        }
      }

      if (choice.finish_reason) {
        finishReason = choice.finish_reason;
      }

      // Capture usage from the chunk if present
      if (parsed.usage) {
        promptTokens = parsed.usage.prompt_tokens ?? promptTokens;
        completionTokens = parsed.usage.completion_tokens ?? completionTokens;
      }
    }

    // Assemble tool calls from accumulated deltas
    const toolCalls: { id?: string; name: string; args: any }[] = [];

    for (const [, tc] of toolCallDeltas) {
      let args: any = {};

      try {
        args = JSON.parse(tc.arguments || '{}');
      } catch {
        args = tc.arguments || {};
      }
      toolCalls.push({ id: tc.id, name: tc.name, args });
    }

    // Build rawProviderContent (Anthropic-style content blocks for state persistence)
    let rawProviderContent: any;

    if (toolCalls.length > 0) {
      const blocks: any[] = [];

      if (content.trim()) {
        blocks.push({ type: 'text', text: content.trim() });
      }
      for (const tc of toolCalls) {
        blocks.push({
          type:  'tool_use',
          id:    tc.id,
          name:  tc.name,
          input: tc.args ?? {},
        });
      }
      rawProviderContent = blocks;
    }

    return {
      content: content.trim(),
      metadata: {
        tokens_used:        promptTokens + completionTokens,
        time_spent:         0, // filled by chatStream()
        prompt_tokens:      promptTokens,
        completion_tokens:  completionTokens,
        model:              this.model,
        tool_calls:         toolCalls.length > 0 ? toolCalls : undefined,
        finish_reason:      this.normalizeFinishReason(finishReason),
        reasoning:          reasoning.trim() || undefined,
        rawProviderContent,
      },
    };
  }

  protected async getFallbackLocalService() {
    // If the user disabled the local server, don't try to fall back to it
    const { SullaSettingsModel } = await import('../database/models/SullaSettingsModel');
    const modelMode = await SullaSettingsModel.get('modelMode', 'local');
    if (modelMode === 'remote') {
      throw new Error('Local model server disabled by user');
    }
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
    const otherMsgs = openaiMessages.filter((m: any) => m.role !== 'system');
    const orderedMessages = [...systemMsgs, ...otherMsgs];

    const body: any = {
      model:    options.model ?? this.model,
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
            id:       b.id,
            type:     'function' as const,
            function: {
              name:      b.name,
              arguments: typeof b.input === 'string' ? b.input : JSON.stringify(b.input ?? {}),
            },
          }));

          // Alibaba / DashScope coding models require function.arguments to be
          // valid JSON.  When the LLM returns malformed arguments (e.g. a plain
          // string instead of a JSON object) we stored them as-is.  Re-validate
          // and wrap non-JSON strings so the next request doesn't get rejected.
          for (const tc of toolCalls) {
            const args = tc.function.arguments;
            if (typeof args === 'string') {
              try {
                JSON.parse(args);
              } catch {
                tc.function.arguments = JSON.stringify(args);
              }
            }
          }

          result.push({
            role:       'assistant',
            content:    textContent,
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
        const contentArr = m.content as any[];
        const toolResultBlocks = contentArr.filter((b: any) => b?.type === 'tool_result');
        const imageBlocks = contentArr.filter((b: any) => b?.type === 'image');
        const textBlocks = contentArr.filter((b: any) => b?.type !== 'tool_result' && b?.type !== 'image');

        // Emit one role:tool message per tool_result block.
        // Images inside tool results are extracted and emitted as a separate
        // role:user message, since OpenAI-compatible APIs don't support
        // image_url content blocks in role:tool messages.
        const extractedImages: any[] = [];
        for (const block of toolResultBlocks) {
          if (Array.isArray(block.content)) {
            const textParts: string[] = [];
            for (const inner of block.content) {
              if (inner?.type === 'image' && inner?.source?.type === 'base64') {
                // Collect images to emit as a user message after all tool results
                extractedImages.push({
                  type:      'image_url',
                  image_url: { url: `data:${ inner.source.media_type };base64,${ inner.source.data }` },
                });
              } else if (inner?.type === 'text') {
                textParts.push(inner.text);
              }
            }
            result.push({
              role:         'tool',
              tool_call_id: block.tool_use_id,
              content:      textParts.join('\n') || JSON.stringify(block.content ?? ''),
            });
          } else {
            result.push({
              role:         'tool',
              tool_call_id: block.tool_use_id,
              content:      typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? ''),
            });
          }
        }

        // Emit extracted screenshot images as a user message so vision models can see them
        if (extractedImages.length > 0) {
          result.push({
            role:    'user',
            content: [
              { type: 'text', text: 'Here is the screenshot from the tool result above:' },
              ...extractedImages,
            ],
          });
        }

        // Build remaining content parts (text + images) as a user message
        const contentParts: any[] = [];
        for (const b of textBlocks) {
          const text = typeof b === 'string' ? b : (b.text ?? b.content ?? '');
          if (typeof text === 'string' && text.trim()) {
            contentParts.push({ type: 'text', text: text.trim() });
          }
        }
        for (const b of imageBlocks) {
          if (b?.source?.type === 'base64') {
            contentParts.push({
              type:      'image_url',
              image_url: { url: `data:${ b.source.media_type };base64,${ b.source.data }` },
            });
          }
        }
        if (contentParts.length > 0) {
          // Use array format only when images are present; plain string otherwise
          const hasImages = contentParts.some((p: any) => p.type === 'image_url');
          result.push({
            role:    'user',
            content: hasImages ? contentParts : contentParts.map((p: any) => p.text).join('\n'),
          });
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

    // Safety net: ensure strict tool_calls / tool-response adjacency.
    // If an assistant message has tool_calls but the next message(s) are not
    // role:"tool" responses for every call, strip the tool_calls to prevent
    // the API from rejecting the request (e.g. after a timeout mid-stream).
    const sanitized: any[] = [];
    for (let i = 0; i < result.length; i++) {
      const msg = result[i];
      if (msg.role === 'assistant' && msg.tool_calls?.length) {
        // Collect all immediately-following tool responses
        const followingToolIds = new Set<string>();
        for (let j = i + 1; j < result.length && result[j].role === 'tool'; j++) {
          if (result[j].tool_call_id) followingToolIds.add(result[j].tool_call_id);
        }
        const allAnswered = msg.tool_calls.every((tc: any) => followingToolIds.has(tc.id));
        if (!allAnswered) {
          // Strip tool_calls, keep only text content
          const { tool_calls: _dropped, ...rest } = msg;
          if (rest.content?.trim()) {
            sanitized.push(rest);
          }
          continue;
        }
      }
      sanitized.push(msg);
    }

    return sanitized;
  }

  /**
   * Extract a human-readable error message from a provider JSON error response.
   */
  protected parseProviderError(text: string): string {
    try {
      const json = JSON.parse(text);
      return json?.error?.message || json?.message || text;
    } catch {
      return text;
    }
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
      headers.Authorization = `Bearer ${ this.apiKey }`;
    }

    return {
      method: 'POST',
      headers,
      body:   JSON.stringify(body),
      signal,
    };
  }

  private toOpenAiCompatibleRawResponse(localResponse: NormalizedResponse, model: string): any {
    const toolCalls = localResponse.metadata.tool_calls?.map((tc) => ({
      id:       tc.id,
      type:     'function',
      function: {
        name:      tc.name,
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
        prompt_tokens:     localResponse.metadata.prompt_tokens ?? 0,
        completion_tokens: localResponse.metadata.completion_tokens ?? 0,
        total_tokens:      localResponse.metadata.tokens_used ??
          ((localResponse.metadata.prompt_tokens ?? 0) + (localResponse.metadata.completion_tokens ?? 0)),
      },
      model,
    };
  }
}
