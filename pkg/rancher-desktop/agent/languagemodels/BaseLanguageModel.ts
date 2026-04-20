// ILLMService - Common interface for all LLM services (local and remote)
// This allows the agent to use either Ollama or remote APIs interchangeably

export enum FinishReason {
  Stop = 'stop',
  ToolCalls = 'tool_calls',
  Length = 'length',
  ContentFilter = 'content_filter',
}

/**
 * Content block types for multimodal messages (images, tool results, etc.).
 * Uses Anthropic's native format — other providers convert in buildRequestBody().
 */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'tool_use'; id: string; name: string; input: any }
  | { type: 'tool_result'; tool_use_id: string; content: string | ContentBlock[] }
  | { type: 'thinking'; thinking: string };

/**
 * Extract the plain-text content from a ChatMessage's content field.
 * Handles both string and ContentBlock[] formats.
 */
export function getTextContent(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content ?? '');
  return content
    .filter((b): b is { type: 'text'; text: string } => b?.type === 'text' && typeof (b as any).text === 'string')
    .map(b => b.text)
    .join('\n');
}

export interface ChatMessage {
  id?:           string;
  role:          'user' | 'assistant' | 'system' | 'tool';
  content:       string | ContentBlock[];
  name?:         string;
  tool_call_id?: string;
  timestamp?:    number;
  metadata?:     Record<string, any>;
}

/**
 * Callbacks for streaming LLM responses (used in voice mode).
 */
export interface StreamCallbacks {
  /** Called for each text token/delta as it arrives from the LLM. */
  onToken: (token: string) => void;
  /**
   * Called for non-text status events from the underlying provider —
   * e.g. "Running Bash…", "Thinking…", "Reading /etc/hosts". Lets the UI
   * render a live "what the model is doing" indicator alongside the
   * streaming text.
   *
   * Providers that don't emit rich events (OpenAI-compatible chat, etc.)
   * simply never call this. Callers that don't care can omit it.
   */
  onActivity?: (message: string) => void;
}

/**
 * Normalized response that all LLM services return
 */
export interface NormalizedResponse {
  content:  string;
  metadata: {
    tokens_used:         number;
    time_spent:          number;           // milliseconds
    prompt_tokens?:      number;
    completion_tokens?:  number;
    model?:              string;
    tool_calls?:         { id?: string; name: string; args: any }[];
    finish_reason?:      FinishReason;
    reasoning?:          string;
    parsed_content?:     any;
    rawProviderContent?: any;
  };
}

/**
 * Minimal config every LLM service needs.
 * Provider-specific services extend this with their own fields.
 */
export interface LLMServiceConfig {
  id:      string;
  model:   string;
  baseUrl: string;
  apiKey?: string;
}

/**
 * Remote provider configuration (back-compat alias)
 */
export interface RemoteProviderConfig {
  id:      string;
  name:    string;
  baseUrl: string;
  apiKey:  string;
  model:   string;
}

/**
 * Overall LLM configuration (legacy)
 */
export interface LLMConfig {
  mode:                  'local' | 'remote';
  // Local
  localModel:            string;
  ollamaBase:            string;
  localTimeoutSeconds?:  number;
  localRetryCount?:      number;
  // Remote
  remoteProvider?:       string;
  remoteModel?:          string;
  remoteApiKey?:         string;
  remoteBaseUrl?:        string;
  remoteRetryCount?:     number;
  remoteTimeoutSeconds?: number;
  // Backend heartbeat provider selection
  heartbeatProvider?:    string;
}

