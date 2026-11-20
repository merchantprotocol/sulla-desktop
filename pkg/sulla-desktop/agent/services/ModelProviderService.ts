// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * ModelProviderService — Single source of truth for LLM provider / model selection.
 *
 * Lives in the main process only. Owns:
 * - Active provider + model state (in-memory after init, persisted to DB)
 * - All DB reads/writes for provider/model config (SullaSettingsModel + IntegrationService)
 * - IPC handlers for renderer queries and mutations
 * - Broadcasting state changes to all BrowserWindows
 * - Notifying in-process listeners (LLMRegistry) on change
 *
 * Renderers are thin IPC clients — they never read/write provider settings directly.
 */

import { getIntegrationService } from './IntegrationService';
import { SullaSettingsModel } from '../database/models/SullaSettingsModel';
import { integrations } from '../integrations/catalog';
import { getSelectBoxProvider } from '../integrations/select_box';
import { getCliStatus } from '../tools/models/shared';

import { hasPendingCredential } from '@pkg/main/firstRun/pendingCredentials';
import { firstRunTrace } from '@pkg/utils/firstRunTraceSink';
import { getServiceLifecycleManager } from './ServiceLifecycleManager';
import { resolveProviderAccess, type ProviderAccessMethod } from '@pkg/shared/providerAccess';

// IDs curated in Sulla Cloud's public shared catalog. Unknown/custom/local
// providers must never trigger a catalog download simply to list their models.
const SHARED_CATALOG_PROVIDER_IDS = new Set(['anthropic', 'openai', 'google', 'xai', 'deepseek', 'moonshot', 'alibaba', 'meta', 'minimax', 'workers-ai']);

// ── Public types ─────────────────────────────────────────────────

export interface ModelProviderState {
  primaryProvider:     string;
  secondaryProvider:   string;
  heartbeatProvider:   string;
  /**
   * Provider used by subconscious agents (observation writer/recall,
   * summarizer). Defaults to 'default', which means "fall back to the
   * secondary provider". Any provider including 'claude-code' is valid here —
   * setting it to 'claude-code' runs a full autonomous Claude Code subprocess
   * for each subconscious turn.
   */
  subconsciousProvider: string;
  activeModelId:       string;
  modelMode:           'remote';
  /** Model ID override for secondary/fallback LLM. '' = use provider's integration config. */
  secondaryModelId:    string;
  /** Model ID override for heartbeat agent. '' = use provider's integration config. */
  heartbeatModelId:    string;
  /** Model ID override for subconscious agents and spawned sub-agents. '' = use provider's integration config. */
  subconsciousModelId: string;
}

export interface ProviderInfo {
  id:        string;
  name:      string;
  connected: boolean;
  connectionStatus?: 'unknown';
  accessMethod?: ProviderAccessMethod;
  accessLabel?:  string;
  selectable?:   boolean;
}

export type ModelSelectionMode = import('@pkg/shared/providerAccess').ModelSelectionMode;

export interface ProviderModelInfo {
  id:             string;
  name:           string;
  description?:   string;
  /** Effort levels the model accepts, as its CLI reports them. */
  efforts?:       { id: string; description?: string }[];
  defaultEffort?: string;
  /** The model the provider recommends moving to, when it names one. */
  upgrade?:       string;
  /** True when the entry comes from a fixed list, not from the provider. */
  unverified?:    boolean;
  /** Automatic provider/CLI selection versus an exact provider model id. */
  selectionMode?: ModelSelectionMode;
}

// ── Excluded from the model selector dropdown ────────────────────
const EXCLUDED_PROVIDER_IDS = ['activepieces', 'composio', 'mcp', 'enterprise_gateway'];

// ── Service ──────────────────────────────────────────────────────

type ChangeListener = (state: ModelProviderState) => void;

class ModelProviderService {
  private state: ModelProviderState = {
    primaryProvider:      '',
    secondaryProvider:    '',
    heartbeatProvider:    'default',
    subconsciousProvider: 'claude-code',
    activeModelId:        '',
    modelMode:            'remote',
    secondaryModelId:     '',
    heartbeatModelId:     'fast',
    subconsciousModelId:  'fast',
  };

