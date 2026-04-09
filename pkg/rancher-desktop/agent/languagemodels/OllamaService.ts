import { createHash } from 'node:crypto';
import { SullaSettingsModel } from '../database/models/SullaSettingsModel';
import {
  BaseLanguageModel,
  FinishReason,
  type ChatMessage,
  type NormalizedResponse,
  type StreamCallbacks,
  getTextContent,
} from './BaseLanguageModel';
import { readSSEEvents } from './SSEStreamReader';
import { getIntegrationService } from '../services/IntegrationService';
import { getLlamaCppService } from '../services/LlamaCppService';

// ─────────────────────────────────────────────────────────────
// Accurate token counting via js-tiktoken (already in dep tree via LangChain)
// ─────────────────────────────────────────────────────────────

let _encoder: { encode: (text: string) => number[] } | null = null;
let _encoderLoadFailed = false;

function getTokenEncoder(): { encode: (text: string) => number[] } | null {
  if (_encoder) return _encoder;
  if (_encoderLoadFailed) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { encodingForModel } = require('js-tiktoken');
    _encoder = encodingForModel('gpt-4o');
    return _encoder;
  } catch {
    _encoderLoadFailed = true;
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// LRU response cache for deterministic (temperature=0) requests
// ─────────────────────────────────────────────────────────────

interface CacheEntry {
  response: any;
  timestamp: number;
}

const RESPONSE_CACHE_MAX = 64;
const RESPONSE_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

const responseCache = new Map<string, CacheEntry>();

function cacheKey(body: Record<string, any>): string {
  const hash = createHash('sha256');
  hash.update(JSON.stringify(body.messages));
  if (body.tools) hash.update(JSON.stringify(body.tools));
  if (body.response_format) hash.update(JSON.stringify(body.response_format));
  hash.update(body.model || '');
  return hash.digest('hex');
}

function getCached(key: string): any | null {
  const entry = responseCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > RESPONSE_CACHE_TTL_MS) {
    responseCache.delete(key);
    return null;
  }
  // Move to end (most recently used)
  responseCache.delete(key);
  responseCache.set(key, entry);
  return entry.response;
}

function setCached(key: string, response: any): void {
  // Evict oldest entries if at capacity
  while (responseCache.size >= RESPONSE_CACHE_MAX) {
    const oldest = responseCache.keys().next().value;
    if (oldest !== undefined) responseCache.delete(oldest);
  }
  responseCache.set(key, { response, timestamp: Date.now() });
}

// ─────────────────────────────────────────────────────────────
// OllamaService
// ─────────────────────────────────────────────────────────────

/**
 * Local LLM provider — wraps llama-server's OpenAI-compatible API.
 *
 * Extends BaseLanguageModel to provide unified interface for the local llama-server
 * instance (port 30114). Uses /v1/chat/completions (OpenAI format).
 * The base class normalizeResponse() already handles OpenAI response shape.
 *
 * @extends BaseLanguageModel
 */
export class OllamaService extends BaseLanguageModel {
  protected localTimeoutSeconds: number;

  static async create() {
    // Try IntegrationService first, fall back to SullaSettingsModel
    let base = 'http://127.0.0.1:30114';
    let model = '';
    try {
      const integrationService = getIntegrationService();
      const values = await integrationService.getFormValues('ollama');
      const valMap: Record<string, string> = {};
      for (const v of values) {
        valMap[v.property] = v.value;
      }
      if (valMap.base_url) base = valMap.base_url;
      if (valMap.model) model = valMap.model;
    } catch {
      // IntegrationService not ready yet — use legacy settings
      model = await SullaSettingsModel.get('sullaModel', '');
    }
    const timeout = 600; // 10 minutes — generous for local models with large prompts

    return new OllamaService(model, base, timeout);
  }

  private constructor(localModel: string, ollamaBase: string, localTimeoutSeconds: number) {
    super({
      mode: 'local',
      localModel,
      ollamaBase,
      localTimeoutSeconds,
    });
    this.localTimeoutSeconds = localTimeoutSeconds;
  }

  /**
   * Check if llama-server is reachable AND has a model loaded.
   * A bare /health returning {"status":"ok"} doesn't mean the server can
   * actually serve completions — it may have no model loaded, causing
   * requests to hang until timeout.
   */
  protected async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(`${ this.baseUrl }/health`, {
        signal: AbortSignal.timeout(4000),
      });
      if (!res.ok) return false;

