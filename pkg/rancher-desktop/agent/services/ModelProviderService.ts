/**
 * ModelProviderService — Single source of truth for LLM provider / model selection.
 *
 * Lives in the main process only. Owns:
 * - Active provider + model state (in-memory after init, persisted to DB)
 * - All DB reads/writes for provider/model config (SullaSettingsModel + IntegrationService)
 * - IPC handlers for renderer queries and mutations
 * - Broadcasting state changes to all BrowserWindows
 * - Notifying in-process listeners (LLMRegistry) on change
 * - llama-server lifecycle (start/stop on local ↔ remote transitions)
 *
 * Renderers are thin IPC clients — they never read/write provider settings directly.
 */

import { SullaSettingsModel } from '../database/models/SullaSettingsModel';
import { getIntegrationService } from './IntegrationService';
import { integrations } from '../integrations/catalog';
import { LOCAL_MODELS } from '../../shared/localModels';

// ── Public types ─────────────────────────────────────────────────

export interface ModelProviderState {
  primaryProvider:   string;
  secondaryProvider: string;
  heartbeatProvider: string;
  activeModelId:     string;
  /** Derived: 'local' when primaryProvider === 'ollama', else 'remote' */
  modelMode:         'local' | 'remote';
}

export interface ProviderInfo {
  id:        string;
  name:      string;
  connected: boolean;
}

export interface ProviderModelInfo {
  id:           string;
  name:         string;
  description?: string;
}

// ── Excluded from the model selector dropdown ────────────────────
const EXCLUDED_PROVIDER_IDS = ['activepieces', 'composio', 'mcp', 'enterprise-gateway'];

// ── Service ──────────────────────────────────────────────────────

type ChangeListener = (state: ModelProviderState) => void;

class ModelProviderService {
  private state: ModelProviderState = {
    primaryProvider:   'ollama',
    secondaryProvider: 'ollama',
    heartbeatProvider: 'default',
    activeModelId:     '',
    modelMode:         'local',
  };

  private initialized = false;
  private changeListeners: ChangeListener[] = [];

  // ── Lifecycle ──────────────────────────────────────────────────

  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Load persisted state (requires DB to be ready — caller must ensure this)
    await this.loadStateFromDB();

    // Register IPC handlers
    this.registerIpcHandlers();

    this.initialized = true;
    console.log('[ModelProviderService] Initialized:', JSON.stringify(this.state));