  private initialized = false;
  private ipcRegistered = false;
  private changeListeners: ChangeListener[] = [];
  private vaultListenerRegistered = false;

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
      await this.reconcilePrimaryProvider();
    } catch (err) {
      console.warn('[ModelProviderService] loadStateFromDB failed — using defaults:', err);
      // Defaults remain available to settings IPC, but execution must wait for
      // a successful lifecycle retry to load the user's actual configuration.
      throw err;
    }

    this.initialized = true;
    if (!this.vaultListenerRegistered) {
      this.vaultListenerRegistered = true;
      getServiceLifecycleManager().on('vault:state', (unlocked: boolean) => {
        if (unlocked) void this.reconcilePrimaryProvider();
      });
    }
    console.log('[ModelProviderService] Initialized:', JSON.stringify(this.state));

    // Broadcast to any windows that opened before the service was ready,
    // so they pick up the correct DB-backed state instead of stale fallback data.
    await this.broadcastChange();
  }

  // ── Getters (synchronous — read from in-memory state) ──────────

  getState(): ModelProviderState {
    return { ...this.state };
  }

  /** True once the saved model choice has been loaded. */
  isInitialized(): boolean {
    return this.initialized;
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

  getSecondaryModelId(): string {
    return this.state.secondaryModelId;
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

  /**
   * The account the runtime will actually use. `unknown` is reserved for a
   * real metadata fault (locked/unavailable vault, failed active-account
   * read); a missing or disconnected selected account is a known, unrunnable
   * state and never borrows another account.
   */
  private async selectedAccount(providerId: string): Promise<{ account?: { accountId: string; connected: boolean }; unknown: boolean }> {
    const integrationService = getIntegrationService();
    try {
      const accounts = await integrationService.getAccounts(providerId, { strict: true });
      if (!accounts.length) return { unknown: false };
      let activeAccountId = '';
      try {
        activeAccountId = await integrationService.getActiveAccountId(providerId);
      } catch {
        return { unknown: true };
      }
      // GrokService.create runs on a connected 'oauth' account whenever one
      // exists, even if an API account is selected. Label that actual lane.
      const grokOAuth = providerId === 'grok' ? accounts.find(candidate => candidate.account_id === 'oauth' && candidate.connected) : undefined;
      const account = grokOAuth
        ?? accounts.find(candidate => candidate.account_id === activeAccountId)
        ?? (activeAccountId ? undefined : accounts.find(candidate => candidate.active));
      return account
        ? { account: { accountId: account.account_id, connected: account.connected }, unknown: false }
        : { account: { accountId: activeAccountId, connected: false }, unknown: false };
    } catch {
      // A missing or locked vault is unknown, not permission to choose another
      // account whose billing lane may differ from the selected one.
      return { unknown: true };
    }
  }

  private modelInfo(providerId: string, model: { id: string; name: string; description?: string; efforts?: { id: string; description?: string }[]; defaultEffort?: string; upgrade?: string; unverified?: boolean }): ProviderModelInfo {
    const automatic = model.id === providerId && /^auto\b/i.test(model.name.trim());
    // parseClaudeCliModels marks a CLI family alias (its id differs from the
    // CLI's resolvedModel) with this suffix; the CLI picks the version.
    const alias = providerId === 'claude-code' && / \(CLI alias\)$/.test(model.name);
    return { ...model, selectionMode: automatic ? 'automatic' : alias ? 'alias' : 'exact' };
  }

  async getAvailableProviders(): Promise<ProviderInfo[]> {
    const providers: ProviderInfo[] = [];

    const allIntegrations = Object.values(integrations);
    console.log(`[ModelProviderService] getAvailableProviders: ${ allIntegrations.length } total integrations loaded`);

    const candidates = allIntegrations.filter(i => i.category === 'AI Infrastructure' && !EXCLUDED_PROVIDER_IDS.includes(i.id));
    // Vault-metadata lookups run in parallel so opening the window is fast.
    const results = await Promise.allSettled(candidates.map(async(integration) => {
      const selected = await this.selectedAccount(integration.id);
      // Custom discovery has no provider-owned default endpoint. A saved key
      // without a base URL cannot be called, so do not advertise it as connected.
      if (integration.id === 'custom' && selected.account?.connected) {
        try {
          const values = await getIntegrationService().getFormValues('custom', selected.account.accountId);
          const endpointConfigured = values.some(value => value.property === 'base_url' && typeof value.value === 'string' && value.value.trim().length > 0);
          if (!endpointConfigured) {
            return { id: integration.id, name: integration.name, connected: false, accessMethod: 'unknown', accessLabel: 'No endpoint configured', selectable: false } as ProviderInfo;
          }
        } catch {
          return { id: integration.id, name: integration.name, connected: false, accessMethod: 'unknown', accessLabel: 'Connection unavailable', selectable: false } as ProviderInfo;
        }
      }
      let cliInstalled = false;
      // OpenCode and Cursor own credentials in their CLIs. A runnable CLI is
      // enough to show the provider; spawn-time errors give the exact login step.
      if (!selected.unknown && !selected.account && (integration.id === 'opencode' || integration.id === 'cursor')) {
        try {
          cliInstalled = (await getCliStatus(integration.id)).installed;
        } catch (err) {
          console.warn(`[ModelProviderService] CLI status check failed for ${ integration.id }: ${ err instanceof Error ? err.message : String(err) }`);
        }
      }

      const access = resolveProviderAccess(integration.id, {
        account: selected.account,
        cliInstalled,
        integrationAuthType: integration.authType,
        supportsOAuth: integration.oauth === true,
        hasApiKeyProperty: integration.properties?.some(property => property.key === 'api_key') === true,
      });
      const pendingUnknown = !selected.account && !cliInstalled && hasPendingCredential(integration.id);
      // Only a real lookup fault, a not-yet-stored first-run credential, or a
      // connected account whose lane cannot be classified is "unknown". A
      // missing or disconnected selected account is known and not runnable.
      const connectionStatus: 'unknown' | undefined = selected.unknown || pendingUnknown || (selected.account?.connected === true && access.method === 'unknown') ? 'unknown' : undefined;
      const connected = access.selectable && !connectionStatus;
      return {
        id: integration.id,
        name: integration.name,
        connected,
        accessMethod: access.method,
        accessLabel: access.label,
        selectable: connected,
        ...(connectionStatus ? { connectionStatus } : {}),
      } as ProviderInfo;
    }));
    results.forEach((r, i) => {
      providers.push(r.status === 'fulfilled'
        ? r.value
        : { id: candidates[i].id, name: candidates[i].name, connected: false, accessMethod: 'unknown', accessLabel: 'Connection unavailable', selectable: false, connectionStatus: 'unknown' });
    });

    console.log(`[ModelProviderService] getAvailableProviders: returning ${ providers.length } providers`);

    return providers;
  }

  async getModelsForProvider(providerId: string, queryOptions: { liveOnly?: boolean; forceRefresh?: boolean } = {}): Promise<ProviderModelInfo[]> {
    // Catalog metadata is public Cloud data, not proof of an account/API-key
    // entitlement. Availability/auth checks remain in the provider access path.
    // CLI providers retain their CLI-specific catalogs and compatibility rules.
    if (SHARED_CATALOG_PROVIDER_IDS.has(providerId)) {
      const { sharedModelCatalog } = await import('../languagemodels/sharedModelCatalog');
      const provider = (await sharedModelCatalog.listProviders()).find(item => item.id === providerId)
        ?? sharedModelCatalog.getBundledProvider(providerId);
      if (provider) return provider.models.map(model => this.modelInfo(providerId, { id: model.id, name: model.name }));
      // A Cloud-listed provider missing from a stale/partial response must not
      // silently fall back to account-specific discovery. Bundled fallback
      // rows are returned by the catalog client; otherwise fail closed.
      return [];
    }
    const integration = integrations[providerId];
    if (!integration) {
      return this.getCliProviderModels(providerId, queryOptions);
    }

    const modelProp = integration.properties?.find(p => p.key === 'model');
    if (!modelProp?.selectBoxId) {
      return this.getCliProviderModels(providerId, queryOptions);
    }

    try {
      const integrationService = getIntegrationService();
      const accountId = await integrationService.getActiveAccountId(providerId).catch(() => '');
      const formVals = await integrationService.getFormValues(providerId, accountId);
      const formMap: Record<string, string> = {};
      for (const v of formVals) formMap[v.property] = v.value;

      if (queryOptions.liveOnly && providerId !== 'grok') {
        const { modelDiscoveryService } = await import('../languagemodels/ModelDiscoveryService');
        if (modelDiscoveryService.supportsProvider(providerId)) {
          const models = await modelDiscoveryService.fetchModelsForProvider(providerId, '', {
            accountId,
            baseUrl: formMap.base_url,
            region: formMap.region,
            liveOnly: true,
          });
          return models.map(model => this.modelInfo(providerId, { id: model.id, name: model.name, description: model.description }));
        }
      }

      const selectBoxProvider = getSelectBoxProvider(modelProp.selectBoxId);
      const options = selectBoxProvider
        ? await selectBoxProvider.getOptions({ integrationId: providerId, accountId, formValues: formMap, liveOnly: true })
        : await integrationService.getSelectOptions(modelProp.selectBoxId, providerId, accountId, formMap);

      return options.map(opt => this.modelInfo(providerId, { id: opt.value, name: opt.label, description: opt.description }));
    } catch (err) {
      console.warn(`[ModelProviderService] Failed to fetch models for ${ providerId }:`, err);
      return [];
    }
  }

  private async getCliProviderModels(providerId: string, queryOptions: { forceRefresh?: boolean } = {}): Promise<ProviderModelInfo[]> {
    if (providerId === 'claude-code') {
      // No hardcoded claude-code model list — read the live catalog from
      // Anthropic's /v1/models using the signed-in account's credentials.
      // Degrades to the provider-agnostic Auto sentinel on any failure. See
      // claudeModelCatalog.ts.
      const { listClaudeCodeModels } = await import('../languagemodels/claudeModelCatalog');
      return (await listClaudeCodeModels()).map(model => this.modelInfo(providerId, model));
    }

    if (providerId === 'codex') {
      // No hardcoded codex model list — read the live catalog from the codex
      // CLI (through Sulla, so vault OAuth creds are injected). Degrades to the
      // "Auto" sentinel on any failure. See codexModelCatalog.ts.
      const { listCodexModels } = await import('../languagemodels/codexModelCatalog');
      return (await listCodexModels({ force: queryOptions.forceRefresh === true })).map(model => this.modelInfo(providerId, model));
    }

    if (providerId === 'opencode') {
      const { listOpenCodeModels } = await import('../languagemodels/openCodeModelCatalog');
      return (await listOpenCodeModels()).map(model => this.modelInfo(providerId, model));
    }

    if (providerId === 'cursor') {
      const { listCursorModels } = await import('../languagemodels/cursorModelCatalog');
      return (await listCursorModels()).map(model => this.modelInfo(providerId, model));
    }

    return [];
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
    firstRunTrace('models', 'model selected', { providerId, modelId });

    return this.getState();
  }

  /**
   * Pick a usable primary provider from the accounts that actually exist.
   * During first run credentials may still be waiting in memory for the vault,
   * so pending credentials count as connected here and in the model picker.
   */
  async reconcilePrimaryProvider(preferPriority = false, explicitlySelectedProvider = ''): Promise<ModelProviderState> {
    const integrationService = getIntegrationService();
    const priority = ['claude-code', 'codex', 'grok'];
    const candidates = Object.values(integrations)
      .filter(i => i.category === 'AI Infrastructure' && !EXCLUDED_PROVIDER_IDS.includes(i.id))
      .map(i => i.id)
      .sort((a, b) => {
        const ai = priority.indexOf(a); const bi = priority.indexOf(b);
        return (ai < 0 ? priority.length : ai) - (bi < 0 ? priority.length : bi);
      });
    const connected = new Set<string>();
    let lookupUnknown = false;

    for (const providerId of candidates) {
      if (hasPendingCredential(providerId)) {
        connected.add(providerId);
        continue;
      }
      try {
        if (await integrationService.isAnyAccountConnected(providerId)) connected.add(providerId);
      } catch { lookupUnknown = true }
    }

    const selectedProvider = explicitlySelectedProvider && connected.has(explicitlySelectedProvider)
      ? explicitlySelectedProvider
      : (!preferPriority && connected.has(this.state.primaryProvider) ? this.state.primaryProvider : candidates.find(id => connected.has(id)));
    const reason = explicitlySelectedProvider && selectedProvider === explicitlySelectedProvider ? 'explicit'
      : selectedProvider === this.state.primaryProvider ? 'kept-primary' : selectedProvider ? 'connected-priority' : 'none';

    if (selectedProvider) {
      if (selectedProvider !== this.state.primaryProvider) await this.selectModel(selectedProvider, '');
      const fallback = candidates.find(id => connected.has(id) && id !== selectedProvider) || selectedProvider;
      if (!connected.has(this.state.secondaryProvider)) await this.setSecondaryProvider(fallback);
      firstRunTrace('models', 'providers reconciled', { candidates, connected: [...connected], lookupUnknown, primary: selectedProvider, secondary: this.state.secondaryProvider, reason });
      return this.getState();
    }

    // An empty result while the vault is locked or starting is not evidence
    // that the user's saved choice is disconnected. Never erase it.
    firstRunTrace('models', 'providers reconciled', { candidates, connected: [...connected], lookupUnknown, primary: this.state.primaryProvider, secondary: this.state.secondaryProvider, reason });
    if (lookupUnknown || this.state.primaryProvider) return this.getState();
    return this.getState();
  }

  async setSecondaryProvider(providerId: string): Promise<void> {
    this.state.secondaryProvider = providerId;
    await SullaSettingsModel.set('secondaryProvider', providerId, 'string');
    await this.broadcastChange();
    firstRunTrace('models', 'secondary provider selected', { providerId });
  }

  async setSecondaryModelId(modelId: string): Promise<void> {
    this.state.secondaryModelId = modelId;
    await SullaSettingsModel.set('secondaryModelId', modelId, 'string');
    await this.broadcastChange();
  }

  async setHeartbeatProvider(providerId: string): Promise<void> {
    this.state.heartbeatProvider = providerId;
    await SullaSettingsModel.set('heartbeatProvider', providerId, 'string');
    await this.broadcastChange();
  }

  async setSubconsciousProvider(providerId: string): Promise<void> {
    const changed = providerId !== this.state.subconsciousProvider;
    this.state.subconsciousProvider = providerId;
    await SullaSettingsModel.set('subconsciousProvider', providerId, 'string');

    // When the provider changes, a concrete model-id override left over from the
    // previous provider is now stranded — e.g. subconsciousProvider moves grok→codex
    // while subconsciousModelId is still 'grok-4.6'. That inconsistent pair is the
    // source of the recurring subconscious model drift: every full-state broadcast
    // re-pushes the stale id into the settings UI, which re-persists it and clobbers
    // any manual repair. Reset the override to '' (use the new provider's default) so
    // the model always stays consistent with its provider. Tier names
    // (fast/balanced/powerful) and '' are provider-agnostic, so leave those intact.
    if (changed && !this.isProviderAgnosticModelId(this.state.subconsciousModelId)) {
      this.state.subconsciousModelId = '';
      await SullaSettingsModel.set('subconsciousModelId', '', 'string');
    }

    await this.broadcastChange();
  }

  /** True when the model id carries no provider affinity: empty (use provider default)
   *  or a dynamic tier name that resolves against whatever provider is active. */
  private isProviderAgnosticModelId(modelId: string): boolean {
    return !modelId || modelId === 'fast' || modelId === 'balanced' || modelId === 'powerful';
  }

  /**
   * Decide whether a concrete subconscious model id is stranded — i.e. it names a
   * model its provider does not offer, the inconsistent pair (e.g. provider=codex /
   * id=grok-4.6) that drives the recurring subconscious drift.
   *
   * Fail-safe by construction — only returns true when we can POSITIVELY prove the
   * mismatch. It never resets when:
   *  - the id is provider-agnostic ('', or a fast/balanced/powerful tier), or
   *  - the provider's model list is unknown/empty (a dynamic provider whose catalog
   *    could not be loaded — resetting there would wipe a legitimately-chosen model).
   * This is the landmine guard: a blanket "reset if not in list" would clobber a valid
   * concrete selection whenever the catalog fetch transiently fails.
   */
  private modelIsStrandedForProvider(modelId: string, providerModelIds: string[]): boolean {
    if (this.isProviderAgnosticModelId(modelId)) return false; // no provider affinity — never stranded
    if (providerModelIds.length === 0) return false; // catalog unknown — cannot prove mismatch, keep
    return !providerModelIds.includes(modelId); // concrete id the provider does not offer → stranded
  }

  /**
   * Restart self-heal for the subconscious slot. setSubconsciousProvider() only clears a
   * stranded override when the PROVIDER changes; the reported drift keeps the provider
   * unchanged (stays codex) while a stale concrete id (grok-4.6) survives in the DB and is
   * reloaded verbatim on every boot. This reconciles the loaded pair once at init: if the
   * concrete id is provably not offered by the current provider, reset it to '' (provider
   * default) so the pair is consistent and stops being re-broadcast into the settings UI.
   * Runs after the DB load; no-ops on any error so a bad reconcile never blocks startup.
   */
  private async reconcileSubconsciousModel(): Promise<void> {
    const modelId = this.state.subconsciousModelId;
    if (this.isProviderAgnosticModelId(modelId)) return; // fast path — nothing concrete to reconcile

    let providerModelIds: string[] = [];
    try {
      const models = await this.getModelsForProvider(this.state.subconsciousProvider);
      providerModelIds = models.map(m => m.id);
    } catch {
      return; // could not load the provider catalog — fail safe, leave the id untouched
    }

    if (this.modelIsStrandedForProvider(modelId, providerModelIds)) {
      console.warn(
        `[ModelProviderService] Stranded subconscious model '${ modelId }' is not offered by ` +
        `provider '${ this.state.subconsciousProvider }' — resetting to provider default`,
      );
      this.state.subconsciousModelId = '';
      await SullaSettingsModel.set('subconsciousModelId', '', 'string');
    }
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
    this.state.primaryProvider = await SullaSettingsModel.get('primaryProvider', '');
    this.state.secondaryProvider = await SullaSettingsModel.get('secondaryProvider', '');
    this.state.heartbeatProvider = await SullaSettingsModel.get('heartbeatProvider', 'default');
    this.state.subconsciousProvider = await SullaSettingsModel.get('subconsciousProvider', 'default');
    this.state.secondaryModelId = await SullaSettingsModel.get('secondaryModelId', '');
    this.state.heartbeatModelId = await SullaSettingsModel.get('heartbeatModelId', 'fast');
    this.state.subconsciousModelId = await SullaSettingsModel.get('subconsciousModelId', 'fast');
    this.state.modelMode = 'remote';

    // Self-heal a stranded subconscious model/provider pair loaded from the DB (e.g.
    // provider=codex left with a concrete grok-4.6 id). setSubconsciousProvider only
    // clears this on a provider change; reconcile here so it also heals on restart when
    // the provider is unchanged — the acceptance criterion for this slot.
    await this.reconcileSubconsciousModel();

    // Load active model from the provider's integration form values
    try {
      const integrationService = getIntegrationService();
      const formValues = await integrationService.getFormValues(this.state.primaryProvider);
      const modelVal = formValues.find(v => v.property === 'model');
      this.state.activeModelId = modelVal?.value || await SullaSettingsModel.get('remoteModel', '');
    } catch {
      this.state.activeModelId = await SullaSettingsModel.get('remoteModel', '');
    }
    firstRunTrace('models', 'state loaded from DB', { primary: this.state.primaryProvider, model: this.state.activeModelId, secondary: this.state.secondaryProvider, secondaryModel: this.state.secondaryModelId });
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

    // Metadata-only account list / active-account switch for the settings
    // window (the vault:* channels are restricted to the main-agent window).
    ipcMain.handle('model-provider:get-accounts', async(_event: unknown, providerId: string) => {
      const accounts = await getIntegrationService().getAccounts(String(providerId));
      return accounts.map(a => ({ accountId: a.account_id, label: a.label || a.account_id, active: !!a.active, connected: !!a.connected }));
    });

    ipcMain.handle('model-provider:set-active-account', async(_event: unknown, providerId: string, accountId: string) => {
      await getIntegrationService().setActiveAccount(String(providerId), String(accountId));
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

    ipcMain.handle('model-provider:set-secondary-model', async(_event: unknown, modelId: string) => {
      return this.setSecondaryModelId(modelId);
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