/**
 * Abstract base class for all LLM providers (local Ollama, OpenAI-compatible APIs, Anthropic, Groq, xAI, etc.).
 *
 * Provides:
 * - Unified chat interface
 * - Response normalization across providers
 * - Health checks & availability tracking
 * - Built-in timeout/abort signal support
 * - Wall-clock timing & token usage metadata
 *
 * Extend this class for each provider:
 * - Implement `sendRawRequest()` → makes the actual HTTP call
 * - Override `healthCheck()` when provider-specific ping is needed
 * - Optionally override `normalizeResponse()` for exotic shapes
 *
 * @example
 * class MyService extends BaseLanguageModel {
 *   protected async sendRawRequest(messages: ChatMessage[], options: any) {
 *     return fetch(`${this.baseUrl}/api/chat`, this.buildFetchOptions({
 *       model: options.model,
 *       messages,
 *       stream: false,
 *       format: options.format,
 *     }));
 *   }
 *
 *   protected async healthCheck(): Promise<boolean> {
 *     try {
 *       const res = await fetch(`${this.baseUrl}/api/tags`);
 *       return res.ok;
 *     } catch {
 *       return false;
 *     }
 *   }
 * }
 *
 * @see {@link ChatMessage} - Unified message shape
 * @see {@link NormalizedResponse} - Guaranteed return format
 * @see {@link LLMConfig} - Constructor config shapes
 */
export abstract class BaseLanguageModel {
  protected config:      LLMServiceConfig | LLMConfig | RemoteProviderConfig;
  protected model:       string;
  protected baseUrl:     string;
  protected apiKey?:     string;
  protected providerId?: string;
  protected isInitialized = false;
  protected isHealthy = false;

  constructor(config: LLMServiceConfig | LLMConfig | RemoteProviderConfig) {
    this.config = config;
    if ('mode' in config) {
      // Legacy local config (Ollama)
      this.model = config.localModel;
      this.baseUrl = config.ollamaBase.endsWith('/')
        ? config.ollamaBase.slice(0, -1)
        : config.ollamaBase;
    } else {
      // LLMServiceConfig or RemoteProviderConfig
      this.model = config.model;
      this.baseUrl = config.baseUrl.endsWith('/')
        ? config.baseUrl.slice(0, -1)
        : config.baseUrl;
      this.apiKey = config.apiKey;
      this.providerId = config.id;
    }
  }

  /**
   * Re-read the API key from the database.
   * Called automatically on 401 so credential changes take effect
   * without requiring an app restart.
   */
  async refreshCredentials(): Promise<boolean> {
    if (!this.providerId) return false;
    try {
      const { getIntegrationService } = await import('../services/IntegrationService');
      const svc = getIntegrationService();
      const values = await svc.getFormValues(this.providerId);
      const valMap: Record<string, string> = {};
      for (const v of values) valMap[v.property] = v.value;

      const freshKey = valMap.api_key || '';
      if (freshKey && freshKey !== this.apiKey) {
        this.apiKey = freshKey;
        console.log(`[BaseLanguageModel] Refreshed API key for ${ this.providerId }`);
        return true;
      }
    } catch (err) {
      console.error(`[BaseLanguageModel] Failed to refresh credentials for ${ this.providerId }:`, err);
    }
    return false;
  }

  // ─────────────────────────────────────────────────────────────
  // Public API (common to all implementations)
  // ─────────────────────────────────────────────────────────────

  async initialize(): Promise<boolean> {
    this.isHealthy = await this.healthCheck();
    this.isInitialized = true;
    return this.isHealthy;
  }

  isAvailable(): boolean {
    return this.isInitialized && this.isHealthy;
  }