    // Broadcast to any windows that opened before the service was ready,
    // so they pick up the correct DB-backed state instead of stale fallback data.
    await this.broadcastChange();
  }

  // ── Getters (synchronous — read from in-memory state) ──────────

  getState(): ModelProviderState {
    return { ...this.state };
  }

  getPrimaryProvider(): string {
    return this.state.primaryProvider;
  }

  getActiveModelId(): string {
    return this.state.activeModelId;
  }

  getModelMode(): 'local' | 'remote' {
    return this.state.modelMode;
  }

  getSecondaryProvider(): string {
    return this.state.secondaryProvider;
  }

  getHeartbeatProvider(): string {
    return this.state.heartbeatProvider;
  }

  // ── Queries (async — may hit IntegrationService / DB) ──────────

  async getAvailableProviders(): Promise<ProviderInfo[]> {
    const providers: ProviderInfo[] = [];

    // Local models group
    providers.push({ id: 'ollama', name: 'Local Models', connected: true });

    // Remote providers from connected integrations
    const integrationService = getIntegrationService();

    for (const integration of Object.values(integrations)) {
      if (integration.category !== 'AI Infrastructure') continue;
      if (EXCLUDED_PROVIDER_IDS.includes(integration.id)) continue;
      if (integration.id === 'ollama') continue; // already added as "Local Models"

      let connected = false;
      try {
        connected = await integrationService.isAnyAccountConnected(integration.id);
      } catch { /* not ready */ }

      if (connected) {
        providers.push({ id: integration.id, name: integration.name, connected });
      }
    }

    return providers;
  }

  async getModelsForProvider(providerId: string): Promise<ProviderModelInfo[]> {
    // Local GGUF models
    if (providerId === 'ollama') {
      return LOCAL_MODELS.map(m => ({
        id:          m.name,
        name:        `${ m.displayName } (${ m.size })`,
        description: m.description,
      }));
    }

    // Remote provider — fetch via selectBoxId
    const integration = integrations[providerId];
    if (!integration) return [];

    const modelProp = integration.properties?.find(p => p.key === 'model');
    if (!modelProp?.selectBoxId) return [];

    try {
      const integrationService = getIntegrationService();
      const accountId = await integrationService.getActiveAccountId(providerId);
      const formVals = await integrationService.getFormValues(providerId, accountId);
      const formMap: Record<string, string> = {};
      for (const v of formVals) formMap[v.property] = v.value;

      const options = await integrationService.getSelectOptions(
        modelProp.selectBoxId, providerId, accountId, formMap,
      );

      return options.map(opt => ({ id: opt.value, name: opt.label }));
    } catch (err) {
      console.warn(`[ModelProviderService] Failed to fetch models for ${ providerId }:`, err);
      return [];
    }
  }

  async getProviderConfig(providerId: string): Promise<Record<string, string>> {
    try {
      const integrationService = getIntegrationService();
      const values = await integrationService.getFormValues(providerId);
      const config: Record<string, string> = {};
      for (const v of values) config[v.property] = v.value;
      return config;
    } catch {
      return {};
    }
  }

  // ── Mutations (the ONLY way state changes) ─────────────────────

  async selectModel(providerId: string, modelId: string): Promise<ModelProviderState> {
    const oldMode = this.state.modelMode;

    // Update in-memory state
    this.state.primaryProvider = providerId;
    this.state.activeModelId = modelId;
    this.state.modelMode = providerId === 'ollama' ? 'local' : 'remote';

    // Persist to DB
    await this.persistState(providerId, modelId);

    // Notify everyone immediately — don't block on llama-server
    await this.broadcastChange();

    // Manage llama-server lifecycle in the background (fire-and-forget)
    this.manageLlamaServer(oldMode, this.state.modelMode, modelId).catch((err) => {
      console.error('[ModelProviderService] Background llama-server management failed:', err);
    });

    return this.getState();
  }

  async setSecondaryProvider(providerId: string): Promise<void> {
    this.state.secondaryProvider = providerId;
    await SullaSettingsModel.set('secondaryProvider', providerId, 'string');
    await this.broadcastChange();
  }

  async setHeartbeatProvider(providerId: string): Promise<void> {
    this.state.heartbeatProvider = providerId;
    await SullaSettingsModel.set('heartbeatProvider', providerId, 'string');
    await this.broadcastChange();
  }

  async updateProviderConfig(providerId: string, config: Record<string, string>): Promise<void> {
    const integrationService = getIntegrationService();
    const accountId = await integrationService.getActiveAccountId(providerId);

    for (const [property, value] of Object.entries(config)) {
      await integrationService.setIntegrationValue({
        integration_id: providerId,
        account_id:     accountId,
        property,
        value,
      });
    }
  }

  // ── Event subscription (main-process only, for LLMRegistry) ────

  onChange(listener: ChangeListener): () => void {
    this.changeListeners.push(listener);
    return () => {
      this.changeListeners = this.changeListeners.filter(l => l !== listener);
    };
  }

  // ── Internal ───────────────────────────────────────────────────

  private async loadStateFromDB(): Promise<void> {
    this.state.primaryProvider = await SullaSettingsModel.get('primaryProvider', 'ollama');
    this.state.secondaryProvider = await SullaSettingsModel.get('secondaryProvider', 'ollama');
    this.state.heartbeatProvider = await SullaSettingsModel.get('heartbeatProvider', 'default');
    this.state.modelMode = this.state.primaryProvider === 'ollama' ? 'local' : 'remote';

    // Load active model from the provider's integration form values
    try {
      const integrationService = getIntegrationService();
      const formValues = await integrationService.getFormValues(this.state.primaryProvider);
      const modelVal = formValues.find(v => v.property === 'model');
      this.state.activeModelId = modelVal?.value || '';
    } catch {
      // Fallback to legacy settings
      if (this.state.primaryProvider === 'ollama') {
        this.state.activeModelId = await SullaSettingsModel.get('sullaModel', '');
      } else {
        this.state.activeModelId = await SullaSettingsModel.get('remoteModel', '');
      }
    }
  }

  private async persistState(providerId: string, modelId: string): Promise<void> {
    await SullaSettingsModel.set('primaryProvider', providerId, 'string');
    await SullaSettingsModel.set('modelMode', this.state.modelMode, 'string');

    // Write model into the provider's integration form values
    try {
      const integrationService = getIntegrationService();
      const accountId = await integrationService.getActiveAccountId(providerId);
      await integrationService.setIntegrationValue({
        integration_id: providerId,
        account_id:     accountId,
        property:       'model',
        value:          modelId,
      });
    } catch (err) {
      console.warn('[ModelProviderService] Failed to write model to IntegrationService:', err);
    }

    // Legacy settings sync
    if (providerId === 'ollama') {
      await SullaSettingsModel.set('sullaModel', modelId, 'string');
    } else {
      await SullaSettingsModel.set('remoteProvider', providerId, 'string');
      await SullaSettingsModel.set('remoteModel', modelId, 'string');
    }
  }

  private async broadcastChange(): Promise<void> {
    const state = this.getState();

    // Legacy payload for backward compat
    const legacyPayload = state.modelMode === 'local'
      ? { model: state.activeModelId, type: 'local' as const }
      : { model: state.activeModelId, type: 'remote' as const, provider: state.primaryProvider };

    // Notify all BrowserWindows
    try {
      const { BrowserWindow } = require('electron') as typeof import('electron');
      for (const win of BrowserWindow.getAllWindows()) {
        try {
          win.webContents.send('model-provider:state-changed', state);
          win.webContents.send('model-changed', legacyPayload);
        } catch { /* window may be closing */ }
      }
    } catch (err) {
      console.warn('[ModelProviderService] Failed to broadcast to windows:', err);
    }

    // Notify in-process listeners (LLMRegistry, etc.)
    for (const listener of this.changeListeners) {
      try {
        listener(state);
      } catch (err) {
        console.error('[ModelProviderService] Listener error:', err);
      }
    }
  }

  private async manageLlamaServer(
    oldMode: 'local' | 'remote',
    newMode: 'local' | 'remote',
    modelId: string,
  ): Promise<void> {
    if (oldMode === newMode && newMode === 'remote') return;

    // Respect the explicit localServerEnabled preference
    const localServerEnabled = await SullaSettingsModel.get('localServerEnabled', '');
    if (localServerEnabled === 'false') {
      console.log('[ModelProviderService] localServerEnabled=false — skipping llama-server management');
      return;
    }

    try {
      const { getLlamaCppService, GGUF_MODELS } = await import('./LlamaCppService');
      const llamaCpp = getLlamaCppService();

      if (newMode === 'remote') {
        console.log('[ModelProviderService] Switching to remote — stopping llama-server');
        try { await llamaCpp.stopServer(); } catch { /* not running */ }
      } else if (newMode === 'local') {
        let modelKey = modelId || await SullaSettingsModel.get('sullaModel', 'qwen3.5-9b');
        if (!(modelKey in GGUF_MODELS)) {
          const mapped = modelKey.replace(/:/g, '-');
          modelKey = (mapped in GGUF_MODELS) ? mapped : 'qwen3.5-9b';
        }
        // Always (re)start with the selected model — startServer handles
        // stopping any currently running server automatically.
        console.log(`[ModelProviderService] Starting llama-server with model ${ modelKey }`);
        const modelPath = await llamaCpp.downloadModel(modelKey);
        await llamaCpp.startServer(modelPath);
        console.log(`[ModelProviderService] llama-server started at ${ llamaCpp.serverBaseUrl }`);
      }
    } catch (err) {
      console.error('[ModelProviderService] Failed to manage llama-server:', err);
    }
  }

  private registerIpcHandlers(): void {
    const { ipcMain } = require('electron') as typeof import('electron');

    ipcMain.handle('model-provider:get-state', () => {
      return this.getState();
    });

    ipcMain.handle('model-provider:get-providers', async() => {
      return this.getAvailableProviders();
    });

    ipcMain.handle('model-provider:get-models', async(_event: unknown, providerId: string) => {
      return this.getModelsForProvider(providerId);
    });

    ipcMain.handle('model-provider:select-model', async(_event: unknown, providerId: string, modelId: string) => {
      return this.selectModel(providerId, modelId);
    });

    ipcMain.handle('model-provider:set-secondary', async(_event: unknown, providerId: string) => {
      return this.setSecondaryProvider(providerId);
    });

    ipcMain.handle('model-provider:set-heartbeat', async(_event: unknown, providerId: string) => {
      return this.setHeartbeatProvider(providerId);
    });

    ipcMain.handle('model-provider:get-provider-config', async(_event: unknown, providerId: string) => {
      return this.getProviderConfig(providerId);
    });

    ipcMain.handle('model-provider:update-provider-config', async(_event: unknown, providerId: string, config: Record<string, string>) => {
      return this.updateProviderConfig(providerId, config);
    });
  }
}

// ── Singleton ────────────────────────────────────────────────────

let instance: ModelProviderService | null = null;

export function getModelProviderService(): ModelProviderService {
  if (!instance) {
    instance = new ModelProviderService();
  }
  return instance;
}
