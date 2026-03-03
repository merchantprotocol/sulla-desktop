// ILLMService - Common interface for all LLM services (local and remote)
// This allows the agent to use either Ollama or remote APIs interchangeably

export enum FinishReason {
  Stop = 'stop',
  ToolCalls = 'tool_calls',
  Length = 'length',
  ContentFilter = 'content_filter',
}

export interface ChatMessage {
  id?: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  name?: string;
  tool_call_id?: string;
  timestamp?: number;
  metadata?: Record<string, any>;
}

/**
 * Normalized response that all LLM services return
 */
export interface NormalizedResponse {
  content: string;
  metadata: {
    tokens_used: number;
    time_spent: number;           // milliseconds
    prompt_tokens?: number;
    completion_tokens?: number;
    model?: string;
    tool_calls?: Array<{ id?: string; name: string; args: any }>;
    finish_reason?: FinishReason;
    reasoning?: string;
    parsed_content?: any;
    rawProviderContent?: any;
  };
}

/**
 * Minimal config every LLM service needs.
 * Provider-specific services extend this with their own fields.
 */
export interface LLMServiceConfig {
  id: string;
  model: string;
  baseUrl: string;
  apiKey?: string;
}

/**
 * Remote provider configuration (back-compat alias)
 */
export interface RemoteProviderConfig {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

/**
 * Overall LLM configuration (legacy — used by OllamaService)
 */
export interface LLMConfig {
  mode: 'local' | 'remote';
  // Local
  localModel: string;
  ollamaBase: string;
  localTimeoutSeconds?: number;
  localRetryCount?: number;
  // Remote
  remoteProvider?: string;
  remoteModel?: string;
  remoteApiKey?: string;
  remoteBaseUrl?: string;
  remoteRetryCount?: number;
  remoteTimeoutSeconds?: number;
  // Backend heartbeat provider selection
  heartbeatProvider?: string;
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
 * class OllamaService extends BaseLanguageModel {
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
  protected config: LLMServiceConfig | LLMConfig | RemoteProviderConfig;
  protected model: string;
  protected baseUrl: string;
  protected apiKey?: string;
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
    }
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
   * Pull a model from the service (only available for local services like Ollama)
   */
  pullModel(modelName: string, onProgress?: (status: string) => void): Promise<boolean> {
    return Promise.resolve(false);
  }
  async chat(
    messages: ChatMessage[],
    options: {
      model?: string;
      maxTokens?: number;
      format?: 'json' | undefined;
      temperature?: number;
      signal?: AbortSignal;
      timeoutSeconds?: number;
      tools?: any;
      conversationId?: string;
      nodeName?: string;
    } = {}
  ): Promise<NormalizedResponse | null> {
    const startTime = performance.now();

    try {
      // Use provided model or fallback to default
      const effectiveModel = options.model ?? this.model;

      const rawResponse = await this.sendRawRequest(messages, {
        ...options,
        model: effectiveModel,
        tools: options.tools,
      });

      if (!rawResponse) {
        return null;
      }

      const normalized = this.normalizeResponse(rawResponse);

      // Override time_spent with real wall-clock time
      normalized.metadata.time_spent = Math.round(performance.now() - startTime);
      normalized.metadata.model = effectiveModel;

      return normalized;
    } catch (error) {
      console.error(`[${this.getProviderName()}] Chat failed:`, error);
      return null;
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
      end_turn: FinishReason.Stop,
      max_tokens: FinishReason.Length,
      tool_use: FinishReason.ToolCalls,
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
    console.warn(`Unknown finish reason: ${rawReason}`);
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
    let reasoning = raw.choices?.[0]?.message?.content?.reasoning 
            || raw.choices?.[0]?.message?.reasoning 
            || raw.reasoning 
            || '';
    let toolCalls: Array<{ id?: string; name: string; args: any }> = [];

    // ── Attempt to parse content as JSON for structured data ──
    const parsedContent = this.parseJson(content);
    if (parsedContent && typeof parsedContent === 'object') {
      if (parsedContent.reasoning && typeof parsedContent.reasoning === 'string' && !reasoning) {
        reasoning = parsedContent.reasoning;
      }
      if (parsedContent.tool_calls && Array.isArray(parsedContent.tool_calls)) {
        const extractedToolCalls = parsedContent.tool_calls.map((tc: any) => ({
          id: tc.id,
          name: tc.function?.name || tc.name,
          args: tc.function?.arguments ? (() => {
            try {
              return typeof tc.function.arguments === 'string' 
                ? JSON.parse(tc.function.arguments) 
                : tc.function.arguments;
            } catch {
              return tc.function.arguments || {};
            }
          })() : tc.args || {},
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
      } else if (Object.keys(remaining).length > 0) {
        content = JSON.stringify(remaining);
      } else {
        content = JSON.stringify(parsedContent);
      }
    }

    // ── Extract tool_calls from OpenAI-compatible response ──
    const message = raw.choices?.[0]?.message;
    const toolCallsArray = message?.tool_calls || message?.content?.tool_calls;
    if (toolCallsArray) {
      toolCalls = toolCallsArray.map((tc: any) => ({
        id: tc.id,
        name: tc.function?.name,
        args: (() => {
          try {
            return JSON.parse(tc.function?.arguments || '{}');
          } catch {
            return tc.function?.arguments || {};
          }
        })()
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
          type: 'tool_use',
          id: tc.id,
          name: tc.name,
          input: tc.args ?? {},
        });
      }
      rawProviderContent = blocks;
    }

    return {
      content: content.trim(),
      metadata: {
        tokens_used: (usage.total_tokens ?? usage.output_tokens ?? 0) + 
                    (usage.prompt_tokens ?? usage.input_tokens ?? 0),
        time_spent: 0,
        prompt_tokens: usage.prompt_tokens ?? usage.input_tokens ?? 0,
        completion_tokens: usage.completion_tokens ?? usage.output_tokens ?? 0,
        model: this.model,
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        finish_reason: this.normalizeFinishReason(finishReason),
        reasoning: reasoning.trim() || undefined,
        parsed_content: parsedContent,
        rawProviderContent,
      },
    };
  }

  // Optional: helper for building fetch options (auth, timeout, etc.)
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
}



/**
 * ILLMService - Common interface for LLM services
 * Implemented by OllamaService (local) and RemoteModelService (API)
 */
export interface ILLMService {
  initialize(): Promise<boolean>;
  isAvailable(): boolean;
  getModel(): string;
  chat(messages: ChatMessage[], options?: { 
    model?: string;
    maxTokens?: number;
    format?: 'json' | undefined;
    signal?: AbortSignal;
  }): Promise<string | null>;
  healthCheck(): Promise<boolean>;
  pullModel?(modelName: string, onProgress?: (status: string) => void): Promise<boolean>;
}
