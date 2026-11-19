// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * AgentModelSelectorController — Thin IPC client of ModelProviderService.
 *
 * All provider/model state lives in the main process (ModelProviderService).
 * This controller only:
 * - Reads state via IPC on startup
 * - Sends mutations via IPC when the user selects a model
 * - Listens for state-changed broadcasts to keep the UI in sync
 */

import { computed, ref } from 'vue';

import { MODEL_DEFAULTS_CHANGED, MODEL_DEFAULTS_IPC, type ModelDefaultsState } from '@pkg/agent/languagemodels/modelDefaultsTypes';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

import type { ModelSelectionMode } from '@pkg/shared/providerAccess';
import type { ComputedRef, Ref } from 'vue';

export interface ModelOption {
  providerId:       string;
  providerName:     string;
  providerAccessLabel?: string;
  modelId:          string;
  modelLabel:       string;
  selectionMode?:   ModelSelectionMode;
  isActiveProvider: boolean;
  isActiveModel:    boolean;
}

export interface ProviderGroup {
  providerId:       string;
  providerName:     string;
  accessLabel?:     string;
  isActiveProvider: boolean;
  loading:          boolean;
  models:           ModelOption[];
}

export interface AgentOption {
  id:          string;
  slug:        string;
  name:        string;
  description: string;
  provider:    string | null;
  model:       string | null;
  modelSlot:   'primary' | 'secondary' | 'subconscious' | null;
  status:      string;
  enabled:     boolean;
}

export class AgentModelSelectorController {
  private hasChatSelection = false;
  readonly showModelMenu = ref(false);
  readonly modelMenuEl = ref<HTMLElement | null>(null);
  readonly buttonRef = ref<HTMLElement | null>(null);

  /** Currently active primary provider id */
  readonly activePrimaryProvider = ref<string>('');
  /** Currently active model id for the active provider */
  readonly activeModelId = ref<string>('');

  /** Grouped providers with their models */
  readonly providerGroups = ref<ProviderGroup[]>([]);
  readonly agentOptions = ref<AgentOption[]>([]);
  readonly activeAgentId = ref<string | null>(null);
  readonly chatDefaultAgentName = ref('');
  private chatDefaultGeneration = 0;

  readonly loadingProviders = ref(false);
  /** During and after availability reads, stale UI events must fail closed. */
  private providerAvailabilityLoaded = false;
  /** Only the newest availability read may repopulate the selector. */
  private providerRefreshGeneration = 0;

  readonly activeModelLabel: ComputedRef<string>;
  readonly isRunningValue:   ComputedRef<boolean>;

  constructor(private readonly deps: {
    systemReady: Ref<boolean>;
    loading:     Ref<boolean>;
    isRunning:   Ref<boolean>;

    modelName:        Ref<string>;
    modelMode:        Ref<'remote'>;
    onSelectForChat?: (selection: { providerId: string; modelId: string; agentId: string | null; label: string }) => void;
  }) {
    this.activeModelLabel = computed(() => {
      const agent = this.agentOptions.value.find(item => item.slug === this.activeAgentId.value);
      if (agent) return agent.name;
      const provider = this.activePrimaryProvider.value;
      const model = this.activeModelId.value;

      if (model) {
        return model;
      }

      return provider ? 'Auto' : 'Default';
    });

    this.isRunningValue = computed(() => this.deps.isRunning.value);
  }

  async start(): Promise<void> {
    document.addEventListener('mousedown', this.handleDocumentClick);
    ipcRenderer.on('model-provider:state-changed', this.handleStateChanged);
    ipcRenderer.on('vault:logged-in' as any, this.handleVaultUnlocked);
    // Legacy listener for backward compat with windows not yet migrated
    ipcRenderer.on('model-changed', this.handleLegacyModelChanged);
    ipcRenderer.on(MODEL_DEFAULTS_CHANGED, this.handleChatDefaultsChanged);
    await Promise.all([this.loadActiveSettings(), this.loadChatDefault()]);
  }

  dispose(): void {
    document.removeEventListener('mousedown', this.handleDocumentClick);
    ipcRenderer.removeListener('model-provider:state-changed', this.handleStateChanged);
    ipcRenderer.removeListener('vault:logged-in' as any, this.handleVaultUnlocked);
    ipcRenderer.removeListener('model-changed', this.handleLegacyModelChanged);
    ipcRenderer.removeListener(MODEL_DEFAULTS_CHANGED, this.handleChatDefaultsChanged);
    this.chatDefaultGeneration++;
  }

  get showModelMenuValue(): boolean {
    return this.showModelMenu.value;
  }

  get activeModelLabelValue(): string {
    return this.activeModelLabel.value;
  }

  get providerGroupsValue(): ProviderGroup[] {
    return this.providerGroups.value;
  }

  get loadingProvidersValue(): boolean {
    return this.loadingProviders.value;
  }

