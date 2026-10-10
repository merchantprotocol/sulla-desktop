/**
 * AgentModelSelectorController — Thin IPC client of ModelProviderService.
 *
 * All provider/model state lives in the main process (ModelProviderService).
 * This controller only:
 * - Reads defaults via IPC when a new chat starts
 * - Stores later selections in that chat's serialized controller state
 * - Reads the provider model catalog and custom-agent definitions
 */

import { computed, ref } from 'vue';

import { integrations } from '@pkg/agent/integrations/catalog';
import type { CustomAgentSummary } from '@pkg/main/customAgentDefinitions';
import type { ModelDescriptor } from '@pkg/pages/chat/models';
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
  readonly customAgents = ref<CustomAgentSummary[]>([]);

  readonly loadingProviders = ref(false);

  readonly activeModelLabel: ComputedRef<string>;
  readonly isRunningValue:   ComputedRef<boolean>;

  constructor(private readonly deps: {
    systemReady: Ref<boolean>;
    loading:     Ref<boolean>;
    isRunning:   Ref<boolean>;

    modelName: Ref<string>;
    modelMode: Ref<'remote'>;
    selection: Ref<ModelDescriptor>;
    select:    (selection: ModelDescriptor) => void;
  }) {
    this.activeModelLabel = computed(() => {
      const selection = this.deps.selection.value;

      if (selection.agentId) return selection.name;
      const provider = selection.providerId || this.activePrimaryProvider.value;
      const model = selection.modelId || selection.id || this.activeModelId.value;

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
    await this.loadActiveSettings();
  }

  dispose(): void {
    document.removeEventListener('mousedown', this.handleDocumentClick);
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

  get customAgentsValue(): CustomAgentSummary[] {
    return this.customAgents.value;
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
   * Select a model for this chat only. Global defaults are managed in Settings.
   */
  selectModel(option: ModelOption): void {
    try {
      this.deps.select({
        id:         option.modelId,
        modelId:    option.modelId,
        providerId: option.providerId,
        name:       option.modelLabel,
        tier:       'hosted',
        ctx:        '',
      });
      this.activePrimaryProvider.value = option.providerId;
      this.activeModelId.value = option.modelId;
      this.deps.modelName.value = option.modelId;
      this.updateActiveFlags(option.providerId, option.modelId);
    } finally {
      this.showModelMenu.value = false;
    }
  }

  selectAgent(agent: CustomAgentSummary): void {
    this.deps.select({
      id:         `agent:${ agent.id }`,
      name:       agent.name,
      tier:       'hosted',
      ctx:        '',
      agentId:    agent.id,
      modelId:    agent.model || undefined,
      providerId: agent.provider || undefined,
    });
    this.showModelMenu.value = false;
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
      const [providers, agents] = await Promise.all([
        ipcRenderer.invoke('model-provider:get-providers'),
        ipcRenderer.invoke('agents-list'),
      ]);
      this.customAgents.value = agents;
      const groups: ProviderGroup[] = [];

      for (const provider of providers) {
        if (provider.connected === false) continue;
        const isActive = !this.deps.selection.value.agentId &&
          (this.deps.selection.value.providerId || this.activePrimaryProvider.value) === provider.id;

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
        isActiveModel:    isActive && m.id === (this.deps.selection.value.modelId || this.deps.selection.value.id),
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
    if (!this.deps.selection.value.providerId && !this.deps.selection.value.agentId) {
      this.deps.select({
        id:         state.activeModelId,
        modelId:    state.activeModelId,
        providerId: state.primaryProvider,
        name:       state.activeModelId,
        tier:       'hosted',
        ctx:        '',
      });
    }
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
