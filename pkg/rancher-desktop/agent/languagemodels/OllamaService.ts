import { SullaSettingsModel } from '../database/models/SullaSettingsModel';
import { BaseLanguageModel, type ChatMessage, type NormalizedResponse } from './BaseLanguageModel';
import { writeLLMConversationEvent } from './LLMConversationFileLogger';
import { getIntegrationService } from '../services/IntegrationService';
import { getLlamaCppService } from '../services/LlamaCppService';

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
    const timeout = await SullaSettingsModel.get('localTimeoutSeconds', 120);

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
   * Check if llama-server is reachable via /health.
   */
  protected async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(4000),
      });
      return res.ok;
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
    const conversationId = typeof options?.conversationId === 'string' ? options.conversationId : undefined;
    const nodeName = typeof options?.nodeName === 'string' ? options.nodeName : undefined;
    writeLLMConversationEvent({
      direction: 'request',
      provider: 'llama-cpp',
      model: options.model ?? this.model,
      endpoint: '/v1/chat/completions',
      nodeName,
      conversationId,
      payload: body,
    });
    console.log('[OllamaService] Sending request to llama-server:', JSON.stringify(body).slice(0, 500));

    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, this.buildFetchOptions(body, options.signal));
    console.log('[OllamaService] Response from llama-server:', res.status);

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`llama-server chat failed: ${res.status} ${res.statusText} — ${errBody}`);
    }

    const responseText = await res.text();

    try {
      const parsed = JSON.parse(responseText);
      writeLLMConversationEvent({
        direction: 'response',
        provider: 'llama-cpp',
        model: options.model ?? this.model,
        endpoint: '/v1/chat/completions',
        nodeName,
        conversationId,
        payload: parsed,
      });

      return parsed;
    } catch (e) {
      writeLLMConversationEvent({
        direction: 'error',
        provider: 'llama-cpp',
        model: options.model ?? this.model,
        endpoint: '/v1/chat/completions',
        nodeName,
        conversationId,
        payload: {
          message: 'Failed to parse llama-server response as JSON',
          rawResponse: responseText,
          error: e instanceof Error ? e.message : String(e),
        },
      });
      throw new Error(`Failed to parse llama-server response as JSON: ${e}`);
    }
  }

  /**
   * Rough token estimate: ~4 characters per token for English text.
   */
  private static estimateTokens(text: string): number {
    return Math.ceil((text?.length ?? 0) / 4);
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

  /**
   * Build the request body in OpenAI /v1/chat/completions format.
   * Trims oldest non-system messages to stay within the llama-server context limit.
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
          msg.content = m.content.map((c: any) => typeof c === 'string' ? c : c.text ?? JSON.stringify(c)).join('\n');
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
    let conversationTokens = nonSystemMsgs.reduce((sum, m) => sum + OllamaService.estimateTokens(m.content), 0);

    // Drop oldest non-system messages until we fit within budget
    const trimmed = [...nonSystemMsgs];
    while (trimmed.length > 1 && (systemTokens + conversationTokens) > inputBudget) {
      const removed = trimmed.shift()!;
      conversationTokens -= OllamaService.estimateTokens(removed.content);
    }

    if (trimmed.length < nonSystemMsgs.length) {
      console.log(`[OllamaService] Trimmed ${nonSystemMsgs.length - trimmed.length} oldest messages to fit ctx limit (${ctxLimit} tokens, ~${systemTokens + conversationTokens} used)`);
    }

    const cleanMessages = [...systemMsgs, ...trimmed];

    const body: Record<string, any> = {
      model: options.model ?? this.model,
      messages: cleanMessages,
      stream: false,
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