  get agentOptionsValue(): AgentOption[] { return this.agentOptions.value }
  get isDefaultValue(): boolean { return !this.activePrimaryProvider.value && !this.activeAgentId.value }

  async toggleModelMenu(): Promise<void> {
    this.showModelMenu.value = !this.showModelMenu.value;

    if (this.showModelMenu.value) {
      await this.refresh();
    }
  }

  hideModelMenu(): void {
    this.showModelMenu.value = false;
  }

  /**
   * Fetch provider groups + their models without touching the legacy
   * `showModelMenu` flag. New UIs that render the list in their own
   * modal/dropdown (and so don't care about the flag) should call this
   * when their surface becomes visible.
   */
  async refresh(): Promise<void> {
    await Promise.all([this.refreshProviderGroups(), this.refreshAgents()]);
  }

  /** Clear chat-local overrides so Preferences owns the next turn. */
  selectDefault(): void {
    try {
      this.hasChatSelection = false;
      this.activeAgentId.value = null;
      this.applyState({ primaryProvider: '', activeModelId: '' });
      this.updateActiveFlags('', '');
      this.deps.onSelectForChat?.({ providerId: '', modelId: '', agentId: null, label: 'Default' });
    } finally {
      this.showModelMenu.value = false;
    }
  }

  /** Select a model for this chat only; global Preferences are never mutated. */
  selectModel(option: ModelOption): void {
    if (this.providerAvailabilityLoaded) {
      const group = this.providerGroups.value.find(candidate => candidate.providerId === option.providerId);
      const available = !!group && !group.loading && group.models.some(model => model.modelId === option.modelId);
      if (!available) return;
    }
    try {
      this.hasChatSelection = true;
      this.activeAgentId.value = null;
      this.applyState({ primaryProvider: option.providerId, activeModelId: option.modelId });
      this.updateActiveFlags(option.providerId, option.modelId);
      this.deps.onSelectForChat?.({ providerId: option.providerId, modelId: option.modelId, agentId: null, label: option.modelLabel });
    } finally {
      this.showModelMenu.value = false;
    }
  }

  selectAgent(agent: AgentOption): void {
    this.hasChatSelection = true;
    this.activeAgentId.value = agent.slug;
    // A human-picked exact model remains authoritative when they subsequently pick a persona.
    const providerId = this.activePrimaryProvider.value || agent.provider || '';
    // Keep the chat's concrete selection unchanged. The agent's modelSlot is
    // resolved by the runtime from Preferences, unless this chat explicitly
    // picked a model.
    const modelId = this.activeModelId.value;
    this.applyState({ primaryProvider: providerId, activeModelId: modelId });
    this.updateActiveFlags('', '');
    this.deps.onSelectForChat?.({ providerId, modelId, agentId: agent.slug, label: agent.name });
    this.showModelMenu.value = false;
  }

  restoreForChat(providerId: string | null | undefined, modelId: string, agentId?: string | null): void {
    this.hasChatSelection = Boolean(providerId || modelId || agentId);
    this.activePrimaryProvider.value = providerId ?? '';
    this.activeModelId.value = modelId;
    this.activeAgentId.value = agentId ?? null;
    this.updateActiveFlags(providerId ?? '', modelId);
  }

  // ─── Internal ──────────────────────────────────────────────────

  private applyChatDefault(state: ModelDefaultsState): void {
    const choice = state?.defaults?.chat;
    this.chatDefaultAgentName.value = choice?.kind === 'agent'
      ? state.agents.find(agent => agent.slug === choice.agentId)?.name ?? 'Sulla'
      : '';
  }

  private handleChatDefaultsChanged = (_event: unknown, state: ModelDefaultsState): void => {
    this.chatDefaultGeneration++;
    this.applyChatDefault(state);
  };

  private async loadChatDefault(): Promise<void> {
    const generation = ++this.chatDefaultGeneration;
    try {
      const state = await ipcRenderer.invoke(MODEL_DEFAULTS_IPC.get);
      if (generation === this.chatDefaultGeneration) this.applyChatDefault(state);
    } catch {
      // An older or still-starting backend may not have the saved default yet.
    }
  }

  private async loadActiveSettings(): Promise<void> {
    try {
      // The legacy primary slot is provider readiness, not a chat selection.
      // A fresh thread stays Default so Preferences is authoritative.
      await ipcRenderer.invoke('model-provider:get-state');
      // A restored or human chat selection made while this loaded stays authoritative.
      if (!this.hasChatSelection) this.applyState({ primaryProvider: '', activeModelId: '' });
    } catch (err) {
      console.warn('[ModelSelector] Failed to load state from ModelProviderService:', err);
    }
  }

