/**
 * LLM Registry - Central access point for LLM services
 *
 * Provides:
 * - getLLMService('remote' | modelName)
 * - getRemoteService()
 * - getRemoteModel()
 * - getHeartbeatLLM() — respects heartbeatProvider → primary provider fallback
 *
 * Reads provider/model state from ModelProviderService (source of truth).
 * Falls back to SullaSettingsModel when the service isn't initialized yet.
 * All services lazy-init / reconfigure on demand.
 */

import { BaseLanguageModel } from './BaseLanguageModel';
import { modelDiscoveryService, type ModelInfo } from './ModelDiscoveryService';
import { isTierName, resolveTierToModelId, type ModelTier } from './ModelTierResolver';
import { SullaSettingsModel } from '../database/models/SullaSettingsModel';
import { getIntegrationService } from '../services/IntegrationService';

// Provider factory map — lazy-loaded to avoid circular imports
const PROVIDER_FACTORIES: Record<string, () => Promise<BaseLanguageModel>> = {
  'claude-code': async() => { const { getClaudeCodeService } = await import('./ClaudeCodeService'); return getClaudeCodeService() },
  cohere:        async() => { const { getCohereService } = await import('./CohereService'); return getCohereService() },
  grok:          async() => { const { getGrokService } = await import('./GrokService'); return getGrokService() },
  groq:          async() => { const { getGroqService } = await import('./GroqService'); return getGroqService() },
  openai:        async() => { const { getOpenAIService } = await import('./OpenAIService'); return getOpenAIService() },
  anthropic:     async() => { const { getAnthropicService } = await import('./AnthropicService'); return getAnthropicService() },
  google:        async() => { const { getGoogleService } = await import('./GoogleService'); return getGoogleService() },
  kimi:          async() => { const { getKimiService } = await import('./KimiService'); return getKimiService() },
  nvidia:        async() => { const { getNvidiaService } = await import('./NvidiaService'); return getNvidiaService() },
  alibaba:       async() => { const { getAlibabaService } = await import('./AlibabaService'); return getAlibabaService() },
  mistral:       async() => { const { getMistralService } = await import('./MistralService'); return getMistralService() },
  cerebras:      async() => { const { getCerebasService } = await import('./CerebasService'); return getCerebasService() },
  together:      async() => { const { getTogetherService } = await import('./TogetherService'); return getTogetherService() },
  ollama:        async() => { const { getOllamaService } = await import('./OllamaService'); return getOllamaService() },
  custom:        async() => { const { getCustomService } = await import('./CustomService'); return getCustomService() },
};

// ── Helper: resolve provider from ModelProviderService or fallback ──

function tryGetModelProviderService(): any | null {
  try {
    const { getModelProviderService } = require('../services/ModelProviderService');
    return getModelProviderService();
  } catch {
    return null;
  }
}

class LLMRegistryImpl {
  private services = new Map<string, BaseLanguageModel>();

  /**
   * Get service by mode or model name
   */
  async getService(specifier: string): Promise<BaseLanguageModel> {
    if (specifier === 'remote') return this.getRemoteService();
    // Treat any specifier as a remote model request
    return this.getRemoteService(specifier);
  }

