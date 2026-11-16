// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * AI model routing for Preferences › AI models and › Heartbeat.
 *
 * ModelProviderService in the main process owns provider and model choices
 * and broadcasts every change; this composable mirrors that state and sends
 * the user's picks back through the same `model-provider:*` IPC the old
 * Language Model Settings window used.
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';

import { ipcRenderer } from '@pkg/utils/ipcRenderer';

export type ModelSlot = 'primary' | 'secondary' | 'subconscious';

export interface ProviderOption { id: string; name: string; connected: boolean }
export interface ModelOption { id: string; name: string }
export interface AccountOption { accountId: string; label: string; active: boolean; connected: boolean }

/** Provider-agnostic tiers ModelProviderService resolves per provider. */
export const MODEL_TIERS = [
  { id: 'fast', name: 'fast (cheapest, fastest tier)' },
  { id: 'balanced', name: 'balanced (middle tier)' },
  { id: 'powerful', name: 'powerful (best tier)' },
];

/** Providers that run on this Mac rather than through an online API. */
export const LOCAL_PROVIDERS = ['ollama'];

interface ProviderState {
  primaryProvider:      string;
  secondaryProvider:    string;
  subconsciousProvider: string;
  activeModelId:        string;
  secondaryModelId:     string;
  subconsciousModelId:  string;
}

/** The slice of the renderer IPC the controller needs (swappable in tests). */
export interface ModelSettingsIpc {
  invoke(channel: string, ...args: any[]): Promise<any>;
  on(channel: string, listener: (...args: any[]) => void): unknown;
  removeListener(channel: string, listener: (...args: any[]) => void): unknown;
}

/** The window events the controller listens to (swappable in tests). */
export interface ModelSettingsWindow {
  addEventListener(type: 'focus', listener: () => void): void;
  removeEventListener(type: 'focus', listener: () => void): void;
}

const SLOTS: readonly ModelSlot[] = ['primary', 'secondary', 'subconscious'];
const PROVIDER_RETRY_DELAYS: readonly number[] = [1000, 3000, 6000];

/**
 * Mirrors ModelProviderService's provider/model state and sends the user's
 * picks back over the `model-provider:*` IPC.
 */
export class ModelSettingsController {
  readonly state = reactive<ProviderState>({
    primaryProvider:      '',
    secondaryProvider:    '',
    subconsciousProvider: 'default',
    activeModelId:        '',
    secondaryModelId:     '',
    subconsciousModelId:  '',
  });

  readonly providers = ref<ProviderOption[]>([]);
  readonly models = reactive<Record<ModelSlot, ModelOption[]>>({ primary: [], secondary: [], subconscious: [] });
  readonly accounts = reactive<Record<ModelSlot, AccountOption[]>>({ primary: [], secondary: [], subconscious: [] });
  readonly loading = ref(true);
  readonly error = ref('');
  readonly saved = ref(false);

  readonly runsLocally = computed(() => LOCAL_PROVIDERS.includes(this.state.primaryProvider));
  readonly localProvider = computed(() => this.providers.value.find(p => LOCAL_PROVIDERS.includes(p.id) && p.connected));
  readonly onlineProvider = computed(() => this.providers.value.find(p => !LOCAL_PROVIDERS.includes(p.id) && p.connected));

  private savedTimer: ReturnType<typeof setTimeout> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private retryAttempt = 0;

  constructor(
    private readonly ipc: ModelSettingsIpc,
    private readonly win: ModelSettingsWindow,
  ) {}

