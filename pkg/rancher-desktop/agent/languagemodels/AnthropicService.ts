import { BaseLanguageModel, type ChatMessage, type NormalizedResponse, type StreamCallbacks, type LLMServiceConfig } from './BaseLanguageModel';
import { readSSEEvents } from './SSEStreamReader';
import { getOllamaService } from './OllamaService';
import { getIntegrationService } from '../services/IntegrationService';

/**
 * Anthropic Claude LLM provider.
 *
 * Handles Anthropic-specific:
 * - /v1/messages endpoint
 * - x-api-key auth + anthropic-version header
 * - Content block response format (text, tool_use, thinking)
 * - Strict tool_use/tool_result adjacency validation
 * - Consecutive same-role message merging
 *
 * @extends BaseLanguageModel
 */
export class AnthropicService extends BaseLanguageModel {
  protected declare config: LLMServiceConfig;
  private retryCount = 3;
  private defaultTimeoutMs = 60_000;

  override getContextWindow(): number {
    return 200_000;
  }

  /**
   * Create from IntegrationService credentials (active account).
   */
  static async create(): Promise<AnthropicService> {
    const integrationService = getIntegrationService();
    const values = await integrationService.getFormValues('anthropic');
    const valMap: Record<string, string> = {};
    for (const v of values) {
      valMap[v.property] = v.value;
    }

    return new AnthropicService({
      id:      'anthropic',
      model:   valMap.model || 'claude-sonnet-4-20250514',
      baseUrl: 'https://api.anthropic.com/v1',
      apiKey:  valMap.api_key || '',
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
    const endpoint = '/messages';
    const url = `${ this.baseUrl }${ endpoint }`;
    const body = this.buildRequestBody(messages, options);
    const conversationId = typeof options?.conversationId === 'string' ? options.conversationId : undefined;
    const nodeName = typeof options?.nodeName === 'string' ? options.nodeName : undefined;

    let lastError: unknown = null;

    for (let attempt = 0; attempt <= this.retryCount; attempt++) {
      try {
        if (options?.signal?.aborted) throw new DOMException('Operation aborted', 'AbortError');

        if (attempt > 0) {
          console.log(`[AnthropicService] Retry ${ attempt }/${ this.retryCount } after ${ Math.pow(2, attempt - 1) }s backoff`);
          await new Promise(r => setTimeout(r, Math.pow(2, attempt - 1) * 1000));
          if (options?.signal?.aborted) throw new DOMException('Aborted during retry backoff', 'AbortError');
        }

        const signal = this.combinedSignal(options?.signal, this.defaultTimeoutMs);
        const fetchOpts = this.buildFetchOptions(body, signal);
        const res = await fetch(url, fetchOpts);

        if (!res.ok) {
          const text = await res.text().catch(() => '');
          if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
            continue;
          }
          throw new Error(`HTTP ${ res.status }: ${ text || res.statusText }`);
        }

        const rawResponse = await res.json();

        return rawResponse;
      } catch (err) {
        lastError = err;
        console.log(`[AnthropicService] Error on attempt ${ attempt }:`, err);

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
   * Build Anthropic /messages request body.
   * Handles system message extraction, tool_use/tool_result adjacency,
   * consecutive same-role merging, and final user message requirement.
   */
  protected buildRequestBody(messages: ChatMessage[], options: any): any {
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

    const systemMessage = sanitizedMessages.find(m => m.role === 'system');

    let processedMessages: any[] = sanitizedMessages
      .filter(m => m.role !== 'system')
      .map(m => ({ role: m.role, content: m.content }));

    // Safety net: ensure strict tool_use/tool_result adjacency.
    // Pass 1: drop orphaned tool_result (no matching tool_use before it).
    {
      const pass1: any[] = [];
      for (const msg of processedMessages) {
        if (msg.role === 'user' && Array.isArray(msg.content) &&
            msg.content.some((b: any) => b?.type === 'tool_result')) {
          const prev = pass1[pass1.length - 1];
          if (prev?.role !== 'assistant' || !Array.isArray(prev.content)) {
            continue;
          }
          const prevToolUseIds = new Set(
            prev.content.filter((b: any) => b?.type === 'tool_use' && b?.id).map((b: any) => b.id),
          );
          const allMatched = msg.content
            .filter((b: any) => b?.type === 'tool_result')
            .every((b: any) => prevToolUseIds.has(b.tool_use_id));
          if (!allMatched) continue;
        }
        pass1.push(msg);
      }

      // Pass 2: drop orphaned tool_use (no matching tool_result after it).
      const pass2: any[] = [];
      for (let i = 0; i < pass1.length; i++) {
        const msg = pass1[i];
        if (msg.role === 'assistant' && Array.isArray(msg.content) &&
            msg.content.some((b: any) => b?.type === 'tool_use')) {
          const next = pass1[i + 1];
          if (next?.role !== 'user' || !Array.isArray(next.content) ||
              !next.content.some((b: any) => b?.type === 'tool_result')) {
            const textBlocks = msg.content.filter((b: any) => b?.type === 'text' && b?.text?.trim());
            if (textBlocks.length > 0) {
              pass2.push({ role: 'assistant', content: textBlocks.map((b: any) => b.text).join('\n') });
            }
            continue;
          }
        }
        pass2.push(msg);
      }
      processedMessages = pass2;
    }

    // Merge consecutive same-role string messages
    {
      const merged: any[] = [];
      for (const msg of processedMessages) {
        const prev = merged[merged.length - 1];
        if (prev && prev.role === msg.role &&
            typeof prev.content === 'string' && typeof msg.content === 'string') {
          prev.content = `${ prev.content }\n\n${ msg.content }`;
        } else {
          merged.push(msg);
        }
      }
      processedMessages = merged;
    }

    // Anthropic requires the final turn to be a user message.
    const lastProcessedMessage = processedMessages[processedMessages.length - 1];
    if (lastProcessedMessage?.role !== 'user') {
      processedMessages.push({ role: 'user', content: 'continue' });
    }

    const anthropicBody: any = {
      model:      this.model,
      max_tokens: options.maxTokens ?? 1024,
      messages:   processedMessages,
    };

    if (systemMessage?.content) {
      anthropicBody.system = systemMessage.content;
    }

    // Explicitly disable extended thinking to prevent conflicts with
    // assistant prefill patterns in the conversation history.
    anthropicBody.thinking = { type: 'disabled' };

    if (options.tools?.length) {
      anthropicBody.tools = options.tools.map((tool: any) => {
        if (tool.type === 'function') {
          return {
            type:         'custom',
            name:         tool.function.name,
            description:  tool.function.description,
            input_schema: tool.function.parameters || { type: 'object', properties: {} },
          };
        }
        return tool;
      });
    }

    return anthropicBody;
  }

  /**
   * Anthropic uses x-api-key header + anthropic-version header.
   */
  protected buildFetchOptions(body: any, signal?: AbortSignal): RequestInit {
    const headers: Record<string, string> = {
      'Content-Type':      'application/json',
      'anthropic-version': '2024-10-22',
    };

    if (this.apiKey) {
      headers['x-api-key'] = this.apiKey;
    }

    return {
      method: 'POST',
      headers,
      body:   JSON.stringify(body),
      signal,
    };
  }

  // ─────────────────────────────────────────────────────────────
  // Streaming support
  // ─────────────────────────────────────────────────────────────

  /**
   * Initiate a streaming request to Anthropic /messages with stream: true.
   */
  protected override async sendStreamRequest(
    messages: ChatMessage[],
    options: any,
  ): Promise<Response | null> {
    const url = `${ this.baseUrl }/messages`;
    const body = this.buildRequestBody(messages, options);

    body.stream = true;

    let lastError: unknown = null;

    for (let attempt = 0; attempt <= this.retryCount; attempt++) {
      try {
        if (options?.signal?.aborted) {
          throw new DOMException('Operation aborted', 'AbortError');
        }

        if (attempt > 0) {
          console.log(`[AnthropicService] Stream retry ${ attempt }/${ this.retryCount }`);
          await new Promise(r => setTimeout(r, Math.pow(2, attempt - 1) * 1000));
          if (options?.signal?.aborted) {
            throw new DOMException('Aborted during retry backoff', 'AbortError');
          }
        }

        const signal = this.combinedSignal(options?.signal, this.defaultTimeoutMs);
        const fetchOpts = this.buildFetchOptions(body, signal);
        const res = await fetch(url, fetchOpts);

        if (!res.ok) {
          const text = await res.text().catch(() => '');

          if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
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

    console.warn('[AnthropicService] Streaming failed, falling back to non-streaming:', lastError);

    return null;
  }

  /**
   * Parse Anthropic SSE stream into token callbacks + NormalizedResponse.
   *
   * Anthropic SSE events:
   *   message_start       → usage.input_tokens
   *   content_block_start → content_block type (text, tool_use, thinking)
   *   content_block_delta → text_delta, input_json_delta, thinking_delta
   *   content_block_stop  → block completed
   *   message_delta       → stop_reason, usage.output_tokens
   *   message_stop        → stream complete
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
    let reasoning = '';
    let finishReason: string | undefined;
    let promptTokens = 0;
    let completionTokens = 0;

    // Track active content blocks by index
    const activeBlocks: Map<number, { type: string; id?: string; name?: string; inputJson?: string }> = new Map();
    const toolCalls: { id?: string; name: string; args: any }[] = [];

    for await (const event of readSSEEvents(response.body, signal)) {
      let parsed: any;

      try {
        parsed = JSON.parse(event.data);
      } catch {
        continue;
      }

      switch (parsed.type) {
        case 'message_start':
          promptTokens = parsed.message?.usage?.input_tokens ?? 0;
          break;

        case 'content_block_start': {
          const block = parsed.content_block;
          const idx = parsed.index ?? 0;

          activeBlocks.set(idx, {
            type:      block?.type ?? 'text',
            id:        block?.id,
            name:      block?.name,
            inputJson: '',
          });
          break;
        }

        case 'content_block_delta': {
          const idx = parsed.index ?? 0;
          const delta = parsed.delta;
          const block = activeBlocks.get(idx);

          if (delta?.type === 'text_delta' && delta.text) {
            content += delta.text;
            callbacks.onToken(delta.text);
          } else if (delta?.type === 'input_json_delta' && delta.partial_json && block) {
            // Accumulate tool use input JSON silently (don't emit as tokens)
            block.inputJson = (block.inputJson || '') + delta.partial_json;
          } else if (delta?.type === 'thinking_delta' && delta.thinking) {
            reasoning += delta.thinking;
          }
          break;
        }

        case 'content_block_stop': {
          const idx = parsed.index ?? 0;
          const block = activeBlocks.get(idx);

          if (block?.type === 'tool_use' && block.name) {
            let args: any = {};

            try {
              args = JSON.parse(block.inputJson || '{}');
            } catch {
              args = block.inputJson || {};
            }
            toolCalls.push({ id: block.id, name: block.name, args });
          }
          activeBlocks.delete(idx);
          break;
        }

        case 'message_delta':
          finishReason = parsed.delta?.stop_reason;
          completionTokens = parsed.usage?.output_tokens ?? completionTokens;
          break;

        case 'message_stop':
          // Stream complete
          break;
      }
    }

    // Build rawProviderContent in Anthropic content block format
    const rawBlocks: any[] = [];

    if (reasoning.trim()) {
      rawBlocks.push({ type: 'thinking', text: reasoning.trim() });
    }
    if (content.trim()) {
      rawBlocks.push({ type: 'text', text: content.trim() });
    }
    for (const tc of toolCalls) {
      rawBlocks.push({
        type:  'tool_use',
        id:    tc.id,
        name:  tc.name,
        input: tc.args ?? {},
      });
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
        rawProviderContent: rawBlocks.length > 0 ? rawBlocks : undefined,
      },
    };
  }

  /**
   * Normalize Anthropic response (content blocks, tool_use, thinking/reasoning).
   */
  protected normalizeResponse(raw: any): NormalizedResponse {
    const usage = raw.usage ?? {};
    const finishReason = raw.stop_reason;

    const blocks = raw.content || [];
    const content = blocks
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('\n');

    const reasoning = blocks
      .filter((b: any) => b.type === 'thinking' || b.type === 'reasoning')
      .map((b: any) => b.text)
      .join('\n');

    let toolCalls: { id?: string; name: string; args: any }[] = [];
    if (raw.content?.some((b: any) => b.type === 'tool_use')) {
      toolCalls = raw.content
        .filter((b: any) => b.type === 'tool_use')
        .map((b: any) => ({
          id:   b.id,
          name: b.name,
          args: b.input || {},
        }));
    }

    return {
      content:  content.trim(),
      metadata: {
        tokens_used:        (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
        time_spent:         0,
        prompt_tokens:      usage.input_tokens ?? 0,
        completion_tokens:  usage.output_tokens ?? 0,
        model:              this.model,
        tool_calls:         toolCalls.length > 0 ? toolCalls : undefined,
        finish_reason:      this.normalizeFinishReason(finishReason),
        reasoning:          reasoning.trim() || undefined,
        parsed_content:     undefined,
        rawProviderContent: Array.isArray(raw.content) && raw.content.length > 0 ? raw.content : undefined,
      },
    };
  }
}

// Factory
let anthropicInstance: AnthropicService | null = null;

export async function getAnthropicService(): Promise<AnthropicService> {
  if (!anthropicInstance) {
    anthropicInstance = await AnthropicService.create();
  }
  return anthropicInstance;
}

export function resetAnthropicService(): void {
  anthropicInstance = null;
}
