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

import { integrations } from '@pkg/agent/integrations/catalog';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

import type { ComputedRef, Ref } from 'vue';

export interface ModelOption {
  providerId:       string;
  providerName:     string;
  modelId:          string;
  modelLabel:       string;
  isActiveProvider: boolean;
  isActiveModel:    boolean;
}

export interface ProviderGroup {
  providerId:       string;
  providerName:     string;
  isActiveProvider: boolean;
  loading:          boolean;
  models:           ModelOption[];
}

export class AgentModelSelectorController {
  readonly showModelMenu = ref(false);
  readonly modelMenuEl = ref<HTMLElement | null>(null);
  readonly buttonRef = ref<HTMLElement | null>(null);

  /** Currently active primary provider id */
  readonly activePrimaryProvider = ref<string>('grok');
  /** Currently active model id for the active provider */
  readonly activeModelId = ref<string>('');

  /** Grouped providers with their models */
  readonly providerGroups = ref<ProviderGroup[]>([]);

  readonly loadingProviders = ref(false);

  readonly activeModelLabel: ComputedRef<string>;
  readonly isRunningValue:   ComputedRef<boolean>;

  constructor(private readonly deps: {
    systemReady: Ref<boolean>;
    loading:     Ref<boolean>;
    isRunning:   Ref<boolean>;

    modelName: Ref<string>;
    modelMode: Ref<'remote'>;
  }) {
    this.activeModelLabel = computed(() => {
      const provider = this.activePrimaryProvider.value;
      const model = this.activeModelId.value;

      if (model) {
        return model;
      }

      const integration = integrations[provider];

      return integration?.name || provider || 'Select model';
    });

    this.isRunningValue = computed(() => this.deps.isRunning.value);
  }

  async start(): Promise<void> {
    document.addEventListener('mousedown', this.handleDocumentClick);
    ipcRenderer.on('model-provider:state-changed', this.handleStateChanged);
    // Legacy listener for backward compat with windows not yet migrated
    ipcRenderer.on('model-changed', this.handleLegacyModelChanged);
    await this.loadActiveSettings();
  }

  dispose(): void {
    document.removeEventListener('mousedown', this.handleDocumentClick);
    ipcRenderer.removeListener('model-provider:state-changed', this.handleStateChanged);
    ipcRenderer.removeListener('model-changed', this.handleLegacyModelChanged);
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

  async toggleModelMenu(): Promise<void> {
    this.showModelMenu.value = !this.showModelMenu.value;

    if (this.showModelMenu.value) {
      await this.refreshProviderGroups();
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
    await this.refreshProviderGroups();
  }

  /**
   * Select a model — delegates to ModelProviderService via IPC.
   * The service writes to DB, manages llama-server, and broadcasts state-changed.
   */
  async selectModel(option: ModelOption): Promise<void> {
    try {
      const newState = await ipcRenderer.invoke('model-provider:select-model', option.providerId, option.modelId);

      this.applyState(newState);
      this.updateActiveFlags(option.providerId, option.modelId);
    } finally {
      this.showModelMenu.value = false;
    }
  }

  // ─── Internal ──────────────────────────────────────────────────

  private async loadActiveSettings(): Promise<void> {
    try {
      const state = await ipcRenderer.invoke('model-provider:get-state');
      this.applyState(state);
    } catch (err) {
      console.warn('[ModelSelector] Failed to load state from ModelProviderService:', err);
    }
  }

  /**
   * Fetch provider groups from ModelProviderService via IPC.
   */
  private async refreshProviderGroups(): Promise<void> {
    this.loadingProviders.value = true;

    try {
      const providers = await ipcRenderer.invoke('model-provider:get-providers');
      const groups: ProviderGroup[] = [];

      for (const provider of providers) {
        const isActive = this.activePrimaryProvider.value === provider.id;

        const group: ProviderGroup = {
          providerId:       provider.id,
          providerName:     provider.name,
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
      console.warn('[ModelSelector] Failed to refresh provider groups:', err);
    } finally {
      this.loadingProviders.value = false;
    }
  }

  private async fetchModelsForGroup(group: ProviderGroup, isActive: boolean): Promise<void> {
    try {
      const models = await ipcRenderer.invoke('model-provider:get-models', group.providerId);

      group.models = models.map((m: { id: string; name: string; description?: string }) => ({
        providerId:       group.providerId,
        providerName:     group.providerName,
        modelId:          m.id,
        modelLabel:       m.name,
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
    this.applyState(state);
    this.updateActiveFlags(state.primaryProvider, state.activeModelId);
  };

  /** Backward-compat listener for legacy model-changed events */
  private readonly handleLegacyModelChanged = (
    _event: Electron.IpcRendererEvent,
    data: { model: string; type: string; provider?: string },
  ) => {
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
