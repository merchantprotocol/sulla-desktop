/**
 * LLM Registry - Central access point for LLM services
 *
 * Provides:
 * - getLLMService('local' | 'remote' | modelName)
 * - getLocalService() / getRemoteService()
 * - getLocalModel() / getRemoteModel()
 * - getHeartbeatLLM() — respects heartbeatProvider → primary provider fallback
 *
 * Resolves provider-specific service classes from IntegrationService credentials.
 * Falls back to SullaSettingsModel for legacy settings.
 * All services lazy-init / reconfigure on demand.
 */

import { BaseLanguageModel } from './BaseLanguageModel';
import { getOllamaService } from './OllamaService';
import { SullaSettingsModel } from '../database/models/SullaSettingsModel';
import { modelDiscoveryService, type ModelInfo } from './ModelDiscoveryService';
import { getIntegrationService } from '../services/IntegrationService';

// Provider factory map — lazy-loaded to avoid circular imports
const PROVIDER_FACTORIES: Record<string, () => Promise<BaseLanguageModel>> = {
  ollama:    async() => { return getOllamaService() },
  grok:      async() => { const { getGrokService } = await import('./GrokService'); return getGrokService() },
  openai:    async() => { const { getOpenAIService } = await import('./OpenAIService'); return getOpenAIService() },
  anthropic: async() => { const { getAnthropicService } = await import('./AnthropicService'); return getAnthropicService() },
  google:    async() => { const { getGoogleService } = await import('./GoogleService'); return getGoogleService() },
  kimi:      async() => { const { getKimiService } = await import('./KimiService'); return getKimiService() },
  nvidia:    async() => { const { getNvidiaService } = await import('./NvidiaService'); return getNvidiaService() },
  alibaba:   async() => { const { getAlibabaService } = await import('./AlibabaService'); return getAlibabaService() },
  custom:    async() => { const { getCustomService } = await import('./CustomService'); return getCustomService() },
};

class LLMRegistryImpl {
  private services = new Map<string, BaseLanguageModel>();

  /**
   * Get service by mode or model name
   */
  async getService(specifier: 'local' | 'remote' | string): Promise<BaseLanguageModel> {
    if (specifier === 'local') return this.getLocalService();
    if (specifier === 'remote') return this.getRemoteService();

    // By model name
    if (this.isLikelyLocalModel(specifier)) {
      return this.getLocalService(specifier);
    }
    return this.getRemoteService(specifier);
  }

  async getLocalService(overrideModel?: string): Promise<BaseLanguageModel> {
    const key = 'local';
    let svc = this.services.get(key);

    if (!svc) {
      svc = await getOllamaService();
      if (overrideModel) {
        console.warn('[LLMRegistry] Local model override requested — using global Ollama instance');
      }
      this.services.set(key, svc);
      svc.initialize().catch(console.error);
    }

    return svc;
  }

  /**
   * Resolve the active remote provider from IntegrationService and create
   * the appropriate provider-specific service class.
   *
   * Falls back to SullaSettingsModel.remoteProvider for legacy compat.
   */
  async getRemoteService(overrideModel?: string): Promise<BaseLanguageModel> {
    // Determine which remote provider is active
    const remoteProvider = await this.getActiveRemoteProviderId();
    const key = `remote:${ remoteProvider }`;
    let svc = this.services.get(key);

    if (!svc) {
      const factory = PROVIDER_FACTORIES[remoteProvider];
      if (factory) {
        svc = await factory();
      } else {
        // Unknown provider — try custom OpenAI-compatible
        console.warn(`[LLMRegistry] Unknown provider '${ remoteProvider }', falling back to custom`);
        const { getCustomService } = await import('./CustomService');
        svc = await getCustomService();
      }

      this.services.set(key, svc);
      svc.initialize().catch(console.error);
    }

    return svc;
  }

  /**
   * Get service by specific provider ID (e.g., 'anthropic', 'grok')
   */
  async getServiceByProvider(providerId: string): Promise<BaseLanguageModel> {
    const key = `provider:${ providerId }`;
    let svc = this.services.get(key);

    if (!svc) {
      const factory = PROVIDER_FACTORIES[providerId];
      if (!factory) {
        throw new Error(`Unknown LLM provider: ${ providerId }`);
      }
      svc = await factory();
      this.services.set(key, svc);
      svc.initialize().catch(console.error);
    }

    return svc;
  }

