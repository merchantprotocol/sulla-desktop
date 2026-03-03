import { SullaSettingsModel } from '../database/models/SullaSettingsModel';
import { BaseLanguageModel, type ChatMessage, type NormalizedResponse } from './BaseLanguageModel';
import { writeLLMConversationEvent } from './LLMConversationFileLogger';
import { getIntegrationService } from '../services/IntegrationService';

/**
 * Ollama local LLM provider.
 *
 * Extends BaseLanguageModel to provide unified interface for local Ollama instances.
 * Handles model discovery, pulling, chat completions (with/without format), timeouts,
 * and normalized responses with token usage and timing.
 *
 * @extends BaseLanguageModel
 */
export class OllamaService extends BaseLanguageModel {
  private availableModels: string[] = [];
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
   * Initialize Ollama connection and discover available models.
   * @returns Whether Ollama is reachable and has models
   */
  protected async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(4000),
      });

      if (!res.ok) return false;

      const data = await res.json();
      this.availableModels = (data.models ?? []).map((m: any) => m.name);
      return this.availableModels.length > 0;
    } catch {
      return false;
    }
  }

  /**
   * List of currently known models on this Ollama instance.
   */
  public getAvailableModels(): string[] {
    return [...this.availableModels];
  }

  /**
   * Check whether a specific model exists locally.
   */
  public hasModel(modelName: string): boolean {
    return this.availableModels.includes(modelName);
  }

  /**
   * Refresh model list from /api/tags.
   * @returns Updated model list
   */
  public async refreshModels(): Promise<string[]> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(4000),
      });
      if (res.ok) {
        const data = await res.json();
        this.availableModels = (data.models ?? []).map((m: any) => m.name);
      }
    } catch {
      // keep existing list
    }
    return this.availableModels;
  }


  /**
   * Core request to Ollama /api/chat (non-streaming).
   * @override
   */
  protected async sendRawRequest(messages: ChatMessage[], options: any): Promise<any> {
    const body = this.buildRequestBody(messages, options);
    const conversationId = typeof options?.conversationId === 'string' ? options.conversationId : undefined;
    const nodeName = typeof options?.nodeName === 'string' ? options.nodeName : undefined;
    writeLLMConversationEvent({
      direction: 'request',
      provider: 'ollama',
      model: options.model ?? this.model,
      endpoint: '/api/chat',
      nodeName,
      conversationId,
      payload: body,
    });
    console.log('[OllamaService] Sending request to Ollama:', body);
    
    const res = await fetch(`${this.baseUrl}/api/chat`, this.buildFetchOptions(body, options.signal));
    console.log('[OllamaService] Response from Ollama:', res);

    if (!res.ok) {
      throw new Error(`Ollama chat failed: ${res.status} ${res.statusText}`);
    }

    const responseText = await res.text();
    console.log('[OllamaService] Raw response text:', responseText);
    
    try {
      const parsed = JSON.parse(responseText);
      writeLLMConversationEvent({
        direction: 'response',
        provider: 'ollama',
        model: options.model ?? this.model,
        endpoint: '/api/chat',
        nodeName,
        conversationId,
        payload: parsed,
      });

      return parsed;
    } catch (e) {
      writeLLMConversationEvent({
        direction: 'error',
        provider: 'ollama',
        model: options.model ?? this.model,
        endpoint: '/api/chat',
        nodeName,
        conversationId,
        payload: {
          message: 'Failed to parse Ollama response as JSON',
          rawResponse: responseText,
          error: e instanceof Error ? e.message : String(e),
        },
      });
      throw new Error(`Failed to parse Ollama response as JSON: ${e}`);
    }
  }

  /**
   * Build the request body for Ollama /api/chat
   */
  private buildRequestBody(messages: ChatMessage[], options: any): Record<string, any> {
    // Strip legacy role:tool messages; tool results now persist natively in state.messages.
    // For Ollama, flatten native content arrays to string since Ollama uses OpenAI format.
    const cleanMessages = messages
      .filter((m: ChatMessage) => m.role !== 'tool')
      .map((m: ChatMessage) => {
        if (Array.isArray(m.content)) {
          return { ...m, content: JSON.stringify(m.content) };
        }
        return m;
      });

    const body: Record<string, any> = {
      model: options.model ?? this.model,
      messages: cleanMessages,
      stream: false,
      keep_alive: -1,
    };

    if (options.format === 'json') {
      body.format = 'json';
    }

    if (options.maxTokens) {
      body.options = { ...(body.options ?? {}), num_predict: options.maxTokens };
    }

    // Add tools when provided (Ollama supports OpenAI-compatible tool format)
    if (options.tools?.length) {
      body.tools = options.tools;
    }

    // Force GPU usage for all layers if possible
    body.options = { ...(body.options ?? {}), num_gpu: 999, num_thread: 1 };

    return body;
  }

  /**
   * Normalize Ollama /api/chat response shape.
   * @override
   */
  protected normalizeResponse(raw: any): NormalizedResponse {
    let content = raw?.message?.content ?? '';
    let reasoning = '';
    let toolCalls: Array<{ id?: string; name: string; args: any }> = [];

    let promptTokens = raw?.prompt_eval_count ?? 0;
    let completionTokens = raw?.eval_count ?? 0;
    const durationNs = raw?.total_duration ?? raw?.eval_duration ?? 0;
    const timeMs = Math.round(durationNs / 1_000_000);

    // Ollama doesn't have finish_reason in the same way, but we can infer
    let finishReason: string | undefined;
    if (raw.done) {
      finishReason = 'stop';
    }

    // Attempt to parse content as JSON for structured data
    const parsedContent = this.parseJson(content);
    
    if (parsedContent && typeof parsedContent === 'object') {
      // Extract reasoning if present
      if (parsedContent.reasoning && typeof parsedContent.reasoning === 'string' && !reasoning) {
        reasoning = parsedContent.reasoning;
      }
      
      // Extract tool_calls if present
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
      
      // Set content to the main message/response field
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

    return {
      content: content.trim(),
      metadata: {
        tokens_used: promptTokens + completionTokens,
        time_spent: timeMs,
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        model: raw?.model,
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        finish_reason: this.normalizeFinishReason(finishReason),
        reasoning: reasoning.trim() || undefined,
        parsed_content: parsedContent,
      },
    };
  }

  /**
   * Legacy convenience method — prefer .chat()
   */
  public async generate(prompt: string, options?: { signal?: AbortSignal }): Promise<NormalizedResponse | null> {
    return this.chat([{ role: 'user', content: prompt }], options);
  }

  /**
   * Pull a model from Ollama
   */
  public async pullModel(modelName: string, onProgress?: (status: string) => void): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/pull`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: modelName }),
      });

      if (!response.ok) {
        console.error(`[OllamaService] Pull failed: ${response.status} ${response.statusText}`);
        return false;
      }

      // Ollama pull returns a stream of JSON lines with status updates
      const reader = response.body?.getReader();
      if (!reader) {
        console.error('[OllamaService] No response body for pull');
        return false;
      }

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Keep incomplete line

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const data = JSON.parse(line);
            const status = data.status || data.message || 'unknown';
            onProgress?.(status);

            // Check if pull completed
            if (status.includes('complete') || status.includes('success') || data.status === 'complete') {
              await this.preloadModel(modelName);
              return true;
            }
          } catch (e) {
            console.warn('[OllamaService] Failed to parse pull status:', line, e);
          }
        }
      }

      // If we reach here, assume success if no error
      return true;
    } catch (error) {
      console.error('[OllamaService] Error pulling model:', error);
      return false;
    }
  }

  /**
   * Preloads the specified model by making a dummy generate request with keep_alive.
   * This keeps the model loaded in memory for faster subsequent responses.
   */
  private async preloadModel(modelName: string): Promise<void> {
    try {
      console.log(`[OllamaService] Preloading model: ${modelName}`);
      const response = await fetch(`${this.baseUrl}/api/generate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: modelName,
          prompt: 'Hello',
          keep_alive: -1,
          stream: false,
        }),
      });

      if (response.ok) {
        console.log(`[OllamaService] Model ${modelName} preloaded successfully`);
      } else {
        console.warn(`[OllamaService] Failed to preload model ${modelName}: ${response.status}`);
      }
    } catch (error) {
      console.warn(`[OllamaService] Error preloading model ${modelName}:`, error);
    }
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