  /**
   * Fetch provider groups from ModelProviderService via IPC.
   */
  private async refreshProviderGroups(): Promise<void> {
    const refreshGeneration = ++this.providerRefreshGeneration;
    this.loadingProviders.value = true;
    this.providerAvailabilityLoaded = true;
    // Do not leave a disconnected provider selectable while the fresh
    // account read is in flight. The chat-local ids remain untouched.
    this.providerGroups.value = [];

    try {
      const providers = await ipcRenderer.invoke('model-provider:get-providers');
      if (refreshGeneration !== this.providerRefreshGeneration) return;
      this.providerAvailabilityLoaded = true;
      const groups: ProviderGroup[] = [];

      for (const provider of providers) {
        // A missing/unknown connection bit is not permission to select a
        // provider. The main process supplies the safe access label only for
        // the selected account that is actually connected.
        if (provider.connected !== true || provider.selectable === false || provider.connectionStatus === 'unknown' || provider.accessMethod === 'unknown') continue;
        const isActive = this.activePrimaryProvider.value === provider.id;

        const group: ProviderGroup = {
          providerId:       provider.id,
          providerName:     provider.name,
          accessLabel:      provider.accessLabel,
          isActiveProvider: isActive,
          loading:          true,
          models:           [],
        };

        groups.push(group);

        // Async model fetch — don't block the menu from showing
        this.fetchModelsForGroup(group, isActive);
      }

      this.providerGroups.value = groups;
    } catch (err) {
      if (refreshGeneration !== this.providerRefreshGeneration) return;
      console.warn('[ModelSelector] Failed to refresh provider groups:', err);
      // A failed availability read is not permission to keep stale choices.
      this.providerAvailabilityLoaded = true;
      this.providerGroups.value = [];
    } finally {
      if (refreshGeneration === this.providerRefreshGeneration) this.loadingProviders.value = false;
    }
  }

  async refreshAgents(): Promise<void> {
    try {
      this.agentOptions.value = (await ipcRenderer.invoke('agent-definitions:list'))
        .filter(agent => agent.enabled && agent.status === 'production');
    } catch { this.agentOptions.value = [] }
  }

  private async fetchModelsForGroup(group: ProviderGroup, isActive: boolean): Promise<void> {
    try {
      const models = await ipcRenderer.invoke('model-provider:get-models', group.providerId);

      group.models = models.map((m: { id: string; name: string; description?: string; selectionMode?: ModelSelectionMode }) => ({
        providerId:       group.providerId,
        providerName:     group.providerName,
        providerAccessLabel: group.accessLabel,
        modelId:          m.id,
        modelLabel:       m.name,
        selectionMode:    m.selectionMode ?? 'exact',
        isActiveProvider: isActive,
        isActiveModel:    isActive && m.id === this.activeModelId.value,
      }));
      group.loading = false;

      // Trigger reactivity
      this.providerGroups.value = [...this.providerGroups.value];
    } catch (err) {
      console.warn(`[ModelSelector] Failed to fetch models for ${ group.providerId }:`, err);
      group.loading = false;
      this.providerGroups.value = [...this.providerGroups.value];
    }
  }

  private applyState(state: { primaryProvider: string; activeModelId: string; modelMode?: string }): void {
    this.activePrimaryProvider.value = state.primaryProvider;
    this.activeModelId.value = state.activeModelId;
    this.deps.modelName.value = state.activeModelId;
    this.deps.modelMode.value = 'remote';
  }

  private updateActiveFlags(providerId: string, modelId: string): void {
    this.providerGroups.value = this.providerGroups.value.map((group) => ({
      ...group,
      isActiveProvider: group.providerId === providerId,
      models:           group.models.map((m) => ({
        ...m,
        isActiveProvider: m.providerId === providerId,
        isActiveModel:    m.providerId === providerId && m.modelId === modelId,
      })),
    }));
  }

  // ─── Event handlers ────────────────────────────────────────────

  private readonly handleStateChanged = (
    _event: Electron.IpcRendererEvent,
    state: { primaryProvider: string; activeModelId: string; modelMode?: string },
  ) => {
    if (!this.hasChatSelection) {
      this.applyState(state);
      this.updateActiveFlags(state.primaryProvider, state.activeModelId);
    }
    void this.refreshProviderGroups();
  };

  private readonly handleVaultUnlocked = () => {
    void this.refreshProviderGroups();
    void this.loadChatDefault();
  };

  /** Backward-compat listener for legacy model-changed events */
  private readonly handleLegacyModelChanged = (
    _event: Electron.IpcRendererEvent,
    data: { model: string; type: string; provider?: string },
  ) => {
    if (this.hasChatSelection) return;
    const providerId = (data as any).provider || 'grok';
    this.applyState({
      primaryProvider: providerId,
      activeModelId:   data.model,
    });
    this.updateActiveFlags(providerId, data.model);
  };

  private readonly handleDocumentClick = (ev: MouseEvent) => {
    if (!this.showModelMenu.value) {
      return;
    }

    const container = this.modelMenuEl.value;

    if (!container) {
      return;
    }

    if (ev.target === this.buttonRef.value || this.buttonRef.value?.contains(ev.target as Node)) {
      return;
    }

    if (ev.target instanceof Node && container.contains(ev.target)) {
      return;
    }

    this.showModelMenu.value = false;
  };
}