  /**
   * Resolve the active remote provider and create the appropriate service.
   */
  async getRemoteService(overrideModel?: string): Promise<BaseLanguageModel> {
    const remoteProvider = await this.getActiveRemoteProviderId();
    const key = `remote:${ remoteProvider }`;
    let svc = this.services.get(key);

    if (!svc) {
      const factory = PROVIDER_FACTORIES[remoteProvider];
      if (factory) {
        svc = await factory();
      } else {
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
   * Get service by specific provider ID (e.g., 'anthropic', 'grok').
   * When modelOverride is provided, a separate cached instance is created with
   * that model — allowing different slots (primary vs subconscious) to use the
   * same provider at different model tiers.
   */
  async getServiceByProvider(providerId: string, modelOverride?: string): Promise<BaseLanguageModel> {
    const key = modelOverride ? `provider:${ providerId }:${ modelOverride }` : `provider:${ providerId }`;
    let svc = this.services.get(key);

    if (!svc) {
      if (modelOverride && providerId === 'claude-code') {
        // ClaudeCodeService is a singleton — create a fresh instance so the model
        // override doesn't bleed into the primary orchestrator's instance.
        const { createClaudeCodeService } = await import('./ClaudeCodeService');
        svc = createClaudeCodeService(modelOverride);
      } else {
        const factory = PROVIDER_FACTORIES[providerId];
        if (!factory) {
          throw new Error(`Unknown LLM provider: ${ providerId }`);
        }
        svc = await factory();
        if (modelOverride) {
          svc.setModel(modelOverride);
        }
      }
      this.services.set(key, svc);
      svc.initialize().catch(console.error);
    }

    return svc;
  }

  // ============================================================================
  // PRIMARY / SECONDARY PROVIDER — reads from ModelProviderService (sync)
  // ============================================================================

  /**
   * Get the primary LLM service. Reads from ModelProviderService if available,
   * falls back to SullaSettingsModel.
   */
  async getPrimaryService(): Promise<BaseLanguageModel> {
    const mps = tryGetModelProviderService();
    const providerId = mps
      ? mps.getPrimaryProvider()
      : await SullaSettingsModel.get('primaryProvider', 'grok');
    return this.getServiceByProvider(providerId);
  }

  /**
   * Get the secondary (fallback) LLM service.
   * Applies secondaryModelId override (supports tier names or explicit model IDs).
   */
  async getSecondaryService(): Promise<BaseLanguageModel> {
    const mps = tryGetModelProviderService();
    const providerId = mps
      ? mps.getSecondaryProvider()
      : await SullaSettingsModel.get('secondaryProvider', 'grok');
    const secondaryModelId = mps?.getSecondaryModelId?.() || await SullaSettingsModel.get('secondaryModelId', '');
    const modelOverride = secondaryModelId
      ? (isTierName(secondaryModelId)
        ? await resolveTierToModelId(providerId, secondaryModelId as ModelTier)
        : secondaryModelId)
      : undefined;
    return this.getServiceByProvider(providerId, modelOverride);
  }

  /**
   * Heartbeat-aware service. Runs background agents at the 'fast' tier by default.
   * heartbeatModelId can be a tier name ('fast'|'balanced'|'powerful') or an explicit
   * model ID. Tier names are resolved dynamically from the provider's live model list.
   */
  async getHeartbeatLLM(): Promise<BaseLanguageModel> {
    const mps = tryGetModelProviderService();
    const heartbeatProvider = mps
      ? mps.getHeartbeatProvider()
      : await SullaSettingsModel.get('heartbeatProvider', 'default');

    const effectiveProvider = heartbeatProvider === 'default'
      ? (mps ? mps.getPrimaryProvider() : await SullaSettingsModel.get('primaryProvider', 'grok'))
      : heartbeatProvider;

    const heartbeatModelId = mps?.getHeartbeatModelId?.() || await SullaSettingsModel.get('heartbeatModelId', 'fast');
    const modelOverride = isTierName(heartbeatModelId)
      ? await resolveTierToModelId(effectiveProvider, heartbeatModelId as ModelTier)
      : (heartbeatModelId || undefined);

    return this.getServiceByProvider(effectiveProvider, modelOverride);
  }

  /**
   * Subconscious-aware service. Subconscious agents (memory-recall,
   * observation, unstuck-research) and spawned sub-agents run here at the
   * 'fast' tier by default — cheap, quick recon so the orchestrator doesn't
   * burn expensive tokens on file searching.
   *
   * subconsciousModelId can be a tier name ('fast'|'balanced'|'powerful') or
   * an explicit model ID. Tier names are resolved dynamically from the
   * provider's live model list.
   *
   * Resolution order:
   *   1. Explicit subconsciousProvider setting (if not 'default')
   *   2. Secondary provider (the existing fallback)
   *   3. Primary provider (last resort)
   */
  async getSubconsciousLLM(): Promise<BaseLanguageModel> {
    const mps = tryGetModelProviderService();
    const subconsciousProvider = mps
      ? mps.getSubconsciousProvider()
      : await SullaSettingsModel.get('subconsciousProvider', 'default');
    const subconsciousModelId = mps?.getSubconsciousModelId?.() || await SullaSettingsModel.get('subconsciousModelId', 'fast');

    const resolveModel = async(providerId: string) => isTierName(subconsciousModelId)
      ? await resolveTierToModelId(providerId, subconsciousModelId as ModelTier)
      : (subconsciousModelId || undefined);

    const modelOverride = await resolveModel(
      subconsciousProvider && subconsciousProvider !== 'default'
        ? subconsciousProvider
        : (mps ? mps.getPrimaryProvider() : await SullaSettingsModel.get('primaryProvider', 'grok')),
    );

    const hasUsableModel = (svc: BaseLanguageModel | null | undefined): boolean => {
      try { return !!(svc?.getModel?.() || '').trim() } catch { return false }
    };

    if (subconsciousProvider && subconsciousProvider !== 'default') {
      const svc = await this.getServiceByProvider(subconsciousProvider, modelOverride);
      if (hasUsableModel(svc)) return svc;
    }

    const secondaryProvider = mps
      ? mps.getSecondaryProvider()
      : await SullaSettingsModel.get('secondaryProvider', 'grok');

    if (secondaryProvider) {
      const svc = await this.getServiceByProvider(secondaryProvider, modelOverride);
      if (hasUsableModel(svc)) return svc;
    }

    return this.getPrimaryService();
  }

  async getRemoteModel(): Promise<string> {
    const svc = await this.getRemoteService();
    return svc.getModel();
  }

  /**
   * Determine which remote provider is active.
   * Reads from ModelProviderService first, falls back to legacy.
   */
  private async getActiveRemoteProviderId(): Promise<string> {
    const mps = tryGetModelProviderService();
    if (mps) {
      return mps.getPrimaryProvider();
    }

    // Legacy fallback
    try {
      const integrationService = getIntegrationService();
      for (const providerId of ['grok', 'anthropic', 'openai', 'google', 'kimi', 'nvidia', 'alibaba', 'custom']) {
        const connected = await integrationService.isAnyAccountConnected(providerId);
        if (connected) {
          return providerId;
        }
      }
    } catch {
      // IntegrationService not ready
    }

    return SullaSettingsModel.get('remoteProvider', 'grok');
  }

  async getCurrentModel(): Promise<string> {
    const mps = tryGetModelProviderService();
    if (mps) return mps.getActiveModelId();
    return this.getRemoteModel();
  }

  async getCurrentConfig(): Promise<any> {
    const mps = tryGetModelProviderService();
    if (mps) {
      const state = mps.getState();
      return {
        mode:           'remote',
        remoteModel:    state.activeModelId,
        remoteProvider: state.primaryProvider,
        remoteApiKey:   '',
      };
    }

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
      mode:           'remote',
      remoteModel,
      remoteProvider: remoteProviderId,
      remoteApiKey,
    };
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
        key = await SullaSettingsModel.get('remoteApiKey', '');
      }
    }

    if (!key) {
      throw new Error(`No API key configured for provider: ${ providerId }`);
    }

    return await modelDiscoveryService.fetchModelsForProvider(providerId, key);
  }

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

export const getLLMService = async(spec: string) => await LLMRegistry.getService(spec);
export const getRemoteService = async(model?: string) => await LLMRegistry.getRemoteService(model);
export const getHeartbeatLLM = async() => await LLMRegistry.getHeartbeatLLM();
export const getRemoteModel = async() => await LLMRegistry.getRemoteModel();
export const getCurrentModel = async() => await LLMRegistry.getCurrentModel();

// Primary / Secondary / Heartbeat provider exports
export const getPrimaryService = async() => await LLMRegistry.getPrimaryService();
export const getSecondaryService = async() => await LLMRegistry.getSecondaryService();
export const getHeartbeatService = async() => await LLMRegistry.getHeartbeatLLM();
export const getSubconsciousService = async() => await LLMRegistry.getSubconsciousLLM();

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