  // ============================================================================
  // PRIMARY / SECONDARY PROVIDER (new canonical API)
  // ============================================================================

  /**
   * Get the primary LLM service. Reads `primaryProvider` from settings,
   * defaults to 'ollama'. Returns a fully instantiated, ready-to-call service.
   */
  async getPrimaryService(): Promise<BaseLanguageModel> {
    const providerId = await SullaSettingsModel.get('primaryProvider', 'ollama');
    return this.getServiceByProvider(providerId);
  }

  /**
   * Get the secondary (fallback) LLM service. Reads `secondaryProvider` from
   * settings, defaults to 'ollama'. Used when the primary provider is
   * inaccessible.
   */
  async getSecondaryService(): Promise<BaseLanguageModel> {
    const providerId = await SullaSettingsModel.get('secondaryProvider', 'ollama');
    return this.getServiceByProvider(providerId);
  }

  /**
   * Heartbeat-aware service.
   * Reads `heartbeatProvider` from settings — 'default' delegates to primary provider,
   * otherwise resolves the specific provider by ID.
   */
  async getHeartbeatLLM(): Promise<BaseLanguageModel> {
    const heartbeatProvider = await SullaSettingsModel.get('heartbeatProvider', 'default');

    if (heartbeatProvider === 'default') return this.getPrimaryService();
    return this.getServiceByProvider(heartbeatProvider);
  }

  async getLocalModel(): Promise<string> {
    const svc = await this.getLocalService();
    return svc.getModel();
  }

  async getRemoteModel(): Promise<string> {
    const svc = await this.getRemoteService();
    return svc.getModel();
  }

  private isLikelyLocalModel(name: string): boolean {
    return (
      name.includes(':') ||
      !!(/^\d+b$/.exec(name)) ||
      /^(llama|phi|qwen|gemma|mistral|deepseek|ollama)/i.test(name)
    );
  }

  /**
   * Determine which remote provider is active.
   * Checks connected integrations first, falls back to legacy settings.
   */
  private async getActiveRemoteProviderId(): Promise<string> {
    try {
      const integrationService = getIntegrationService();
      // Check each AI provider in priority order for a connected integration
      for (const providerId of ['grok', 'anthropic', 'openai', 'google', 'kimi', 'nvidia', 'alibaba', 'custom']) {
        const connected = await integrationService.isAnyAccountConnected(providerId);
        if (connected) {
          return providerId;
        }
      }
    } catch {
      // IntegrationService not ready
    }

    // Fallback to legacy setting
    return SullaSettingsModel.get('remoteProvider', 'grok');
  }

  async getCurrentModel(): Promise<string> {
    const mode = await SullaSettingsModel.get('modelMode', 'local');
    if (mode === 'remote') {
      return this.getRemoteModel();
    }
    return this.getLocalModel();
  }

  getCurrentMode(): Promise<'local' | 'remote'> {
    return SullaSettingsModel.get('modelMode', 'local');
  }

  async getCurrentConfig(): Promise<any> {
    const mode = await SullaSettingsModel.get('modelMode', 'local');
    const localModel = await this.getLocalModel();
    const remoteProviderId = await this.getActiveRemoteProviderId();

    let remoteModel = '';
    let remoteApiKey = '';
    try {
      const integrationService = getIntegrationService();
      const values = await integrationService.getFormValues(remoteProviderId);
      const valMap: Record<string, string> = {};
      for (const v of values) valMap[v.property] = v.value;
      remoteModel = valMap.model || '';
      remoteApiKey = valMap.api_key || '';
    } catch {
      remoteModel = await SullaSettingsModel.get('remoteModel', '');
      remoteApiKey = await SullaSettingsModel.get('remoteApiKey', '');
    }

    return {
      mode,
      localModel,
      remoteModel,
      remoteProvider: remoteProviderId,
      remoteApiKey,
    };
  }

  /**
   * Explicit context-based service access
   */
  async getServiceForContext(context: 'local' | 'remote', model?: string): Promise<BaseLanguageModel> {
    if (context === 'local') {
      return this.getLocalService(model);
    }
    return this.getRemoteService(model);
  }

  /**
   * Invalidate cached service instances (e.g., when credentials change)
   */
  invalidate(providerId?: string): void {
    if (providerId) {
      for (const key of this.services.keys()) {
        if (key.includes(providerId)) {
          this.services.delete(key);
        }
      }
    } else {
      this.services.clear();
    }
  }

  // ============================================================================
  // DYNAMIC MODEL DISCOVERY
  // ============================================================================

