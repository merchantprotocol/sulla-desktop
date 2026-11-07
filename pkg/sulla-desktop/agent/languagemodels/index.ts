// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.
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
import { cliTierModelId, isTierName, resolveTierToModelId, type ModelTier } from './ModelTierResolver';
import { usesContainerVaultAuthority } from '../../vault-broker';
import { SullaSettingsModel } from '../database/models/SullaSettingsModel';
import { getIntegrationService } from '../services/IntegrationService';
import { firstRunTrace } from '../../main/firstRun/firstRunTrace';
import { OPENAI_COMPATIBLE_PROVIDERS } from './openAICompatibleProviders';
import { getOpenAICompatibleProviderService } from './OpenAICompatibleProviderService';
import { ModelDispatchService, RemoteModelDispatchService } from './ModelDispatchService';
// Dedupe key for the one-line subconscious-model resolution log (verify the
// 'fast' tier actually resolves, and catch a SILENT fallback to primary). We
// log only when the resolved provider/tier/model/fallback signature changes,
// so the truth surfaces in background.log without spamming every dispatch.
let lastSubconsciousResolutionSig = '';
// Provider factory map — lazy-loaded to avoid circular imports
export const PROVIDER_FACTORIES: Record<string, () => Promise<BaseLanguageModel>> = {
  'claude-code': async() => { const { getClaudeCodeService } = await import('./ClaudeCodeService'); return getClaudeCodeService() },
  codex:         async() => { const { getCodexService } = await import('./CodexService'); return getCodexService() },
  opencode:      async() => { const { getOpenCodeService } = await import('./OpenCodeService'); return getOpenCodeService() },
  cursor:        async() => { const { getCursorAgentService } = await import('./CursorAgentService'); return getCursorAgentService() },
  arcee:         async() => { const { getArceeService } = await import('./ArceeService'); return getArceeService() },
  cohere:        async() => { const { getCohereService } = await import('./CohereService'); return getCohereService() },
  deepseek:      async() => { const { getDeepSeekService } = await import('./DeepSeekService'); return getDeepSeekService() },
  grok:          async() => { const { getGrokService } = await import('./GrokService'); return getGrokService() },
  groq:          async() => { const { getGroqService } = await import('./GroqService'); return getGroqService() },
  openai:        async() => { const { getOpenAIService } = await import('./OpenAIService'); return getOpenAIService() },
  anthropic:     async() => { const { getAnthropicService } = await import('./AnthropicService'); return getAnthropicService() },
  'vertex-ai':   async() => { const { getVertexAIService } = await import('./VertexAIService'); return getVertexAIService() },
  google:        async() => { const { getGoogleService } = await import('./GoogleService'); return getGoogleService() },
  kimi:          async() => { const { getKimiService } = await import('./KimiService'); return getKimiService() },
  nvidia:        async() => { const { getNvidiaService } = await import('./NvidiaService'); return getNvidiaService() },
  alibaba:       async() => { const { getAlibabaService } = await import('./AlibabaService'); return getAlibabaService() },
  mistral:       async() => { const { getMistralService } = await import('./MistralService'); return getMistralService() },
  cerebras:      async() => { const { getCerebasService } = await import('./CerebasService'); return getCerebasService() },
  together:      async() => { const { getTogetherService } = await import('./TogetherService'); return getTogetherService() },
  ollama:        async() => { const { getOllamaService } = await import('./OllamaService'); return getOllamaService() },
  custom:        async() => { const { getCustomService } = await import('./CustomService'); return getCustomService() },
  ...Object.fromEntries(OPENAI_COMPATIBLE_PROVIDERS.map(provider => [provider.id, () => getOpenAICompatibleProviderService(provider.id)])),
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
export class LLMRegistryImpl {
  constructor(private readonly dispatchService: () => ModelDispatchService = () => modelDispatchService) {}
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
    const service = await new RemoteModelDispatchService(this.dispatchService()).resolve(overrideModel);
    if (!service) throw new Error('No connected AI provider is available in the Agents routing list.');
    return service;
  }
  /**
   * Get service by specific provider ID (e.g., 'anthropic', 'grok').
   * When modelOverride is provided, a separate cached instance is created with
   * that model — allowing different slots (primary vs subconscious) to use the
   * same provider at different model tiers.
   */
  async getServiceByProvider(providerId: string, modelOverride?: string): Promise<BaseLanguageModel> {
    if (!providerId.trim()) {
      throw new Error('No AI model is connected yet. Connect Claude, ChatGPT, Grok or an API key to start chatting.');
    }
    const key = modelOverride ? `provider:${ providerId }:${ modelOverride }` : `provider:${ providerId }`;
    let svc = this.services.get(key);
    if (!svc) {
      if (modelOverride && providerId === 'claude-code') {
        // ClaudeCodeService is a singleton — create a fresh instance so the model
        // override doesn't bleed into the primary orchestrator's instance.
        const { createClaudeCodeService } = await import('./ClaudeCodeService');
        svc = createClaudeCodeService(modelOverride);
      } else if (modelOverride && providerId === 'codex') {
        // Same singleton concern as claude-code.
        const { createCodexService } = await import('./CodexService');
        svc = createCodexService(modelOverride);
      } else if (modelOverride && providerId === 'opencode') {
        const { createOpenCodeService } = await import('./OpenCodeService');
        svc = createOpenCodeService(modelOverride);
      } else if (modelOverride && providerId === 'cursor') {
        const { createCursorAgentService } = await import('./CursorAgentService');
        svc = createCursorAgentService(modelOverride);
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
    const routed = await this.dispatchService().resolve('agents', { mode: 'list' });
    if (!routed) throw new Error('No connected AI provider is available in the Agents routing list.');
    const selected = routed.candidates[0];
    firstRunTrace('models', 'primary service resolved', { providerId: selected.provider, modelOverride: selected.model });
    return routed.service;
  }

  /** The backup provider the owner chose, or '' when none is set. */
  async getSecondaryProviderId(): Promise<string> {
    const { modelRouter } = await import('./modelRouter');
    return (await modelRouter.resolve('agents', { mode: 'list' }))[1]?.provider || '';
  }

  /**
   * Get the secondary (fallback) LLM service.
   * Applies secondaryModelId override (supports tier names or explicit model IDs).
   */
  async getSecondaryService(): Promise<BaseLanguageModel> {
    const { modelRouter } = await import('./modelRouter');
    const routed = (await modelRouter.resolve('agents', { mode: 'list' }))[1];
    if (!routed) throw new Error('No second connected AI provider is available in the Agents routing list.');
    return this.getServiceByProvider(routed.provider, routed.model);
  }

  /**
   * Heartbeat-aware service. Runs background agents at the 'fast' tier by default.
   * heartbeatModelId can be a tier name ('fast'|'balanced'|'powerful') or an explicit
   * model ID. Tier names are resolved dynamically from the provider's live model list.
   */
  async getHeartbeatLLM(): Promise<BaseLanguageModel> {
    const routed = await this.dispatchService().resolve('subconscious', { mode: 'list' });
    if (!routed) throw new Error('No connected AI provider is available in the Subconscious routing list.');
    return routed.service;
  }

  /**
   * Subconscious-aware service. Subconscious agents (observation writer,
   * observation recall, summarizer) and spawned sub-agents run here at the
   * 'fast' tier by default — cheap, quick recon so the orchestrator doesn't
   * burn expensive tokens on file searching.
   *
   * subconsciousModelId can be a tier name ('fast'|'balanced'|'powerful') or
   * an explicit model ID. Tier names are resolved dynamically from the
   * provider's live model list.
   *
   * Resolution order:
   *   1. Explicit subconsciousProvider setting (if not 'default')
   *   2. Primary provider (default)
   */
  async getSubconsciousLLM(): Promise<BaseLanguageModel> {
    const routed = await this.dispatchService().resolve('subconscious', { mode: 'list' });
    if (!routed) throw new Error('No connected AI provider is available in the Subconscious routing list.');
    const selected = routed.candidates[0];
    const service = routed.service;
    const sig = `${ selected.provider }|${ selected.model }`;
    if (sig !== lastSubconsciousResolutionSig) {
      lastSubconsciousResolutionSig = sig;
      console.log(`[SubconsciousLLM] provider=${ selected.provider } effectiveModel=${ selected.model }`);
    }
    return service;
  }

  /**
   * Agent definitions store a Preferences slot, not a provider or model ID.
   * Resolve that slot through the user's existing model settings at run time.
   * Legacy provider/model declarations remain readable for old packages.
   *
   * Returns null when the agent declares no override — callers fall back to
   * the role slots (primary / subconscious). Resolution failures also return
   * null rather than throwing so a bad agent config degrades to slot routing.
   */
  async getAgentOverrideService(agentCfg?: { model?: string; provider?: string }): Promise<BaseLanguageModel | null> {
    const model = typeof agentCfg?.model === 'string' ? agentCfg.model.trim() : '';
    const provider = typeof agentCfg?.provider === 'string' ? agentCfg.provider.trim() : '';

    if (model === 'primary') return this.getPrimaryService();
    if (model === 'secondary') return this.getSecondaryService();
    if (model === 'subconscious') return this.getSubconsciousLLM();

    if (!model && !provider) return null;

    try {
      const mps = tryGetModelProviderService();
      const effectiveProvider = provider || (mps
        ? mps.getPrimaryProvider()
        : await SullaSettingsModel.get('primaryProvider', ''));

      const modelOverride = model
        ? (isTierName(model)
          ? (await resolveTierToModelId(effectiveProvider, model)) ?? cliTierModelId(effectiveProvider, model)
          : model)
        : undefined;

      return await this.getServiceByProvider(effectiveProvider, modelOverride);
    } catch (err) {
      console.warn(`[LLMRegistry] Agent model override failed (provider="${ provider }", model="${ model }") — falling back to slot routing:`, err);
      return null;
    }
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

    return SullaSettingsModel.get('remoteProvider', '');
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
    if (usesContainerVaultAuthority() && !['ollama', 'lm-studio', 'local-server'].includes(providerId)) {
      return modelDiscoveryService.fetchModelsForProvider(providerId);
    }
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

export const modelDispatchService = new ModelDispatchService(
  async(target, choice) => {
    const { modelRouter } = await import('./modelRouter');
    return modelRouter.resolve(target, choice);
  },
  (provider, model) => LLMRegistry.getServiceByProvider(provider, model),
);


export const getLLMService = async(spec: string) => await LLMRegistry.getService(spec);
export const getRemoteService = async(model?: string) => await LLMRegistry.getRemoteService(model);
export const getHeartbeatLLM = async() => await LLMRegistry.getHeartbeatLLM();
export const getRemoteModel = async() => await LLMRegistry.getRemoteModel();
export const getCurrentModel = async() => await LLMRegistry.getCurrentModel();

// Primary / Secondary / Heartbeat provider exports
export const getPrimaryService = async() => await LLMRegistry.getPrimaryService();
export const getSecondaryService = async() => await LLMRegistry.getSecondaryService();
export const getSecondaryProviderId = async() => await LLMRegistry.getSecondaryProviderId();
export const getAgentOverrideService = async(agentCfg?: { model?: string; provider?: string; modelChoice?: import('./modelRoutingTypes').AgentModelChoice }) => {
  if (agentCfg?.modelChoice) {
    return (await modelDispatchService.resolve('agents', agentCfg.modelChoice))?.service ?? null;
  }
  return LLMRegistry.getAgentOverrideService(agentCfg);
};
export const getServiceByProvider = async(provider: string, model?: string) => LLMRegistry.getServiceByProvider(provider, model);
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
