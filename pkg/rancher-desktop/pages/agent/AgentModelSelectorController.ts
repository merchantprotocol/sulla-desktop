import { computed, ref } from 'vue';
import type { ComputedRef, Ref } from 'vue';

import { ipcRenderer } from '@pkg/utils/ipcRenderer';
import { SullaSettingsModel } from '@pkg/agent/database/models/SullaSettingsModel';
import { getIntegrationService } from '@pkg/agent/services/IntegrationService';
import { integrations } from '@pkg/agent/integrations/catalog';
import { LOCAL_MODELS } from '@pkg/shared/localModels';

export interface ModelOption {
  providerId: string;
  providerName: string;
  modelId: string;
  modelLabel: string;
  isActiveProvider: boolean;
  isActiveModel: boolean;
}

export interface ProviderGroup {
  providerId: string;
  providerName: string;
  isActiveProvider: boolean;
  loading: boolean;
  models: ModelOption[];
}

const EXCLUDED_INTEGRATION_IDS = ['activepieces', 'composio', 'ollama'];

export class AgentModelSelectorController {
  readonly showModelMenu = ref(false);
  readonly modelMenuEl = ref<HTMLElement | null>(null);
  readonly buttonRef = ref<HTMLElement | null>(null);

  /** Currently active primary provider id */
  readonly activePrimaryProvider = ref<string>('ollama');
  /** Currently active model id for the active provider */
  readonly activeModelId = ref<string>('');

  /** Grouped providers with their models */
  readonly providerGroups = ref<ProviderGroup[]>([]);

  readonly loadingProviders = ref(false);

  readonly activeModelLabel: ComputedRef<string>;
  readonly isRunningValue: ComputedRef<boolean>;