  getModel(): string {
    return this.model;
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  getProviderName(): string {
    return this.constructor.name.replace('Service', '');
  }

  /**
   * Returns the context window size (in tokens) for the current model.
   * Override in subclasses to return provider-specific values.
   * Used by BaseNode to dynamically compute message budgets.
   */
  getContextWindow(): number {
    return 128_000; // Safe default for most cloud models
  }

  /**
   * Pull a model from the service (only available for local services like Ollama)
   */
  pullModel(modelName: string, onProgress?: (status: string) => void): Promise<boolean> {
    return Promise.resolve(false);
  }

  async chat(
    messages: ChatMessage[],
    options: {
      model?:          string;
      maxTokens?:      number;
      format?:         'json' | undefined;
      temperature?:    number;
      signal?:         AbortSignal;
      timeoutSeconds?: number;
      tools?:          any;
      conversationId?: string;
      nodeName?:       string;
    } = {},
  ): Promise<NormalizedResponse | null> {
    const startTime = performance.now();
    const convId = options.conversationId;

    try {
      // Use provided model or fallback to default
      const effectiveModel = options.model ?? this.model;

      // Log the outgoing request
      if (convId) {
        try {
          const { getConversationLogger } = require('../services/ConversationLogger');
          getConversationLogger().logLLMCall(convId, 'request', {
            model:       effectiveModel,
            provider:    this.getProviderName(),
            nodeName:    options.nodeName,
            maxTokens:   options.maxTokens,
            temperature: options.temperature,
            format:      options.format,
            tools:       options.tools,
            messages,
          });
        } catch { /* best-effort */ }
      }

      const rawResponse = await this.sendRawRequest(messages, {
        ...options,
        model: effectiveModel,
        tools: options.tools,
      });

      if (!rawResponse) {
        // Log null response
        if (convId) {
          try {
            const { getConversationLogger } = require('../services/ConversationLogger');
            getConversationLogger().logLLMCall(convId, 'response', {
              model: effectiveModel,
              error: 'No response from provider',
            });
          } catch { /* best-effort */ }
        }
        return null;
      }

      const normalized = this.normalizeResponse(rawResponse);

      // Override time_spent with real wall-clock time
      normalized.metadata.time_spent = Math.round(performance.now() - startTime);
      normalized.metadata.model = effectiveModel;

      // Log the response
      if (convId) {
        try {
          const { getConversationLogger } = require('../services/ConversationLogger');
          getConversationLogger().logLLMCall(convId, 'response', {
            model:            effectiveModel,
            content:          normalized.content,
            finishReason:     normalized.metadata.finish_reason,
            tokensUsed:       normalized.metadata.tokens_used,
            promptTokens:     normalized.metadata.prompt_tokens,
            completionTokens: normalized.metadata.completion_tokens,
            timeSpent:        normalized.metadata.time_spent,
            reasoning:        normalized.metadata.reasoning,
            toolCalls:        normalized.metadata.tool_calls,
          });
        } catch { /* best-effort */ }
      }

      return normalized;
    } catch (error) {
      // Log the error
      if (convId) {
        try {
          const { getConversationLogger } = require('../services/ConversationLogger');
          getConversationLogger().logLLMCall(convId, 'response', {
            model: options.model ?? this.model,
            error: error instanceof Error ? error.message : String(error),
          });
        } catch { /* best-effort */ }
      }
      console.error(`[${ this.getProviderName() }] Chat failed:`, error);
      throw error;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Streaming API (voice mode)
  // ─────────────────────────────────────────────────────────────

  /**
   * Stream LLM tokens via callbacks. Used in voice mode to dispatch
   * sentence-level TTS while the model is still generating.
   *
   * Providers that support streaming override `sendStreamRequest()` and
   * `parseStreamResponse()`. Providers that don't (Google, Ollama) fall
   * back to the non-streaming `chat()` path automatically — the full
   * response is emitted as a single `onToken()` call.
   *
   * Returns the same `NormalizedResponse` as `chat()` so the caller
   * can continue with tool execution, state appending, etc.
   */
  async chatStream(
    messages: ChatMessage[],
    callbacks: StreamCallbacks,
    options: {
      model?:          string;
      maxTokens?:      number;
      format?:         'json' | undefined;
      temperature?:    number;
      signal?:         AbortSignal;
      timeoutSeconds?: number;
      tools?:          any;
      conversationId?: string;
      nodeName?:       string;
      /** Calling graph state. Used by ClaudeCodeService to mint an MCP
       *  session so the in-VM CLI can call back into native tools that
       *  mutate state.metadata on this exact graph instance. Ignored by
       *  other language-model implementations. */
      state?:          any;
    } = {},
  ): Promise<NormalizedResponse | null> {
    const startTime = performance.now();
    const effectiveModel = options.model ?? this.model;
    const convId = options.conversationId;

    // Log outgoing request (same as chat())
    if (convId) {
      try {
        const { getConversationLogger } = require('../services/ConversationLogger');
        getConversationLogger().logLLMCall(convId, 'request', {
          model:       effectiveModel,
          provider:    this.getProviderName(),
          nodeName:    options.nodeName,
          maxTokens:   options.maxTokens,
          temperature: options.temperature,
          format:      options.format,
          tools:       options.tools,
          messages,
          streaming:   true,
        });
      } catch { /* best-effort */ }
    }

    try {
      // Try provider-specific streaming
      const streamResponse = await this.sendStreamRequest(messages, {
        ...options,
        model: effectiveModel,
      });

      if (streamResponse?.body) {
        // Provider supports streaming — parse the SSE stream
        const normalized = await this.parseStreamResponse(
          streamResponse,
          callbacks,
          options.signal,
        );

        normalized.metadata.time_spent = Math.round(performance.now() - startTime);
        normalized.metadata.model = effectiveModel;

        // Log response
        if (convId) {
          try {
            const { getConversationLogger } = require('../services/ConversationLogger');
            getConversationLogger().logLLMCall(convId, 'response', {
              model:            effectiveModel,
              content:          normalized.content,
              finishReason:     normalized.metadata.finish_reason,
              tokensUsed:       normalized.metadata.tokens_used,
              promptTokens:     normalized.metadata.prompt_tokens,
              completionTokens: normalized.metadata.completion_tokens,
              timeSpent:        normalized.metadata.time_spent,
              reasoning:        normalized.metadata.reasoning,
              toolCalls:        normalized.metadata.tool_calls,
              streaming:        true,
            });
          } catch { /* best-effort */ }
        }

        return normalized;
      }

      // Provider does not support streaming — fall back to chat()
      const response = await this.chat(messages, options);

      if (response?.content) {
        callbacks.onToken(response.content);
      }

      return response;
    } catch (error) {
      if (convId) {
        try {
          const { getConversationLogger } = require('../services/ConversationLogger');
          getConversationLogger().logLLMCall(convId, 'response', {
            model:     effectiveModel,
            error:     error instanceof Error ? error.message : String(error),
            streaming: true,
          });
        } catch { /* best-effort */ }
      }
      console.error(`[${ this.getProviderName() }] Stream chat failed:`, error);
      throw error;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Must be implemented by subclasses
  // ─────────────────────────────────────────────────────────────

  /**
   * Subclass implements the actual HTTP call
   * (Ollama → /api/chat, OpenAI/xAI → /v1/chat/completions, etc.)
   */
  protected abstract sendRawRequest(
    messages: ChatMessage[],
    options: any
  ): Promise<any>;

  /**
   * Health check — should be overridden when needed
   */
  protected abstract healthCheck(): Promise<boolean>;

  /**
   * Initiate a streaming request. Returns the fetch Response (whose body
   * is an SSE stream), or null if this provider does not support streaming.
   * Override in subclasses to enable streaming.
   */
  protected async sendStreamRequest(
    _messages: ChatMessage[],
    _options: any,
  ): Promise<Response | null> {
    return null; // default: no streaming support
  }

  /**
   * Parse a streaming Response into token callbacks + final NormalizedResponse.
   * Must be overridden by providers that return a non-null `sendStreamRequest()`.
   */
  protected async parseStreamResponse(
    _response: Response,
    _callbacks: StreamCallbacks,
    _signal?: AbortSignal,
  ): Promise<NormalizedResponse> {
    throw new Error(`${ this.getProviderName() } returned a stream response but does not implement parseStreamResponse()`);
  }

  // ─────────────────────────────────────────────────────────────
  // Shared utilities
  // ─────────────────────────────────────────────────────────────

  /**
   * Safely convert raw finish reason string to FinishReason enum
   */
  protected normalizeFinishReason(rawReason: string | undefined): FinishReason | undefined {
    if (!rawReason) return undefined;

    // Provider aliases (Anthropic/OpenAI-compatible variants)
    const normalizedAliases: Record<string, FinishReason> = {
      end_turn:   FinishReason.Stop,
      max_tokens: FinishReason.Length,
      tool_use:   FinishReason.ToolCalls,
    };

    if (normalizedAliases[rawReason]) {
      return normalizedAliases[rawReason];
    }

    // Check if the raw reason matches any enum value
    for (const reason of Object.values(FinishReason)) {
      if (reason === rawReason) {
        return reason as FinishReason;
      }
    }

    // If no match, return undefined or log a warning
    console.warn(`Unknown finish reason: ${ rawReason }`);
    return undefined;
  }

  /**
   * Safely parse JSON content from LLM responses
   * Returns parsed object if valid JSON, null otherwise
   */
  protected parseJson<T = any>(raw: string | null | undefined): T | null {
    // If it's already an object, return it as-is
    if (typeof raw === 'object' && raw !== null) {
      return raw as T;
    }
    if (!raw || typeof raw !== 'string') return null;

    try {
      const parsed = JSON.parse(raw);
      return parsed;
    } catch {
      return null;
    }
  }

  /**
   * Normalize response — default implementation handles OpenAI-compatible shape.
   * Provider-specific services (Anthropic, Google, etc.) override this entirely.
   */
  protected normalizeResponse(raw: any): NormalizedResponse {
    const usage = raw.usage ?? {};
    const finishReason = raw.choices?.[0]?.finish_reason;

    // OpenAI / Grok / most compatible providers
    let content = raw.choices?.[0]?.message?.content?.message ?? raw.choices?.[0]?.message?.content ?? '';
    let reasoning = raw.choices?.[0]?.message?.content?.reasoning ||
            raw.choices?.[0]?.message?.reasoning ||
            raw.reasoning ||
            '';
    let toolCalls: { id?: string; name: string; args: any }[] = [];

    // ── Attempt to parse content as JSON for structured data ──
    const parsedContent = this.parseJson(content);
    if (parsedContent && typeof parsedContent === 'object') {
      // Anthropic-style tool_use block encoded directly as JSON object
      if (
        !Array.isArray(parsedContent) &&
        parsedContent.type === 'tool_use' &&
        typeof parsedContent.name === 'string'
      ) {
        toolCalls.push({
          id:   parsedContent.id,
          name: parsedContent.name,
          args: parsedContent.input ?? {},
        });
        content = '';
      }

      // Anthropic-style content blocks encoded as JSON array
      if (Array.isArray(parsedContent)) {
        const textBlocks = parsedContent
          .filter((b: any) => b?.type === 'text' && typeof b?.text === 'string')
          .map((b: any) => b.text.trim())
          .filter(Boolean);

        const parsedToolUses = parsedContent
          .filter((b: any) => b?.type === 'tool_use' && typeof b?.name === 'string')
          .map((b: any) => ({
            id:   b.id,
            name: b.name,
            args: b.input ?? {},
          }));

        if (parsedToolUses.length > 0) {
          toolCalls.push(...parsedToolUses);
          content = textBlocks.join('\n\n');
        }
      }

      if (parsedContent.reasoning && typeof parsedContent.reasoning === 'string' && !reasoning) {
        reasoning = parsedContent.reasoning;
      }
      if (parsedContent.tool_calls && Array.isArray(parsedContent.tool_calls)) {
        const extractedToolCalls = parsedContent.tool_calls.map((tc: any) => ({
          id:   tc.id,
          name: tc.function?.name || tc.name,
          args: tc.function?.arguments
            ? (() => {
              try {
                return typeof tc.function.arguments === 'string'
                  ? JSON.parse(tc.function.arguments)
                  : tc.function.arguments;
              } catch {
                return tc.function.arguments || {};
              }
            })()
            : tc.args || {},
        }));
        toolCalls.push(...extractedToolCalls);
      }
      const { reasoning: _, tool_calls: __, content: mainContent, message, answer, response, ...remaining } = parsedContent;
      if (mainContent && typeof mainContent === 'string') {
        content = mainContent;
      } else if (message && typeof message === 'string') {
        content = message;
      } else if (answer && typeof answer === 'string') {
        content = answer;
      } else if (response && typeof response === 'string') {
        content = response;
      } else if (Array.isArray(parsedContent)) {
        // Already handled above for content blocks; keep whatever was extracted.
      } else if (Object.keys(remaining).length > 0) {
        content = JSON.stringify(remaining);
      } else {
        content = JSON.stringify(parsedContent);
      }
    }

    // ── Extract tool calls from XML-style tags in content ──
    // Local models (Qwen, Llama, etc.) sometimes emit tool calls as XML tags
    // instead of using the structured tool_calls response field.
    if (toolCalls.length === 0 && typeof content === 'string') {
      const xmlToolCalls = this.extractToolCallsFromXmlTags(content);
      if (xmlToolCalls.length > 0) {
        toolCalls.push(...xmlToolCalls);
        // Strip tool tags and fake tool_result blocks from content
        content = this.stripToolTagsFromContent(content);
      }
    }

    // ── Extract tool_calls from OpenAI-compatible response ──
    const message = raw.choices?.[0]?.message;
    const toolCallsArray = message?.tool_calls || message?.content?.tool_calls;
    if (toolCallsArray) {
      toolCalls = toolCallsArray.map((tc: any) => ({
        id:   tc.id,
        name: tc.function?.name,
        args: (() => {
          try {
            return JSON.parse(tc.function?.arguments || '{}');
          } catch {
            return tc.function?.arguments || {};
          }
        })(),
      }));
    }

    // Build rawProviderContent as Anthropic-style content blocks when tool_calls
    // are present. This ensures appendResponse stores them in state.messages so
    // the full tool_use → tool_result round-trip is preserved across turns.
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
      content:  content.trim(),
      metadata: {
        tokens_used: (usage.total_tokens ?? usage.output_tokens ?? 0) +
                    (usage.prompt_tokens ?? usage.input_tokens ?? 0),
        time_spent:        0,
        prompt_tokens:     usage.prompt_tokens ?? usage.input_tokens ?? 0,
        completion_tokens: usage.completion_tokens ?? usage.output_tokens ?? 0,
        model:             this.model,
        tool_calls:        toolCalls.length > 0 ? toolCalls : undefined,
        finish_reason:     this.normalizeFinishReason(finishReason),
        reasoning:         reasoning.trim() || undefined,
        parsed_content:    parsedContent,
        rawProviderContent,
      },
    };
  }

  /**
   * Extract tool calls from XML-style tags that local models sometimes emit.
   * Handles patterns like:
   *   <tool_call>{"name":"exec","arguments":{...}}</tool_call>
   *   <tool_code>await exec({"command":"echo hi"})</tool_code>
   *   <function_call>{"name":"exec","parameters":{...}}</function_call>
   */
  private extractToolCallsFromXmlTags(content: string): { id?: string; name: string; args: any }[] {
    const results: { id?: string; name: string; args: any }[] = [];

    // Pattern 1: <tool_call>JSON</tool_call> or <function_call>JSON</function_call>
    const jsonTagPattern = /<(?:tool_call|function_call)\s*>([\s\S]*?)<\/(?:tool_call|function_call)\s*>/gi;
    let match: RegExpExecArray | null;
    while ((match = jsonTagPattern.exec(content)) !== null) {
      const parsed = this.parseJson(match[1].trim());
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const name = parsed.name || parsed.function?.name;
        if (name) {
          let args = parsed.arguments || parsed.parameters || parsed.input || parsed.function?.arguments || {};
          if (typeof args === 'string') {
            try { args = JSON.parse(args) } catch { /* keep as string */ }
          }
          results.push({ id: parsed.id, name, args });
        }
      }
    }

    // Pattern 2: <tool_code>await toolName({...})</tool_code> or <tool_code>toolName({...})</tool_code>
    if (results.length === 0) {
      const codeTagPattern = /<tool_code\s*>([\s\S]*?)<\/tool_code\s*>/gi;
      while ((match = codeTagPattern.exec(content)) !== null) {
        const code = match[1].trim();
        // Match: [await] [const x =] toolName({...}) or toolName(JSON)
        const callPattern = /(?:(?:const\s+\w+\s*=\s*)?await\s+)?(\w+)\s*\(\s*(\{[\s\S]*\})\s*\)/;
        const callMatch = callPattern.exec(code);
        if (callMatch) {
          const [, name, argsStr] = callMatch;
          const args = this.parseLooseJson(argsStr);
          if (args !== null) {
            results.push({ name, args });
          }
        }
      }
    }

    return results;
  }

  /**
   * Parse a potentially JS-style object literal (unquoted keys, single quotes)
   * into a proper object. Falls back through multiple strategies.
   */
  private parseLooseJson(str: string): any | null {
    const trimmed = str.trim();
    // Try strict JSON first
    try { return JSON.parse(trimmed) } catch { /* continue */ }
    // Quote unquoted keys and convert single quotes to double
    try {
      const fixed = trimmed
        .replace(/,\s*([}\]])/g, '$1')                    // trailing commas
        .replace(/'/g, '"')                                // single -> double quotes
        .replace(/([{,]\s*)(\w+)\s*:/g, '$1"$2":');       // unquoted keys
      return JSON.parse(fixed);
    } catch { /* continue */ }
    // Last resort: eval-safe subset using Function constructor
    try {
      const fn = new Function(`return (${ trimmed })`);
      const result = fn();
      if (result && typeof result === 'object') return result;
    } catch { /* give up */ }
    return null;
  }

  /**
   * Strip XML tool tags and fake tool_result blocks from content text.
   */
  private stripToolTagsFromContent(content: string): string {
    return content
      .replace(/<tool_code\s*>[\s\S]*?<\/tool_code\s*>/gi, '')
      .replace(/<tool_call\s*>[\s\S]*?<\/tool_call\s*>/gi, '')
      .replace(/<function_call\s*>[\s\S]*?<\/function_call\s*>/gi, '')
      .replace(/<tool_result\s*>[\s\S]*?<\/tool_result\s*>/gi, '')
      .trim();
  }

  /**
   * Combine an optional caller-provided AbortSignal with a timeout signal.
   * Returns a single signal that fires on whichever triggers first.
   */
  protected combinedSignal(signal?: AbortSignal, timeoutMs?: number): AbortSignal | undefined {
    if (!timeoutMs || timeoutMs <= 0) return signal;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    if (!signal) return timeoutSignal;
    return AbortSignal.any([signal, timeoutSignal]);
  }

  // Optional: helper for building fetch options (auth, timeout, etc.)
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
}

/**
 * ILLMService - Common interface for LLM services
 * Implemented by remote LLM provider services (e.g. OpenAI, Anthropic, Google)
 */
export interface ILLMService {
  initialize(): Promise<boolean>;
  isAvailable(): boolean;
  getModel(): string;
  getContextWindow(): number;
  chat(messages: ChatMessage[], options?: {
    model?:     string;
    maxTokens?: number;
    format?:    'json' | undefined;
    signal?:    AbortSignal;
  }): Promise<string | null>;
  healthCheck(): Promise<boolean>;
  pullModel?(modelName: string, onProgress?: (status: string) => void): Promise<boolean>;
}
