import { SullaSettingsModel } from '../database/models/SullaSettingsModel';
import { BaseLanguageModel, type ChatMessage, type NormalizedResponse, getTextContent } from './BaseLanguageModel';
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
    console.log('[OllamaService] Sending request to llama-server:', JSON.stringify(body).slice(0, 500));

    const timeoutMs = this.localTimeoutSeconds * 1000;
    const signal = this.combinedSignal(options.signal, timeoutMs);
    const res = await fetch(`${ this.baseUrl }/v1/chat/completions`, this.buildFetchOptions(body, signal));
    console.log('[OllamaService] Response from llama-server:', res.status);

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`llama-server chat failed: ${ res.status } ${ res.statusText } — ${ errBody }`);
    }

    const responseText = await res.text();

    try {
      const parsed = JSON.parse(responseText);

      return parsed;
    } catch (e) {
      throw new Error(`Failed to parse llama-server response as JSON: ${ e }`);
    }
  }

  /**
   * Rough token estimate: ~4 characters per token for English text.
   */
  private static estimateTokens(content: string | any): number {
    const text = typeof content === 'string' ? content : getTextContent(content);
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

  override getContextWindow(): number {
    return this.getContextLimit();
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
          // Extract base64 images for Ollama vision models — check both
          // top-level image blocks and images nested inside tool_result blocks
          const images: string[] = [];
          const textParts: string[] = [];
          for (const c of m.content as any[]) {
            if (c?.type === 'image' && c?.source?.type === 'base64') {
              images.push(c.source.data);
            } else if (c?.type === 'tool_result' && Array.isArray(c.content)) {
              for (const inner of c.content) {
                if (inner?.type === 'image' && inner?.source?.type === 'base64') {
                  images.push(inner.source.data);
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
          msg.content = textParts.join('\n');
          if (images.length > 0) msg.images = images;
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
      console.log(`[OllamaService] Trimmed ${ nonSystemMsgs.length - trimmed.length } oldest messages to fit ctx limit (${ ctxLimit } tokens, ~${ systemTokens + conversationTokens } used)`);
    }

    const cleanMessages = [...systemMsgs, ...trimmed];

    const body: Record<string, any> = {
      model:    options.model ?? this.model,
      messages: cleanMessages,
      stream:   false,
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

/** Clear the cached singleton so the next getOllamaService() re-reads settings */
export function resetOllamaService(): void {
  ollamaInstance = null;
}
