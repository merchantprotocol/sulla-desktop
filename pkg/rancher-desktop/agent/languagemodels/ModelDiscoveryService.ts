/**
 * Model Discovery Service
 *
 * Dynamically fetches available models from LLM provider APIs
 * Supports: OpenAI, Anthropic, Google, Grok, Kimi, NVIDIA, Alibaba, Cohere, DeepSeek, Arcee
 * Features: Caching, error handling, provider-specific endpoint mapping
 */

interface ModelInfo {
  id:             string;
  name:           string;
  provider:       string;
  description?:   string;
  capabilities?:  string[];
  contextLength?: number;
  pricing?: {
    input?:  number;
    output?: number;
  };
}

interface ProviderConfig {
  baseUrl:        string;
  modelsEndpoint: string;
  authHeader:     string;
  parseResponse:  (data: any) => ModelInfo[];
  staticModels?:  ModelInfo[]; // Use static list when /models endpoint isn't supported
}

export class ModelDiscoveryService {
  private cache = new Map<string, { models: ModelInfo[]; timestamp: number }>();
  private readonly cacheTimeout = 30 * 60 * 1000; // 30 minutes

  private providers: Record<string, ProviderConfig> = {
    openai: {
      baseUrl:        'https://api.openai.com/v1',
      modelsEndpoint: '/models',
      authHeader:     'Authorization',
      parseResponse:  (data) => data.data?.map((model: any) => ({
        id:           model.id,
        name:         model.id,
        provider:     'openai',
        capabilities: model.capabilities,
      })) || [],
    },

    anthropic: {
      baseUrl:        'https://api.anthropic.com/v1',
      modelsEndpoint: '/models',
      authHeader:     'x-api-key',
      parseResponse:  (data) => {
        // Parse real Anthropic models API response
        if (data && Array.isArray(data.data)) {
          return data.data.map((model: any) => ({
            id:            model.id,
            name:          model.display_name || model.id,
            provider:      'anthropic',
            contextLength: model.context_length || 200000,
            description:   model.description || `${ model.display_name || model.id } model`,
            created:       model.created,
            type:          model.type,
          }));
        }
        // Fallback if API structure is different
        if (data && Array.isArray(data)) {
          return data.map((model: any) => ({
            id:            model.id,
            name:          model.display_name || model.name || model.id,
            provider:      'anthropic',
            contextLength: model.context_length || model.contextLength || 200000,
            description:   model.description || `${ model.display_name || model.name || model.id } model`,
          }));
        }
        return [];
      },
    },

    google: {
      baseUrl:        'https://generativelanguage.googleapis.com/v1beta',
      modelsEndpoint: '/models',
      authHeader:     'Authorization',
      parseResponse:  (data) => data.models?.map((model: any) => ({
        id:           model.name.replace('models/', ''),
        name:         model.displayName || model.name,
        provider:     'google',
        capabilities: model.supportedGenerationMethods,
      })) || [],
    },

    grok: {
      baseUrl:        'https://api.x.ai/v1',
      modelsEndpoint: '/models',
      authHeader:     'Authorization',
      parseResponse:  (data) => data.data?.map((model: any) => ({
        id:       model.id,
        name:     model.id,
        provider: 'grok',
      })) || [],
    },

    kimi: {
      baseUrl:        'https://api.moonshot.cn/v1',
      modelsEndpoint: '/models',
      authHeader:     'Authorization',
      parseResponse:  (data) => data.data?.map((model: any) => ({
        id:       model.id,
        name:     model.id,
        provider: 'kimi',
      })) || [],
    },

    nvidia: {
      baseUrl:        'https://integrate.api.nvidia.com/v1',
      modelsEndpoint: '/models',
      authHeader:     'Authorization',
      parseResponse:  (data) => data.data?.map((model: any) => ({
        id:       model.id,
        name:     model.id,
        provider: 'nvidia',
      })) || [],
    },

    alibaba: {
      baseUrl:        'https://coding-intl.dashscope.aliyuncs.com/v1',
      modelsEndpoint: '/models',
      authHeader:     'Authorization',
      parseResponse:  (data) => data.data?.map((model: any) => ({
        id:       model.id,
        name:     model.id,
        provider: 'alibaba',
      })) || [],
      // Coding Plan endpoint doesn't support /models — use static list
      staticModels: [
        { id: 'qwen3.5-plus', name: 'Qwen 3.5 Plus', provider: 'alibaba' },
        { id: 'MiniMax-M2.5', name: 'MiniMax M2.5', provider: 'alibaba' },
        { id: 'kimi-k2.5', name: 'Kimi K2.5', provider: 'alibaba' },
        { id: 'glm-5', name: 'GLM 5', provider: 'alibaba' },
        { id: 'qwen3-coder-plus', name: 'Qwen 3 Coder Plus', provider: 'alibaba' },
        { id: 'qwen3-coder-next', name: 'Qwen 3 Coder Next', provider: 'alibaba' },
        { id: 'qwen3-max-2026-01-23', name: 'Qwen 3 Max', provider: 'alibaba' },
        { id: 'glm-4.7', name: 'GLM 4.7', provider: 'alibaba' },
      ],
    },

    groq: {
      baseUrl:        'https://api.groq.com/openai/v1',
      modelsEndpoint: '/models',
      authHeader:     'Authorization',
      parseResponse:  (data) => data.data?.map((model: any) => ({
        id:       model.id,
        name:     model.id,
        provider: 'groq',
      })) || [],
    },

    mistral: {
      baseUrl:        'https://api.mistral.ai/v1',
      modelsEndpoint: '/models',
      authHeader:     'Authorization',
      parseResponse:  (data) => data.data?.map((model: any) => ({
        id:       model.id,
        name:     model.id,
        provider: 'mistral',
      })) || [],
      staticModels: [
        { id: 'codestral-latest', name: 'Codestral (latest)', provider: 'mistral', description: 'Purpose-built for code — free for non-commercial use' },
        { id: 'devstral-small-2505', name: 'Devstral Small', provider: 'mistral', description: 'Agentic coding model' },
        { id: 'mistral-small-latest', name: 'Mistral Small (latest)', provider: 'mistral', description: 'Fast, cost-effective' },
        { id: 'mistral-medium-latest', name: 'Mistral Medium (latest)', provider: 'mistral', description: 'Balanced performance' },
        { id: 'mistral-large-latest', name: 'Mistral Large (latest)', provider: 'mistral', description: 'Most capable' },
        { id: 'open-mistral-nemo', name: 'Mistral Nemo', provider: 'mistral', description: 'Open, 12B, multilingual' },
      ],
    },

    cerebras: {
      baseUrl:        'https://api.cerebras.ai/v1',
      modelsEndpoint: '/models',
      authHeader:     'Authorization',
      parseResponse:  (data) => data.data?.map((model: any) => ({
        id:       model.id,
        name:     model.id,
        provider: 'cerebras',
      })) || [],
      staticModels: [
        { id: 'llama-3.3-70b', name: 'Llama 3.3 70B', provider: 'cerebras', description: 'Most capable free model on Cerebras' },
        { id: 'llama-3.1-8b', name: 'Llama 3.1 8B', provider: 'cerebras', description: 'Fast, lightweight — great for quick tasks' },
        { id: 'qwen-3-32b', name: 'Qwen 3 32B', provider: 'cerebras', description: 'Strong reasoning and coding' },
      ],
    },

    together: {
      baseUrl:        'https://api.together.xyz/v1',
      modelsEndpoint: '/models',
      authHeader:     'Authorization',
      parseResponse:  (data) => {
        const list = Array.isArray(data) ? data : (data.data || []);
        return list.map((model: any) => ({
          id:       model.id,
          name:     model.display_name || model.id,
          provider: 'together',
        }));
      },
      staticModels: [
        { id: 'deepseek-ai/DeepSeek-V3', name: 'DeepSeek V3', provider: 'together', description: 'Top open-source coding model' },
        { id: 'Qwen/Qwen2.5-Coder-32B-Instruct', name: 'Qwen 2.5 Coder 32B', provider: 'together', description: 'Strong coding + instruction following' },
        { id: 'meta-llama/Llama-4-Scout-17B-16E-Instruct', name: 'Llama 4 Scout', provider: 'together', description: 'Meta\'s latest — fast and capable' },
        { id: 'meta-llama/Llama-4-Maverick-17B-128E-Instruct', name: 'Llama 4 Maverick', provider: 'together', description: 'Meta\'s latest — long context' },
        { id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', name: 'Llama 3.3 70B Turbo', provider: 'together', description: 'Fast 70B inference' },
        { id: 'mistralai/Mixtral-8x7B-Instruct-v0.1', name: 'Mixtral 8x7B', provider: 'together', description: 'Efficient MoE model' },
      ],
    },

    ollama: {
      baseUrl:        'http://localhost:11434/v1',
      modelsEndpoint: '/models',
      authHeader:     'Authorization',
      parseResponse:  (data) => data.data?.map((model: any) => ({
        id:       model.id,
        name:     model.id,
        provider: 'ollama',
      })) || [],
      staticModels: [
        { id: 'llama3.2', name: 'Llama 3.2', provider: 'ollama', description: 'Meta Llama 3.2 — general purpose' },
        { id: 'llama3.1', name: 'Llama 3.1', provider: 'ollama', description: 'Meta Llama 3.1 — general purpose' },
        { id: 'codellama', name: 'Code Llama', provider: 'ollama', description: 'Meta Code Llama — code generation' },
        { id: 'deepseek-coder-v2', name: 'DeepSeek Coder V2', provider: 'ollama', description: 'Strong open-source coding model' },
        { id: 'qwen2.5-coder', name: 'Qwen 2.5 Coder', provider: 'ollama', description: 'Alibaba Qwen coding model' },
        { id: 'qwen2.5-coder:32b', name: 'Qwen 2.5 Coder 32B', provider: 'ollama', description: 'Full-size Qwen coding model' },
        { id: 'starcoder2', name: 'StarCoder2', provider: 'ollama', description: 'BigCode StarCoder2 — code completion' },
        { id: 'mistral', name: 'Mistral 7B', provider: 'ollama', description: 'Fast, capable general model' },
        { id: 'phi4', name: 'Phi-4', provider: 'ollama', description: 'Microsoft Phi-4 — efficient reasoning' },
      ],
    },

    cohere: {
      // Chat uses compatibility API, models use v2 API
      baseUrl:        'https://api.cohere.ai/compatibility/v1',
      modelsEndpoint: 'https://api.cohere.com/v2/models',
      authHeader:     'Authorization',
      parseResponse:  (data) => {
        // Parse Cohere models API response - filter to tool-capable Command models only
        if (data && Array.isArray(data.models)) {
          return data.models
            .filter((model: any) => {
              const name = (model.name || '').toLowerCase();
              // Only Command models support tool use
              // Exclude: Aya, Tiny Aya, transcribe, embed, rerank
              return name.startsWith('command') && !name.includes('transcribe');
            })
            .map((model: any) => ({
              id:          model.name,
              name:        model.name,
              provider:    'cohere',
              description: model.description || `${ model.name } model`,
            }));
        }
        return [];
      },
      // Fallback static list - only Command models (support tool use)
      staticModels: [
        // Command A - Latest flagship
        { id: 'command-a-03-2025', name: 'Command A', provider: 'cohere', description: 'Latest flagship - tool use, RAG, agents' },
        { id: 'command-a-reasoning-08-2025', name: 'Command A Reasoning', provider: 'cohere', description: 'Advanced reasoning - tool use, complex reasoning' },
        { id: 'command-a-translate-08-2025', name: 'Command A Translate', provider: 'cohere', description: 'Translation optimized - tool use, multilingual' },
        { id: 'command-a-vision-07-2025', name: 'Command A Vision', provider: 'cohere', description: 'Multimodal vision - tool use, image + text' },
        // Command R7B - Fast lightweight
        { id: 'command-r7b-12-2024', name: 'Command R7B', provider: 'cohere', description: 'Fast, lightweight - tool use, RAG, everyday tasks' },
        { id: 'command-r7b-arabic-02-2025', name: 'Command R7B Arabic', provider: 'cohere', description: 'Arabic optimized - tool use, fast, lightweight' },
        // Command R - Balanced
        { id: 'command-r-08-2024', name: 'Command R (08-2024)', provider: 'cohere', description: 'Balanced - tool use, conversation, RAG' },
        { id: 'command-r-03-2024', name: 'Command R (03-2024)', provider: 'cohere', description: 'Earlier Command R - tool use, conversation' },
        { id: 'command-r', name: 'Command R', provider: 'cohere', description: 'Balanced - tool use, everyday tasks' },
        // Command R+ - Advanced reasoning
        { id: 'command-r-plus-08-2024', name: 'Command R+ (08-2024)', provider: 'cohere', description: 'Advanced reasoning - tool use, complex tasks' },
        { id: 'command-r-plus-04-2024', name: 'Command R+ (04-2024)', provider: 'cohere', description: 'Earlier Command R+ - tool use, reasoning' },
        { id: 'command-r-plus', name: 'Command R+', provider: 'cohere', description: 'Advanced reasoning - tool use, complex tasks' },
      ],
    },

    deepseek: {
      baseUrl:        'https://api.deepseek.com',
      modelsEndpoint: '/models',
      authHeader:     'Authorization',
      parseResponse:  (data) => {
        // Parse DeepSeek models API response
        if (data && Array.isArray(data.data)) {
          return data.data.map((model: any) => ({
            id:          model.id,
            name:        model.id,
            provider:    'deepseek',
            description: model.description || `${ model.id } model`,
          }));
        }
        return [];
      },
      // Fallback static list - DeepSeek V4 models
      staticModels: [
        { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', provider: 'deepseek', description: 'Fast, efficient model - tool use, coding, reasoning (non-thinking mode)' },
        { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', provider: 'deepseek', description: 'Most capable model - tool use, complex reasoning, coding' },
        // Legacy aliases (to be deprecated 2026/07/24)
        { id: 'deepseek-chat', name: 'DeepSeek-Chat (Legacy)', provider: 'deepseek', description: 'TO BE DEPRECATED 2026/07/24 - Maps to V4 Flash non-thinking mode' },
        { id: 'deepseek-reasoner', name: 'DeepSeek-R1 Reasoner (Legacy)', provider: 'deepseek', description: 'TO BE DEPRECATED 2026/07/24 - Maps to V4 Flash thinking mode' },
      ],
    },

    arcee: {
      baseUrl:        'https://api.arcee.ai/api/v1',
      modelsEndpoint: '/models',
      authHeader:     'Authorization',
      parseResponse:  (data) => {
        // Parse Arcee models API response
        if (data && Array.isArray(data.data)) {
          return data.data.map((model: any) => ({
            id:          model.id,
            name:        model.id,
            provider:    'arcee',
            description: model.description || `${ model.id } model`,
          }));
        }
        return [];
      },
      // Fallback static list - Arcee Trinity models
      staticModels: [
        { id: 'trinity-large-thinking', name: 'Trinity Large Thinking', provider: 'arcee', description: 'Arcee\'s most capable thinking model - tool use, reasoning, coding' },
        { id: 'trinity-large-preview', name: 'Trinity Large Preview', provider: 'arcee', description: 'Preview of latest improvements - tool use, reasoning, coding' },
        { id: 'trinity-mini', name: 'Trinity Mini', provider: 'arcee', description: 'Fast, efficient model - tool use, quick tasks' },
      ],
    },
  };

  /**
   * Fetch available models for a specific provider
   */
  async fetchModelsForProvider(providerId: string, apiKey: string): Promise<ModelInfo[]> {
    const cacheKey = `${ providerId }-${ apiKey.slice(-8) }`;
    const cached = this.cache.get(cacheKey);

    // Return cached results if still valid
    if (cached && (Date.now() - cached.timestamp) < this.cacheTimeout) {
      return cached.models;
    }

    const provider = this.providers[providerId];
    if (!provider) {
      throw new Error(`Unsupported provider: ${ providerId }`);
    }

    // If provider has a static model list (e.g. endpoint doesn't support /models), use it
    if (provider.staticModels?.length) {
      this.cache.set(cacheKey, { models: provider.staticModels, timestamp: Date.now() });
      return provider.staticModels;
    }

    try {
      const url = `${ provider.baseUrl }${ provider.modelsEndpoint }`;
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'User-Agent':   'Sulla-Desktop/1.0',
      };

      // Set auth header
      if (provider.authHeader === 'Authorization') {
        headers.Authorization = `Bearer ${ apiKey }`;
      } else {
        headers[provider.authHeader] = apiKey;
      }

      // Add required headers for specific providers
      if (providerId === 'anthropic') {
        headers['anthropic-version'] = '2023-06-01';
      }

      const response = await fetch(url, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(10000), // 10 second timeout
      });

      if (!response.ok) {
        if (response.status === 401) {
          throw new Error(`Invalid API key for ${ providerId }`);
        }
        if (response.status === 403) {
          throw new Error(`Access denied for ${ providerId } models endpoint`);
        }
        throw new Error(`Failed to fetch models from ${ providerId }: ${ response.status } ${ response.statusText }`);
      }

      const data = await response.json();
      const models = provider.parseResponse(data);

      // Cache the results
      this.cache.set(cacheKey, { models, timestamp: Date.now() });

      return models;
    } catch (error) {
      console.warn(`[ModelDiscovery] Failed to fetch models for ${ providerId }:`, error);

      // Return cached results if available, even if expired
      if (cached) {
        return cached.models;
      }

      // Return empty array on complete failure
      return [];
    }
  }

  /**
   * Fetch models for all configured providers
   */
  async fetchAllAvailableModels(providers: Record<string, string>): Promise<ModelInfo[]> {
    const allModels: ModelInfo[] = [];

    const promises = Object.entries(providers).map(async([providerId, apiKey]) => {
      if (!apiKey || apiKey.trim() === '') {
        return [];
      }

      try {
        return await this.fetchModelsForProvider(providerId, apiKey);
      } catch (error) {
        console.warn(`[ModelDiscovery] Skipping ${ providerId }:`, error);
        return [];
      }
    });

    const results = await Promise.allSettled(promises);

    for (const result of results) {
      if (result.status === 'fulfilled') {
        allModels.push(...result.value);
      }
    }

    return allModels;
  }

  /**
   * Get supported providers
   */
  getSupportedProviders(): string[] {
    return Object.keys(this.providers);
  }

  /**
   * Clear cache for a specific provider or all providers
   */
  clearCache(providerId?: string): void {
    if (providerId) {
      for (const key of this.cache.keys()) {
        if (key.startsWith(`${ providerId }-`)) {
          this.cache.delete(key);
        }
      }
    } else {
      this.cache.clear();
    }
  }

  /**
   * Get cache stats
   */
  getCacheStats(): { size: number; providers: string[] } {
    return {
      size:      this.cache.size,
      providers: Array.from(new Set(
        Array.from(this.cache.keys()).map(key => key.split('-')[0]),
      )),
    };
  }
}

export const modelDiscoveryService = new ModelDiscoveryService();
export type { ModelInfo };
