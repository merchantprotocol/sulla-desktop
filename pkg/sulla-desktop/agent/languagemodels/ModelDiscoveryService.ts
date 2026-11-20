// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Model Discovery Service
 *
 * Dynamically fetches available models from LLM provider APIs
 * Supports: OpenAI, Anthropic, Google, Grok, Kimi, NVIDIA, Alibaba, Cohere, DeepSeek, Arcee
 * Features: Caching, error handling, provider-specific endpoint mapping
 */

import { usesContainerVaultAuthority } from '../../vault-broker';
import { OPENAI_COMPATIBLE_PROVIDERS, providerBaseUrl, type OpenAICompatibleProviderDefinition } from './openAICompatibleProviders';
import { alibabaBaseUrl, kimiBaseUrl } from './providerEndpoints';

import type { BrokerInjection } from '../../vault-broker';

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
}

export class ModelDiscoveryService {
  private cache = new Map<string, { models: ModelInfo[]; timestamp: number }>();
  private failures = new Map<string, string>();
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
      authHeader:     'x-goog-api-key',
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
      // The Coding Plan /models endpoint DOES return a live catalog (verified 2026-07-20).
      // Fetch it live so new models (e.g. qwen3.6-plus, qwen3.7-plus) appear automatically;
      // fall back to the list below only if the endpoint is unreachable.
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
      // No static fallback: only list models the user's own server reports.
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
    },

    ...Object.fromEntries(OPENAI_COMPATIBLE_PROVIDERS.map((definition: OpenAICompatibleProviderDefinition) => [definition.id, {
      // Azure needs the user's resource URL, so its base URL can't be built
      // from empty values. Computing it here at load time must never throw,
      // or the whole main process fails to start.
      baseUrl: (() => {
        try {
          return providerBaseUrl(definition, {});
        } catch {
          return '';
        }
      })(),
      modelsEndpoint: definition.modelsUrl.startsWith('http') ? definition.modelsUrl : definition.modelsUrl,
      authHeader: 'Authorization',
      parseResponse: (data: any) => {
        const list = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : [];
        return list.map((model: any) => {
          const id = String(model.id || model.name || model.model || '');
          return { id, name: model.name || model.display_name || id, provider: definition.id, description: model.description };
        }).filter((model: ModelInfo) => model.id && definition.defaultModelFilter.test(model.id));
      },
    }])),

    custom: {
      baseUrl:        '',
      modelsEndpoint: '/models',
      authHeader:     'Authorization',
      parseResponse:  (data) => data.data?.map((model: any) => ({
        id:       model.id,
        name:     model.id,
        provider: 'custom',
      })) || [],
    },
  };

  supportsProvider(providerId: string): boolean { return Object.prototype.hasOwnProperty.call(this.providers, providerId); }

  getLastFailure(providerId: string): string | undefined { return this.failures.get(providerId); }

  /**
   * Fetch available models for a specific provider
   */
  async fetchModelsForProvider(providerId: string, apiKey = '', options: { accountId?: string; baseUrl?: string; region?: string; liveOnly?: boolean } = {}): Promise<ModelInfo[]> {
    // Listing authority is Cloud, never account discovery. Private user endpoints
    // are explicitly scoped and must not be uploaded to the public catalog.
    if (!['custom', 'ollama', 'lm-studio', 'local-server'].includes(providerId)) {
      const { sharedModelCatalog } = await import('./sharedModelCatalog');
      return (await sharedModelCatalog.listModels(providerId)).map(model => ({
        id: model.id, name: model.name, provider: providerId,
        capabilities: model.capabilities, contextLength: model.contextWindow,
      }));
    }
    // A key supplied by the Connect form is intentionally used for a direct
    // verification request. Saved accounts have no renderer-visible key and
    // therefore take the brokered provider.discovery lane below.
    const containerAuthority = usesContainerVaultAuthority() && !['ollama', 'lm-studio', 'local-server'].includes(providerId) && !apiKey;
    const broker = containerAuthority ? await import('./providerBroker') : null;
    const runtime = broker ? await broker.loadProviderRuntimeConfig(providerId, options.accountId) : null;
    const cacheKey = (containerAuthority
      ? `${ providerId }-${ runtime!.accountId }`
      : `${ providerId }-${ apiKey.slice(-8) }-${ options.baseUrl || '' }-${ options.region || '' }`) + (options.liveOnly ? '-live' : '-fallback');
    const cached = this.cache.get(cacheKey);

    // Return cached results if still valid
    if (cached && (Date.now() - cached.timestamp) < this.cacheTimeout) {
      return cached.models;
    }

    const provider = this.providers[providerId];
    if (!provider) {
      throw new Error(`Unsupported provider: ${ providerId }`);
    }
    if (!provider.modelsEndpoint) return [];

    // Always attempt live discovery first for every provider so newly released
    // models appear automatically. Former static arrays are not an authority; failures leave
    // the private endpoint unavailable,
    // never as the authoritative catalog. See the catch block and empty-result
    // handling below.
    try {
      const tableDefinition = OPENAI_COMPATIBLE_PROVIDERS.find(item => item.id === providerId);
      const savedValues = { ...(runtime?.values || {}), ...(options.region ? { region: options.region } : {}) };
      const configuredBaseUrl = tableDefinition
        ? providerBaseUrl(tableDefinition, savedValues)
        : providerId === 'kimi'
          ? kimiBaseUrl(savedValues)
          : providerId === 'alibaba'
            ? alibabaBaseUrl(savedValues)
            : provider.baseUrl;
      const baseUrl = (options.baseUrl || runtime?.values.base_url || configuredBaseUrl).replace(/\/+$/, '');
      if (!baseUrl && !provider.modelsEndpoint.startsWith('http')) {
        this.failures.set(providerId, 'no endpoint configured');
        return [];
      }
      const url = provider.modelsEndpoint.startsWith('http')
        ? provider.modelsEndpoint
        : `${ baseUrl }${ provider.modelsEndpoint }`;
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'User-Agent':   'Sulla-Desktop/1.0',
      };

      if (!containerAuthority) {
        // Server mode retains the existing direct provider transport.
        if (provider.authHeader === 'Authorization') {
          headers.Authorization = `Bearer ${ apiKey }`;
        } else {
          headers[provider.authHeader] = apiKey;
        }
      }

      // Add required headers for specific providers
      if (providerId === 'anthropic') {
        headers['anthropic-version'] = '2023-06-01';
        let workspaceId = runtime?.values.workspace_id || '';
        if (!workspaceId) {
          try {
            const { getIntegrationService } = await import('../services/IntegrationService');
            const values = await getIntegrationService().getFormValues('anthropic');
            workspaceId = values.find((value: { property: string; value: string }) => value.property === 'workspace_id')?.value || '';
            const { getPendingCredential } = await import('../../main/firstRun/pendingCredentials');
            workspaceId = getPendingCredential('anthropic')?.values.workspace_id || workspaceId;
          } catch { /* optional workspace metadata */ }
        }
        workspaceId = workspaceId.trim();
        if (workspaceId) headers['anthropic-workspace-id'] = workspaceId;
      }

      const injections: BrokerInjection[] = provider.authHeader === 'Authorization'
        ? [{ field: 'api_key', target: 'header', name: 'authorization', scheme: 'Bearer' }]
        : [{ field: 'api_key', target: 'header', name: provider.authHeader.toLowerCase(), scheme: 'raw' }];
      const executionContext = containerAuthority
        ? await broker!.issueServiceProviderExecutionContext('model-discovery', providerId, runtime!.accountId)
        : undefined;
      const requestInit: RequestInit = {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(10000), // 10 second timeout
      };
      const response = containerAuthority
        ? await broker!.providerFetch(providerId, url, requestInit, executionContext, {
          streaming: false,
          operation: 'provider.discovery',
          injections,
        })
        : await fetch(url, requestInit);

      if (!response.ok) {
        if (response.status === 401) {
          this.failures.set(providerId, 'API key rejected (401)');
          throw new Error(`Invalid API key for ${ providerId }`);
        }
        if (response.status === 403) {
          this.failures.set(providerId, 'models endpoint access denied (403)');
          throw new Error(`Access denied for ${ providerId } models endpoint`);
        }
        this.failures.set(providerId, `models endpoint returned HTTP ${ response.status }`);
        throw new Error(`Failed to fetch models from ${ providerId }: ${ response.status } ${ response.statusText }`);
      }

      const data = await response.json();
      const models = provider.parseResponse(data);

      // Private endpoints have no bundled fallback.
      const resolved = models.length > 0 ? models : [];
      if (!models.length) this.failures.set(providerId, 'models endpoint returned no models');
      else this.failures.delete(providerId);

      // Cache the results
      this.cache.set(cacheKey, { models: resolved, timestamp: Date.now() });

      return resolved;
    } catch (error) {
      if (!this.failures.has(providerId)) {
        const name = error instanceof Error ? error.name : '';
        this.failures.set(providerId, name === 'TimeoutError' || name === 'AbortError' ? 'models request timed out' : 'models request failed');
      }
      console.warn(`[ModelDiscovery] Failed to fetch models for ${ providerId }:`, error);

      // Return cached results if available, even if expired
      if (cached && !options.liveOnly) {
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
    if (providerId) this.failures.delete(providerId);
    else this.failures.clear();
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

const NON_CHAT_MODEL = /(?:^|[-_/])(embed|embedding|rerank|moderation|transcri|whisper|tts|image|vision-only)(?:$|[-_/])/i;

export function isChatModel(model: ModelInfo): boolean {
  if (NON_CHAT_MODEL.test(model.id)) return false;
  if (model.capabilities?.length) {
    return model.capabilities.some(capability => /generateContent|chat|text|completion/i.test(capability));
  }
  return true;
}

/** Resolve a usable chat model without ever manufacturing an empty/default id. */
export async function resolveFirstChatModel(providerId: string, apiKey = '', baseUrl?: string): Promise<string> {
  // A missing explicit selection is not permission to execute the first listing.
  throw new Error(`Choose an explicit model for ${ providerId }; no default model was selected`);
}
export type { ModelInfo };