  private message(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

  /** The provider a slot actually uses ('default' subconscious follows the primary). */
  slotProvider(slot: ModelSlot): string {
    const { state } = this;

    if (slot === 'primary') {
      return state.primaryProvider;
    }
    if (slot === 'secondary') {
      return state.secondaryProvider;
    }

    return state.subconsciousProvider === 'default' ? state.primaryProvider : state.subconsciousProvider;
  }

  private async loadModels(slot: ModelSlot): Promise<void> {
    const id = this.slotProvider(slot);

    if (!id) {
      this.models[slot] = [];

      return;
    }
    try {
      this.models[slot] = await this.ipc.invoke('model-provider:get-models', id) || [];
    } catch (err) {
      this.models[slot] = [];
      this.error.value = `Could not load models: ${ this.message(err) }`;
    }
  }

  private async loadAccounts(slot: ModelSlot): Promise<void> {
    const id = this.slotProvider(slot);

    if (!id) {
      return;
    }
    try {
      const all = await this.ipc.invoke('model-provider:get-accounts', id) || [];

      this.accounts[slot] = all.filter((account: AccountOption) => account.connected === true);
    } catch {
      this.accounts[slot] = [];
    }
  }

  private async loadSlots(): Promise<void> {
    await Promise.all(SLOTS.flatMap(slot => [this.loadModels(slot), this.loadAccounts(slot)]));
  }

  /**
   * Only expose providers whose integration account is connected. An empty
   * list usually means the vault wasn't unlocked yet, so retry a few times
   * before showing the connect-provider empty state.
   */
  loadProviders = async(): Promise<void> => {
    const { state } = this;

    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    let suspicious = false;

    try {
      const all = await this.ipc.invoke('model-provider:get-providers');
      const list: ProviderOption[] = (Array.isArray(all) ? all : [])
        .map(p => ({ id: p.id, name: p.name, connected: p.connected === true }))
        .filter(p => p.connected);

      list.sort((a, b) => a.name.localeCompare(b.name));
      this.providers.value = list;

      // A stale saved choice must never pull models from a disconnected
      // provider into Preferences. Point the visible slots at connected
      // providers; the user's next selection persists through the service.
      const connectedIds = new Set(list.map(provider => provider.id));
      const previousSlots = [state.primaryProvider, state.secondaryProvider, state.subconsciousProvider];
      const firstConnected = list[0]?.id ?? '';
      if (!connectedIds.has(state.primaryProvider)) state.primaryProvider = firstConnected;
      if (!connectedIds.has(state.secondaryProvider)) state.secondaryProvider = firstConnected;
      if (state.subconsciousProvider !== 'default' && !connectedIds.has(state.subconsciousProvider)) {
        state.subconsciousProvider = 'default';
      }
      if (previousSlots.some((provider, index) => provider !== [state.primaryProvider, state.secondaryProvider, state.subconsciousProvider][index])) {
        await this.loadSlots();
      }
      suspicious = list.length === 0;
    } catch (err) {
      this.error.value = `Could not load providers: ${ this.message(err) }`;
      suspicious = true;
    }

    if (suspicious && this.retryAttempt < PROVIDER_RETRY_DELAYS.length) {
      this.retryTimer = setTimeout(this.loadProviders, PROVIDER_RETRY_DELAYS[this.retryAttempt++]);
    } else if (!suspicious) {
      this.retryAttempt = 0;
    }
  };

  applyState(next: Partial<ProviderState>): void {
    const { state } = this;

    for (const key of Object.keys(state) as (keyof ProviderState)[]) {
      if (next[key] !== undefined) {
        state[key] = next[key] || (key === 'subconsciousProvider' ? 'default' : '');
      }
    }
  }

  private onStateChanged = (_event: unknown, next: Partial<ProviderState>): void => {
    const primaryChanged = next.primaryProvider !== undefined && next.primaryProvider !== this.state.primaryProvider;

    this.applyState(next);
    if (primaryChanged) {
      void this.loadSlots();
    }
    void this.loadProviders();
  };

  private onVaultUnlocked = (): void => {
    this.loading.value = true;
    this.retryAttempt = 0;
    void Promise.all([this.loadProviders(), this.loadSlots()]).finally(() => { this.loading.value = false });
  };

  private async run(work: () => Promise<unknown>): Promise<void> {
    this.error.value = '';
    this.saved.value = false;
    try {
      await work();
      this.saved.value = true;
      if (this.savedTimer) clearTimeout(this.savedTimer);
      this.savedTimer = setTimeout(() => { this.saved.value = false }, 2_000);
    } catch (err) {
      this.error.value = this.message(err);
    }
  }

  /** Switch the main model's provider, keeping that provider's preferred model. */
  setPrimaryProvider = (id: string): Promise<void> => {
    return this.run(async() => {
      const config = await this.ipc.invoke('model-provider:get-provider-config', id);

      this.applyState(await this.ipc.invoke('model-provider:select-model', id, config?.model || ''));
      await this.loadSlots();
    });
  };

  setPrimaryModel = (modelId: string): Promise<void> => {
    return this.run(async() => {
      this.applyState(await this.ipc.invoke('model-provider:select-model', this.state.primaryProvider, modelId));
    });
  };

  setSecondaryProvider = (id: string): Promise<void> => {
    return this.run(async() => {
      await this.ipc.invoke('model-provider:set-secondary', id);
      this.state.secondaryProvider = id;
      await Promise.all([this.loadModels('secondary'), this.loadAccounts('secondary')]);
    });
  };

  setSecondaryModel = (modelId: string): Promise<void> => {
    return this.run(async() => {
      await this.ipc.invoke('model-provider:set-secondary-model', modelId);
      this.state.secondaryModelId = modelId;
    });
  };

  setSubconsciousProvider = (id: string): Promise<void> => {
    return this.run(async() => {
      await this.ipc.invoke('model-provider:set-subconscious', id);
      this.state.subconsciousProvider = id || 'default';
      await Promise.all([this.loadModels('subconscious'), this.loadAccounts('subconscious')]);
    });
  };

  setSubconsciousModel = (modelId: string): Promise<void> => {
    return this.run(async() => {
      await this.ipc.invoke('model-provider:set-subconscious-model', modelId);
      this.state.subconsciousModelId = modelId;
    });
  };

  /** Pick which saved connection (vault account) a slot's provider uses. */
  setConnection = (slot: ModelSlot, accountId: string): Promise<void> => {
    return this.run(async() => {
      await this.ipc.invoke('model-provider:set-active-account', this.slotProvider(slot), accountId);
      await this.loadAccounts(slot);
    });
  };

  /** "Where models run": move the main model between an online provider and Ollama. */
  setWhere = (where: 'online' | 'local'): Promise<void> | undefined => {
    const target = where === 'local' ? this.localProvider.value : this.onlineProvider.value;

    if (target && target.id !== this.state.primaryProvider) {
      return this.setPrimaryProvider(target.id);
    }

    return undefined;
  };

  private onFocus = (): void => {
    void this.loadProviders();
    void Promise.all(SLOTS.map(slot => this.loadAccounts(slot)));
  };

  /** Start listening for changes and load the current state. */
  async mount(): Promise<void> {
    this.ipc.on('model-provider:state-changed', this.onStateChanged);
    this.ipc.on('vault:logged-in', this.onVaultUnlocked);
    this.win.addEventListener('focus', this.onFocus);
    try {
      this.applyState(await this.ipc.invoke('model-provider:get-state'));
    } catch (err) {
      this.error.value = `Could not read the current models: ${ this.message(err) }`;
    }
    await this.loadProviders();
    await this.loadSlots();
    this.loading.value = false;
  }

  /** Stop listening and cancel pending timers. */
  unmount(): void {
    this.ipc.removeListener('model-provider:state-changed', this.onStateChanged);
    this.ipc.removeListener('vault:logged-in', this.onVaultUnlocked);
    this.win.removeEventListener('focus', this.onFocus);
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
    }
    if (this.savedTimer) {
      clearTimeout(this.savedTimer);
    }
  }
}

/** Vue entry point: model routing state for Preferences › AI models and › Heartbeat. */
export function useModelSettings() {
  const controller = new ModelSettingsController(ipcRenderer as unknown as ModelSettingsIpc, window);

  onMounted(() => controller.mount());
  onBeforeUnmount(() => controller.unmount());

  return {
    state:                   controller.state,
    providers:               controller.providers,
    models:                  controller.models,
    accounts:                controller.accounts,
    loading:                 controller.loading,
    error:                   controller.error,
    saved:                   controller.saved,
    runsLocally:             controller.runsLocally,
    localProvider:           controller.localProvider,
    onlineProvider:          controller.onlineProvider,
    loadProviders:           controller.loadProviders,
    setPrimaryProvider:      controller.setPrimaryProvider,
    setPrimaryModel:         controller.setPrimaryModel,
    setSecondaryProvider:    controller.setSecondaryProvider,
    setSecondaryModel:       controller.setSecondaryModel,
    setSubconsciousProvider: controller.setSubconsciousProvider,
    setSubconsciousModel:    controller.setSubconsciousModel,
    setConnection:           controller.setConnection,
    setWhere:                controller.setWhere,
  };
}
