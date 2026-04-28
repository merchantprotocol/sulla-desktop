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

import { getIntegrationService } from './IntegrationService';
import { SullaSettingsModel } from '../database/models/SullaSettingsModel';
import { integrations } from '../integrations/catalog';

// ── Public types ─────────────────────────────────────────────────

export interface ModelProviderState {
  primaryProvider:     string;
  secondaryProvider:   string;
  heartbeatProvider:   string;
  /**
   * Provider used by subconscious agents (memory-recall, observation,
   * unstuck-research). Defaults to 'default', which means "fall back to the
   * secondary provider". This keeps Claude Code — which runs its own
   * autonomous tool loop and is ill-suited for quick recall tasks — off
   * the subconscious path unless the user explicitly opts in.
   */
  subconsciousProvider: string;
  activeModelId:       string;
  modelMode:           'remote';
  /** Model ID override for heartbeat agent. '' = use provider's integration config. */
  heartbeatModelId:    string;
  /** Model ID override for subconscious agents and spawned sub-agents. '' = use provider's integration config. */
  subconsciousModelId: string;
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
    primaryProvider:      'grok',
    secondaryProvider:    'grok',
    heartbeatProvider:    'default',
    subconsciousProvider: 'default',
    activeModelId:        '',
    modelMode:            'remote',
    heartbeatModelId:     'claude-haiku-4-5-20251001',
    subconsciousModelId:  'claude-haiku-4-5-20251001',
  };

  private initialized = false;
  private ipcRegistered = false;
  private changeListeners: ChangeListener[] = [];

  // ── Lifecycle ──────────────────────────────────────────────────

  /**
   * Register IPC handlers. Safe to call before the database is ready —
   * handlers respond from in-memory defaults and catch DB errors internally.
   * Idempotent; safe to call multiple times.
   */
  registerIpc(): void {
    if (this.ipcRegistered) return;
    this.registerIpcHandlers();
    this.ipcRegistered = true;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Ensure IPC handlers are registered. This is idempotent — if they were
    // already registered early (before DB was ready), this is a no-op.
    this.registerIpc();

    // Load persisted state. If this throws, the service still responds to
    // IPC with sensible defaults from the initial state object.
    try {
      await this.loadStateFromDB();
    } catch (err) {
      console.warn('[ModelProviderService] loadStateFromDB failed — using defaults:', err);
    }

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

  getModelMode(): 'remote' {
    return 'remote';
  }

  getSecondaryProvider(): string {
    return this.state.secondaryProvider;
  }

  getHeartbeatProvider(): string {
    return this.state.heartbeatProvider;
  }

  getSubconsciousProvider(): string {
    return this.state.subconsciousProvider;
  }

  getHeartbeatModelId(): string {
    return this.state.heartbeatModelId;
  }

  getSubconsciousModelId(): string {
    return this.state.subconsciousModelId;
  }

  // ── Queries (async — may hit IntegrationService / DB) ──────────

  async getAvailableProviders(): Promise<ProviderInfo[]> {
    const providers: ProviderInfo[] = [];

    // All AI Infrastructure integrations — marked with connected state.
    // UI decides whether to gate on connection or prompt the user to connect.
    const integrationService = getIntegrationService();

    const allIntegrations = Object.values(integrations);
    console.log(`[ModelProviderService] getAvailableProviders: ${ allIntegrations.length } total integrations loaded`);

    for (const integration of allIntegrations) {
      if (integration.category !== 'AI Infrastructure') continue;
      if (EXCLUDED_PROVIDER_IDS.includes(integration.id)) continue;

      let connected = false;
      if (integration.id === 'claude-code') {
        // Claude Code is "connected" if the user has either credential type stored
        try {
          const oauth = await SullaSettingsModel.get('claudeOAuthToken', '');
          const apiKey = await SullaSettingsModel.get('claudeApiKey', '');
          connected = !!(oauth || apiKey);
        } catch { /* DB not ready */ }
      } else {
        try {
          connected = await integrationService.isAnyAccountConnected(integration.id);
        } catch { /* not ready */ }
      }

      providers.push({ id: integration.id, name: integration.name, connected });
    }

    console.log(`[ModelProviderService] getAvailableProviders: returning ${ providers.length } providers`);

    return providers;
  }

  async getModelsForProvider(providerId: string): Promise<ProviderModelInfo[]> {
    // Claude Code picks its own model internally; return a single synthetic entry.
    if (providerId === 'claude-code') {
      return [{ id: 'claude-code', name: 'Claude Code (auto)', description: 'Claude-selected model, runs in sandboxed VM' }];
    }

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
    this.state.modelMode = 'remote';

    // Persist to DB
    await this.persistState(providerId, modelId);

    // Notify everyone
    await this.broadcastChange();

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

  async setSubconsciousProvider(providerId: string): Promise<void> {
    this.state.subconsciousProvider = providerId;
    await SullaSettingsModel.set('subconsciousProvider', providerId, 'string');
    await this.broadcastChange();
  }

  async setHeartbeatModelId(modelId: string): Promise<void> {
    this.state.heartbeatModelId = modelId;
    await SullaSettingsModel.set('heartbeatModelId', modelId, 'string');
    await this.broadcastChange();
  }

  async setSubconsciousModelId(modelId: string): Promise<void> {
    this.state.subconsciousModelId = modelId;
    await SullaSettingsModel.set('subconsciousModelId', modelId, 'string');
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
    this.state.primaryProvider = await SullaSettingsModel.get('primaryProvider', 'grok');
    this.state.secondaryProvider = await SullaSettingsModel.get('secondaryProvider', 'grok');
    this.state.heartbeatProvider = await SullaSettingsModel.get('heartbeatProvider', 'default');
    this.state.subconsciousProvider = await SullaSettingsModel.get('subconsciousProvider', 'default');
    this.state.heartbeatModelId = await SullaSettingsModel.get('heartbeatModelId', 'claude-haiku-4-5-20251001');
    this.state.subconsciousModelId = await SullaSettingsModel.get('subconsciousModelId', 'claude-haiku-4-5-20251001');
    this.state.modelMode = 'remote';

    // One-time migration: upgrade installs that were initialized with the old Sonnet default.
    // Only fires once (tracked by version flag) so user changes after this point are preserved.
    const migrated = await SullaSettingsModel.get('modelDefaultsMigration', '');
    if (migrated < 'v2') {
      if (this.state.heartbeatModelId === 'claude-sonnet-4-6') {
        this.state.heartbeatModelId = 'claude-haiku-4-5-20251001';
        await SullaSettingsModel.set('heartbeatModelId', 'claude-haiku-4-5-20251001', 'string');
      }
      if (this.state.subconsciousModelId === 'claude-sonnet-4-6') {
        this.state.subconsciousModelId = 'claude-haiku-4-5-20251001';
        await SullaSettingsModel.set('subconsciousModelId', 'claude-haiku-4-5-20251001', 'string');
      }
      await SullaSettingsModel.set('modelDefaultsMigration', 'v2', 'string');
    }

    // Load active model from the provider's integration form values
    try {
      const integrationService = getIntegrationService();
      const formValues = await integrationService.getFormValues(this.state.primaryProvider);
      const modelVal = formValues.find(v => v.property === 'model');
      this.state.activeModelId = modelVal?.value || '';
    } catch {
      this.state.activeModelId = await SullaSettingsModel.get('remoteModel', '');
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
    await SullaSettingsModel.set('remoteProvider', providerId, 'string');
    await SullaSettingsModel.set('remoteModel', modelId, 'string');
  }

  private async broadcastChange(): Promise<void> {
    const state = this.getState();

    const legacyPayload = { model: state.activeModelId, type: 'remote' as const, provider: state.primaryProvider };

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

    ipcMain.handle('model-provider:set-subconscious', async(_event: unknown, providerId: string) => {
      return this.setSubconsciousProvider(providerId);
    });

    ipcMain.handle('model-provider:set-heartbeat-model', async(_event: unknown, modelId: string) => {
      return this.setHeartbeatModelId(modelId);
    });

    ipcMain.handle('model-provider:set-subconscious-model', async(_event: unknown, modelId: string) => {
      return this.setSubconsciousModelId(modelId);
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