  constructor(private readonly deps: {
    systemReady: Ref<boolean>;
    loading: Ref<boolean>;
    isRunning: Ref<boolean>;

    modelName: Ref<string>;
    modelMode: Ref<'local' | 'remote'>;
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
   * Select a model. This:
   * 1. Sets primaryProvider in SullaSettingsModel
   * 2. Writes the model choice into the provider's integration settings
   * 3. Emits model-changed IPC for other windows
   */
  async selectModel(option: ModelOption): Promise<void> {
    try {
      const integrationService = getIntegrationService();

      // 1. Update primary provider
      await SullaSettingsModel.set('primaryProvider', option.providerId, 'string');
      this.activePrimaryProvider.value = option.providerId;

      // 2. Write the model into the integration's form values
      const accountId = await integrationService.getActiveAccountId(option.providerId);

      await integrationService.setIntegrationValue({
        integration_id: option.providerId,
        account_id:     accountId,
        property:        'model',
        value:           option.modelId,
      });

      this.activeModelId.value = option.modelId;

      // Keep legacy settings in sync
      if (option.providerId === 'ollama') {
        await SullaSettingsModel.set('modelMode', 'local', 'string');
        await SullaSettingsModel.set('sullaModel', option.modelId, 'string');
        this.deps.modelMode.value = 'local';
      } else {
        await SullaSettingsModel.set('modelMode', 'remote', 'string');
        await SullaSettingsModel.set('remoteProvider', option.providerId, 'string');
        await SullaSettingsModel.set('remoteModel', option.modelId, 'string');
        this.deps.modelMode.value = 'remote';
      }

      this.deps.modelName.value = option.modelId;

      // 3. Notify other windows
      ipcRenderer.send('model-changed',
        option.providerId === 'ollama'
          ? { model: option.modelId, type: 'local' as const }
          : { model: option.modelId, type: 'remote' as const, provider: option.providerId },
      );

      // Update active flags in providerGroups
      this.providerGroups.value = this.providerGroups.value.map((group) => ({
        ...group,
        isActiveProvider: group.providerId === option.providerId,
        models: group.models.map((m) => ({
          ...m,
          isActiveProvider: m.providerId === option.providerId,
          isActiveModel: m.providerId === option.providerId && m.modelId === option.modelId,
        })),
      }));
    } finally {
      this.showModelMenu.value = false;
    }
  }

  // ─── Internal ──────────────────────────────────────────────────

  private async loadActiveSettings(): Promise<void> {
    this.activePrimaryProvider.value = await SullaSettingsModel.get('primaryProvider', 'ollama');

    // Read the active model from the provider's integration
    try {
      const integrationService = getIntegrationService();
      const formValues = await integrationService.getFormValues(this.activePrimaryProvider.value);
      const modelVal = formValues.find((v) => v.property === 'model');

      this.activeModelId.value = modelVal?.value || '';
    } catch {
      // Fallback to legacy
      if (this.activePrimaryProvider.value === 'ollama') {
        this.activeModelId.value = await SullaSettingsModel.get('sullaModel', '');
      } else {
        this.activeModelId.value = await SullaSettingsModel.get('remoteModel', '');
      }
    }

    this.deps.modelName.value = this.activeModelId.value;
  }

  /**
   * Build provider groups from local GGUF models + connected AI Infrastructure integrations.
   */
  private async refreshProviderGroups(): Promise<void> {
    this.loadingProviders.value = true;

    try {
      const integrationService = getIntegrationService();
      const groups: ProviderGroup[] = [];

      // ── Local GGUF models (llama.cpp) ──
      const isLocalActive = this.activePrimaryProvider.value === 'ollama';
      let currentLocalModel = '';

      try {
        currentLocalModel = await SullaSettingsModel.get('sullaModel', '');
      } catch { /* ignore */ }

      const localGroup: ProviderGroup = {
        providerId:       'ollama',
        providerName:     'Local Models',
        isActiveProvider: isLocalActive,
        loading:          false,
        models:           LOCAL_MODELS.map((m) => ({
          providerId:       'ollama',
          providerName:     'Local Models',
          modelId:          m.name,
          modelLabel:       `${ m.displayName } (${ m.size })`,
          isActiveProvider: isLocalActive,
          isActiveModel:    isLocalActive && m.name === currentLocalModel,
        })),
      };

      groups.push(localGroup);

      // ── Remote providers from integrations ──
      for (const integration of Object.values(integrations)) {
        if (integration.category !== 'AI Infrastructure') continue;
        if (EXCLUDED_INTEGRATION_IDS.includes(integration.id)) continue;

        const connected = await integrationService.isAnyAccountConnected(integration.id);

        if (!connected) continue;

        const isActive = this.activePrimaryProvider.value === integration.id;

        let currentModel = '';

        try {
          const vals = await integrationService.getFormValues(integration.id);
          currentModel = vals.find((v) => v.property === 'model')?.value || '';
        } catch { /* ignore */ }

        const group: ProviderGroup = {
          providerId:       integration.id,
          providerName:     integration.name,
          isActiveProvider: isActive,
          loading:          true,
          models:           [],
        };

        groups.push(group);

        // Kick off async model fetch (don't block the menu from showing)
        this.fetchModelsForGroup(group, integration, currentModel);
      }

      this.providerGroups.value = groups;
    } catch (err) {
      console.warn('[ModelSelector] Failed to refresh provider groups:', err);
    } finally {
      this.loadingProviders.value = false;
    }
  }

  private async fetchModelsForGroup(
    group: ProviderGroup,
    integration: (typeof integrations)[string],
    currentModel: string,
  ): Promise<void> {
    try {
      const integrationService = getIntegrationService();
      const accountId = await integrationService.getActiveAccountId(integration.id);

      // Build form values map for the select box provider
      const formVals = await integrationService.getFormValues(integration.id, accountId);
      const formMap: Record<string, string> = {};

      for (const v of formVals) {
        formMap[v.property] = v.value;
      }

      // Find the selectBoxId for the 'model' property
      const modelProp = integration.properties?.find((p) => p.key === 'model');

      if (!modelProp?.selectBoxId) {
        group.loading = false;
        this.providerGroups.value = [...this.providerGroups.value];

        return;
      }

      const options = await integrationService.getSelectOptions(
        modelProp.selectBoxId,
        integration.id,
        accountId,
        formMap,
      );

      const isActive = this.activePrimaryProvider.value === integration.id;

      group.models = options.map((opt) => ({
        providerId:       integration.id,
        providerName:     integration.name,
        modelId:          opt.value,
        modelLabel:       opt.label,
        isActiveProvider: isActive,
        isActiveModel:    isActive && opt.value === currentModel,
      }));
      group.loading = false;

      // Trigger reactivity
      this.providerGroups.value = [...this.providerGroups.value];
    } catch (err) {
      console.warn(`[ModelSelector] Failed to fetch models for ${integration.id}:`, err);
      group.loading = false;
      this.providerGroups.value = [...this.providerGroups.value];
    }
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