      // Quick probe: ask /v1/models to confirm at least one model is loaded
      try {
        const modelsRes = await fetch(`${ this.baseUrl }/v1/models`, {
          signal: AbortSignal.timeout(4000),
        });
        if (modelsRes.ok) {
          const body = await modelsRes.json();
          const models = body?.data;
          if (!Array.isArray(models) || models.length === 0) {
            console.log('[OllamaService] Server healthy but no models loaded — marking unavailable');
            return false;
          }
        }
      } catch {
        // If /v1/models isn't supported, fall through to trusting /health
      }

      return true;
    } catch {
      return false;
    }
  }

  /**
   * Core request to llama-server /v1/chat/completions (non-streaming).
   * @override
   */
  protected async sendRawRequest(messages: ChatMessage[], options: any): Promise<any> {
    const body = this.buildRequestBody(messages, options);

    // LRU cache: return cached response for deterministic requests (temperature=0)
    const isDeterministic = (body.temperature === 0 || body.temperature === undefined) && !body.tools?.length;
    const key = isDeterministic ? cacheKey(body) : '';
    if (isDeterministic) {
      const cached = getCached(key);
      if (cached) {
        console.log('[OllamaService] Cache hit — returning cached response');
        return cached;
      }
    }

    console.log('[OllamaService] Sending request to llama-server:', JSON.stringify(body).slice(0, 500));

    const timeoutMs = this.localTimeoutSeconds * 1000;
    const maxRetries = 3;
    const modelLoadWaitMs = 5000;
    let res: Response | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const signal = this.combinedSignal(options.signal, timeoutMs);
      res = await fetch(`${ this.baseUrl }/v1/chat/completions`, this.buildFetchOptions(body, signal));
      console.log('[OllamaService] Response from llama-server:', res.status);

      // 503 "Loading model" — server is up but model isn't ready yet, wait and retry
      if (res.status === 503) {
        const errBody = await res.text().catch(() => '');
        if (errBody.includes('Loading model') && attempt < maxRetries) {
          console.log(`[OllamaService] Model still loading, waiting ${ modelLoadWaitMs / 1000 }s before retry ${ attempt + 1 }/${ maxRetries }...`);
          await new Promise(r => setTimeout(r, modelLoadWaitMs));
          continue;
        }
        throw new Error(`llama-server chat failed: ${ res.status } ${ res.statusText } — ${ errBody }`);
      }

      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        throw new Error(`llama-server chat failed: ${ res.status } ${ res.statusText } — ${ errBody }`);
      }

      break;
    }

    const responseText = await res!.text();

    try {
      const parsed = JSON.parse(responseText);

      // Cache deterministic responses
      if (isDeterministic) {
        setCached(key, parsed);
      }

      return parsed;
    } catch (e) {
      throw new Error(`Failed to parse llama-server response as JSON: ${ e }`);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Streaming support (llama-server speaks the same OpenAI SSE protocol)
  // ─────────────────────────────────────────────────────────────

  /**
   * Initiate a streaming request to llama-server's /v1/chat/completions.
   * Returns the raw Response whose body is an SSE stream.
   */
  protected override async sendStreamRequest(
    messages: ChatMessage[],
    options: any,
  ): Promise<Response | null> {
    const body = this.buildRequestBody(messages, options);
    body.stream = true;

    const timeoutMs = this.localTimeoutSeconds * 1000;
    const maxRetries = 3;
    const modelLoadWaitMs = 5000;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        if (options?.signal?.aborted) {
          throw new DOMException('Operation aborted', 'AbortError');
        }

        const signal = this.combinedSignal(options?.signal, timeoutMs);
        const res = await fetch(`${ this.baseUrl }/v1/chat/completions`, this.buildFetchOptions(body, signal));

        // 503 "Loading model" — wait and retry
        if (res.status === 503) {
          const errBody = await res.text().catch(() => '');
          if (errBody.includes('Loading model') && attempt < maxRetries) {
            console.log(`[OllamaService] Stream: model still loading, waiting ${ modelLoadWaitMs / 1000 }s before retry ${ attempt + 1 }/${ maxRetries }...`);
            await new Promise(r => setTimeout(r, modelLoadWaitMs));
            continue;
          }
        }

        if (!res.ok) {
          const text = await res.text().catch(() => '');
          console.warn(`[OllamaService] Stream request failed: ${ res.status } ${ text || res.statusText }`);
          return null;
        }

        return res;
      } catch (err) {
        if (attempt === maxRetries) {
          console.warn('[OllamaService] Streaming failed, falling back to non-streaming:', err);
          return null;
        }
      }
    }

    return null;
  }

  /**
   * Parse an OpenAI-compatible SSE stream into token callbacks + NormalizedResponse.
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
            toolCallDeltas.set(idx, { id: tc.id || '', name: tc.function?.name || '', arguments: '' });
          }

          const existing = toolCallDeltas.get(idx)!;
          if (tc.id) existing.id = tc.id;
          if (tc.function?.name) existing.name = tc.function.name;
          if (tc.function?.arguments) existing.arguments += tc.function.arguments;
        }
      }

      if (choice.finish_reason) {
        finishReason = choice.finish_reason;
      }

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
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args ?? {} });
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

  // ─────────────────────────────────────────────────────────────
  // Token counting — uses js-tiktoken when available, falls back to char estimate
  // ─────────────────────────────────────────────────────────────

  /**
   * Count tokens accurately via js-tiktoken BPE encoder.
   * Falls back to ~4 chars/token heuristic if tiktoken is unavailable.
   */
  private static estimateTokens(content: string | any): number {
    const text = typeof content === 'string' ? content : getTextContent(content);
    if (!text) return 0;

    const encoder = getTokenEncoder();
    if (encoder) {
      try {
        return encoder.encode(text).length;
      } catch {
        // Fall through to heuristic
      }
    }

    return Math.ceil(text.length / 4);
  }

  /**
   * Get the context size limit from llama-server, with a safe fallback.
   */
  private getContextLimit(): number {
    try {
      return getLlamaCppService().contextSize;
    } catch {
      return 4096;
    }
  }

  override getContextWindow(): number {
    return this.getContextLimit();
  }

  /**
   * Build the request body in OpenAI /v1/chat/completions format.
   * Uses smart context trimming: system messages and the first+last user messages
   * are pinned and never trimmed. Tool-result messages are also pinned.
   */
  private buildRequestBody(messages: ChatMessage[], options: any): Record<string, any> {
    // Strip legacy role:tool messages; flatten native content arrays to string.
    // Ensure system messages come first — required by Qwen/llama.cpp Jinja templates.
    const cleaned = messages
      .filter((m: ChatMessage) => m.role !== 'tool')
      .map((m: ChatMessage) => {
        // Only pass role + content (strip internal metadata fields)
        const msg: Record<string, any> = { role: m.role, content: '' };
        if (Array.isArray(m.content)) {
          // Convert Anthropic-style content blocks to OpenAI-compatible format
          // for llama-server's /v1/chat/completions endpoint.
          const images: string[] = [];
          const textParts: string[] = [];
          for (const c of m.content as any[]) {
            if (c?.type === 'image' && c?.source?.type === 'base64') {
              const mediaType = c.source.media_type || 'image/png';
              images.push(`data:${ mediaType };base64,${ c.source.data }`);
            } else if (c?.type === 'tool_result' && Array.isArray(c.content)) {
              for (const inner of c.content) {
                if (inner?.type === 'image' && inner?.source?.type === 'base64') {
                  const mediaType = inner.source.media_type || 'image/png';
                  images.push(`data:${ mediaType };base64,${ inner.source.data }`);
                } else if (inner?.type === 'text') {
                  textParts.push(inner.text);
                }
              }
              if (typeof c.content === 'string') textParts.push(c.content);
            } else if (typeof c === 'string') {
              textParts.push(c);
            } else if (c?.text) {
              textParts.push(c.text);
            } else if (c?.type !== 'image') {
              textParts.push(JSON.stringify(c));
            }
          }
          if (images.length > 0) {
            // Use OpenAI vision format: content is an array of text + image_url parts
            const contentParts: any[] = [];
            if (textParts.length > 0) {
              contentParts.push({ type: 'text', text: textParts.join('\n') });
            }
            for (const dataUri of images) {
              contentParts.push({ type: 'image_url', image_url: { url: dataUri } });
            }
            msg.content = contentParts;
          } else {
            msg.content = textParts.join('\n');
          }
        } else {
          msg.content = m.content;
        }
        if (m.name) msg.name = m.name;
        return msg;
      });

    const systemMsgs = cleaned.filter(m => m.role === 'system');
    const nonSystemMsgs = cleaned.filter(m => m.role !== 'system');

    // Trim non-system messages to stay under context limit.
    // Reserve 20% of context for model response tokens.
    const ctxLimit = this.getContextLimit();
    const responseReserve = Math.floor(ctxLimit * 0.20);
    const inputBudget = ctxLimit - responseReserve;

    const systemTokens = systemMsgs.reduce((sum, m) => sum + OllamaService.estimateTokens(m.content), 0);

    // Smart trimming: pin the first user message (sets context), the last message
    // (current turn), and any tool_result messages (contain critical execution data).
    // Only trim the middle of the conversation.
    const trimmed = this.smartTrim(nonSystemMsgs, inputBudget - systemTokens);

    if (trimmed.length < nonSystemMsgs.length) {
      const totalUsed = systemTokens + trimmed.reduce((sum, m) => sum + OllamaService.estimateTokens(m.content), 0);
      console.log(`[OllamaService] Trimmed ${ nonSystemMsgs.length - trimmed.length } messages to fit ctx limit (${ ctxLimit } tokens, ~${ totalUsed } used)`);
    }

    const cleanMessages = [...systemMsgs, ...trimmed];

    const body: Record<string, any> = {
      model:            options.model ?? this.model,
      messages:         cleanMessages,
      stream:           false,
      enable_thinking:  false,
    };

    if (options.format === 'json') {
      body.response_format = { type: 'json_object' };
    }

    if (options.maxTokens) {
      body.max_tokens = options.maxTokens;
    }

    if (options.temperature !== undefined) {
      body.temperature = options.temperature;
    }

    // Add tools when provided (OpenAI-compatible tool format)
    if (options.tools?.length) {
      body.tools = options.tools;
    }

    return body;
  }

  /**
   * Smart context trimming: keeps the first user message (sets conversation context),
   * the last few messages (current turn), and any tool_result content blocks.
   * Trims from the middle of the conversation, oldest first.
   */
  private smartTrim(messages: Record<string, any>[], tokenBudget: number): Record<string, any>[] {
    if (messages.length <= 2) return messages;

    // Calculate total tokens
    let totalTokens = messages.reduce((sum, m) => sum + OllamaService.estimateTokens(m.content), 0);
    if (totalTokens <= tokenBudget) return messages;

    // Identify pinned indices: first message, last 2 messages, and tool_result messages
    const pinned = new Set<number>();
    pinned.add(0);                           // first user message (sets context)
    pinned.add(messages.length - 1);          // last message (current turn)
    if (messages.length > 2) pinned.add(messages.length - 2); // previous turn

    // Pin messages containing tool results (critical execution data)
    for (let i = 0; i < messages.length; i++) {
      const content = messages[i].content;
      if (typeof content === 'string' && content.includes('tool_result')) {
        pinned.add(i);
      }
    }

    // Build list of trimmable indices (middle of conversation, oldest first)
    const trimmable: number[] = [];
    for (let i = 1; i < messages.length - 2; i++) {
      if (!pinned.has(i)) {
        trimmable.push(i);
      }
    }

    // Remove oldest trimmable messages until we fit
    const removed = new Set<number>();
    for (const idx of trimmable) {
      if (totalTokens <= tokenBudget) break;
      totalTokens -= OllamaService.estimateTokens(messages[idx].content);
      removed.add(idx);
    }

    return messages.filter((_, i) => !removed.has(i));
  }

  // normalizeResponse() is inherited from BaseLanguageModel — it already
  // handles the OpenAI /v1/chat/completions response shape.

  /**
   * Legacy convenience method — prefer .chat()
   */
  public async generate(prompt: string, options?: { signal?: AbortSignal }): Promise<NormalizedResponse | null> {
    return this.chat([{ role: 'user', content: prompt }], options);
  }
}

// Singleton export (optional — you can also just `await OllamaService.create()`)
let ollamaInstance: OllamaService | null = null;

export async function getOllamaService(): Promise<OllamaService> {
  if (!ollamaInstance) {
    ollamaInstance = await OllamaService.create();
  }
  return ollamaInstance;
}

/** Clear the cached singleton so the next getOllamaService() re-reads settings */
export function resetOllamaService(): void {
  ollamaInstance = null;
}
