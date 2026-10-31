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

export function useModelSettings() {
  const state = reactive<ProviderState>({
    primaryProvider:      '',
    secondaryProvider:    '',
    subconsciousProvider: 'default',
    activeModelId:        '',
    secondaryModelId:     '',
    subconsciousModelId:  '',
  });
  const providers = ref<ProviderOption[]>([]);
  const models = reactive<Record<ModelSlot, ModelOption[]>>({ primary: [], secondary: [], subconscious: [] });
  const accounts = reactive<Record<ModelSlot, AccountOption[]>>({ primary: [], secondary: [], subconscious: [] });
  const loading = ref(true);
  const error = ref('');
  const saved = ref(false);
  let savedTimer: ReturnType<typeof setTimeout> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let retryAttempt = 0;

  function message(err: unknown) {
    return err instanceof Error ? err.message : String(err);
  }

  function slotProvider(slot: ModelSlot): string {
    if (slot === 'primary') {
      return state.primaryProvider;
    }
    if (slot === 'secondary') {
      return state.secondaryProvider;
    }

    return state.subconsciousProvider === 'default' ? state.primaryProvider : state.subconsciousProvider;
  }

  async function loadModels(slot: ModelSlot) {
    const id = slotProvider(slot);

    if (!id) {
      models[slot] = [];

      return;
    }
    try {
      models[slot] = await ipcRenderer.invoke('model-provider:get-models', id) || [];
    } catch (err) {
      models[slot] = [];
      error.value = `Could not load models: ${ message(err) }`;
    }
  }

  async function loadAccounts(slot: ModelSlot) {
    const id = slotProvider(slot);

    if (!id) {
      return;
    }
    try {
      const all = await ipcRenderer.invoke('model-provider:get-accounts', id) || [];

      accounts[slot] = all.filter(account => account.connected === true);
    } catch {
      accounts[slot] = [];
    }
  }

  async function loadSlots() {
    const slots: ModelSlot[] = ['primary', 'secondary', 'subconscious'];

    await Promise.all(slots.flatMap(slot => [loadModels(slot), loadAccounts(slot)]));
  }

  /**
   * Only expose providers whose integration account is connected. An empty
   * list usually means the vault wasn't unlocked yet, so retry a few times
   * before showing the connect-provider empty state.
   */
  async function loadProviders() {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = undefined;
    }
    let suspicious = false;

    try {
      const all = await ipcRenderer.invoke('model-provider:get-providers');
      const list: ProviderOption[] = (Array.isArray(all) ? all : [])
        .map(p => ({ id: p.id, name: p.name, connected: p.connected === true }))
        .filter(p => p.connected);

      list.sort((a, b) => a.name.localeCompare(b.name));
      providers.value = list;

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
        await loadSlots();
      }
      suspicious = list.length === 0;
    } catch (err) {
      error.value = `Could not load providers: ${ message(err) }`;
      suspicious = true;
    }
    const delays = [1000, 3000, 6000];

    if (suspicious && retryAttempt < delays.length) {
      retryTimer = setTimeout(loadProviders, delays[retryAttempt++]);
    } else if (!suspicious) {
      retryAttempt = 0;
    }
  }

  function applyState(next: Partial<ProviderState>) {
    for (const key of Object.keys(state) as (keyof ProviderState)[]) {
      if (next[key] !== undefined) {
        state[key] = next[key] || (key === 'subconsciousProvider' ? 'default' : '');
      }
    }
  }

  function onStateChanged(_event: unknown, next: Partial<ProviderState>) {
    const primaryChanged = next.primaryProvider !== undefined && next.primaryProvider !== state.primaryProvider;

    applyState(next);
    if (primaryChanged) {
      void loadSlots();
    }
    void loadProviders();
  }

  function onVaultUnlocked() {
    loading.value = true;
    retryAttempt = 0;
    void Promise.all([loadProviders(), loadSlots()]).finally(() => { loading.value = false });
  }

  async function run(work: () => Promise<unknown>) {
    error.value = '';
    saved.value = false;
    try {
      await work();
      saved.value = true;
      if (savedTimer) clearTimeout(savedTimer);
      savedTimer = setTimeout(() => { saved.value = false }, 2_000);
    } catch (err) {
      error.value = message(err);
    }
  }

  /** Switch the main model's provider, keeping that provider's preferred model. */
  function setPrimaryProvider(id: string) {
    return run(async() => {
      const config = await ipcRenderer.invoke('model-provider:get-provider-config', id);

      applyState(await ipcRenderer.invoke('model-provider:select-model', id, config?.model || ''));
      await loadSlots();
    });
  }

  function setPrimaryModel(modelId: string) {
    return run(async() => {
      applyState(await ipcRenderer.invoke('model-provider:select-model', state.primaryProvider, modelId));
    });
  }

  function setSecondaryProvider(id: string) {
    return run(async() => {
      await ipcRenderer.invoke('model-provider:set-secondary', id);
      state.secondaryProvider = id;
      await Promise.all([loadModels('secondary'), loadAccounts('secondary')]);
    });
  }

  function setSecondaryModel(modelId: string) {
    return run(async() => {
      await ipcRenderer.invoke('model-provider:set-secondary-model', modelId);
      state.secondaryModelId = modelId;
    });
  }

  function setSubconsciousProvider(id: string) {
    return run(async() => {
      await ipcRenderer.invoke('model-provider:set-subconscious', id);
      state.subconsciousProvider = id || 'default';
      await Promise.all([loadModels('subconscious'), loadAccounts('subconscious')]);
    });
  }

  function setSubconsciousModel(modelId: string) {
    return run(async() => {
      await ipcRenderer.invoke('model-provider:set-subconscious-model', modelId);
      state.subconsciousModelId = modelId;
    });
  }

  /** Pick which saved connection (vault account) a slot's provider uses. */
  function setConnection(slot: ModelSlot, accountId: string) {
    return run(async() => {
      await ipcRenderer.invoke('model-provider:set-active-account', slotProvider(slot), accountId);
      await loadAccounts(slot);
    });
  }

  const runsLocally = computed(() => LOCAL_PROVIDERS.includes(state.primaryProvider));
  const localProvider = computed(() => providers.value.find(p => LOCAL_PROVIDERS.includes(p.id) && p.connected));
  const onlineProvider = computed(() => providers.value.find(p => !LOCAL_PROVIDERS.includes(p.id) && p.connected));

  /** "Where models run": move the main model between an online provider and Ollama. */
  function setWhere(where: 'online' | 'local') {
    const target = where === 'local' ? localProvider.value : onlineProvider.value;

    if (target && target.id !== state.primaryProvider) {
      return setPrimaryProvider(target.id);
    }
  }

  function onFocus() {
    void loadProviders();
    void Promise.all((['primary', 'secondary', 'subconscious'] as ModelSlot[]).map(loadAccounts));
  }

  onMounted(async() => {
    ipcRenderer.on('model-provider:state-changed', onStateChanged);
    ipcRenderer.on('vault:logged-in' as any, onVaultUnlocked);
    window.addEventListener('focus', onFocus);
    try {
      applyState(await ipcRenderer.invoke('model-provider:get-state'));
    } catch (err) {
      error.value = `Could not read the current models: ${ message(err) }`;
    }
    await loadProviders();
    await loadSlots();
    loading.value = false;
  });

  onBeforeUnmount(() => {
    ipcRenderer.removeListener('model-provider:state-changed', onStateChanged);
    ipcRenderer.removeListener('vault:logged-in' as any, onVaultUnlocked);
    window.removeEventListener('focus', onFocus);
    if (retryTimer) {
      clearTimeout(retryTimer);
    }
    if (savedTimer) {
      clearTimeout(savedTimer);
    }
  });

  return {
    state,
    providers,
    models,
    accounts,
    loading,
    error,
    saved,
    runsLocally,
    localProvider,
    onlineProvider,
    loadProviders,
    setPrimaryProvider,
    setPrimaryModel,
    setSecondaryProvider,
    setSecondaryModel,
    setSubconsciousProvider,
    setSubconsciousModel,
    setConnection,
    setWhere,
  };
}