  /**
   * Fetch available models for a specific provider.
   * Pulls API key from IntegrationService, falls back to provided apiKey param.
   */
  async fetchModelsForProvider(providerId: string, apiKey?: string): Promise<ModelInfo[]> {
    let key = apiKey || '';

    if (!key) {
      try {
        const integrationService = getIntegrationService();
        const values = await integrationService.getFormValues(providerId);
        const valMap: Record<string, string> = {};
        for (const v of values) valMap[v.property] = v.value;
        key = valMap.api_key || '';
      } catch {
        // Fallback
        key = await SullaSettingsModel.get('remoteApiKey', '');
      }
    }

    if (!key) {
      throw new Error(`No API key configured for provider: ${ providerId }`);
    }

    return await modelDiscoveryService.fetchModelsForProvider(providerId, key);
  }

  /**
   * Fetch available models from all configured providers.
   * Pulls API keys from IntegrationService.
   */
  async fetchAllAvailableModels(): Promise<ModelInfo[]> {
    const providers: Record<string, string> = {};
    const supportedProviders = modelDiscoveryService.getSupportedProviders();

    for (const providerId of supportedProviders) {
      try {
        const integrationService = getIntegrationService();
        const values = await integrationService.getFormValues(providerId);
        const valMap: Record<string, string> = {};
        for (const v of values) valMap[v.property] = v.value;
        const apiKey = valMap.api_key || '';
        if (apiKey.trim()) {
          providers[providerId] = apiKey;
        }
      } catch (error) {
        console.warn(`[LLMRegistry] Failed to get API key for ${ providerId }:`, error);
      }
    }

    return await modelDiscoveryService.fetchAllAvailableModels(providers);
  }

  /**
   * Get currently configured remote models (for backwards compatibility)
   */
  async getCurrentRemoteModels(): Promise<ModelInfo[]> {
    const remoteProvider = await this.getActiveRemoteProviderId();
    const svc = await this.getRemoteService();

    return [{
      id:       svc.getModel(),
      name:     svc.getModel(),
      provider: remoteProvider,
    }];
  }

  clearModelCache(providerId?: string): void {
    modelDiscoveryService.clearCache(providerId);
  }

  getModelCacheStats(): { size: number; providers: string[] } {
    return modelDiscoveryService.getCacheStats();
  }

  getSupportedProviders(): string[] {
    return modelDiscoveryService.getSupportedProviders();
  }
}

export const LLMRegistry = new LLMRegistryImpl();

export const getLLMService = async(spec: 'local' | 'remote' | string) => await LLMRegistry.getService(spec);
export const getLocalService = async(model?: string) => await LLMRegistry.getLocalService(model);
export const getRemoteService = async(model?: string) => await LLMRegistry.getRemoteService(model);
export const getHeartbeatLLM = async() => await LLMRegistry.getHeartbeatLLM();
export const getLocalModel = async() => await LLMRegistry.getLocalModel();
export const getRemoteModel = async() => await LLMRegistry.getRemoteModel();
export const getService = async(context: 'local' | 'remote', model?: string) =>
  await LLMRegistry.getServiceForContext(context, model);
export const getCurrentModel = async() => await LLMRegistry.getCurrentModel();
export const getCurrentMode = async() => await LLMRegistry.getCurrentMode();

// Primary / Secondary / Heartbeat provider exports
export const getPrimaryService = async() => await LLMRegistry.getPrimaryService();
export const getSecondaryService = async() => await LLMRegistry.getSecondaryService();
export const getHeartbeatService = async() => await LLMRegistry.getHeartbeatLLM();

// Dynamic model discovery exports
export const fetchModelsForProvider = async(providerId: string, apiKey?: string) =>
  await LLMRegistry.fetchModelsForProvider(providerId, apiKey);
export const fetchAllAvailableModels = async() =>
  await LLMRegistry.fetchAllAvailableModels();
export const getCurrentRemoteModels = async() =>
  await LLMRegistry.getCurrentRemoteModels();
export const clearModelCache = (providerId?: string) =>
  LLMRegistry.clearModelCache(providerId);
export const getModelCacheStats = () =>
  LLMRegistry.getModelCacheStats();
export const getSupportedProviders = () =>
  LLMRegistry.getSupportedProviders();

// Export ModelInfo type for external use
export type { ModelInfo };
export const getCurrentConfig = async() => await LLMRegistry.getCurrentConfig();
