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
      accounts[slot] = await ipcRenderer.invoke('model-provider:get-accounts', id) || [];
    } catch {
      accounts[slot] = [];
    }
  }

  async function loadSlots() {
    const slots: ModelSlot[] = ['primary', 'secondary', 'subconscious'];

    await Promise.all(slots.flatMap(slot => [loadModels(slot), loadAccounts(slot)]));
  }

  /**
   * Show connected providers plus whichever provider a slot already uses, so
   * a select is never blank. An empty list usually means the vault wasn't
   * unlocked yet, so retry a few times before giving up.
   */
  async function loadProviders() {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = undefined;
    }
    let suspicious = false;

    try {
      const all = await ipcRenderer.invoke('model-provider:get-providers');
      const chosen = [state.primaryProvider, state.secondaryProvider, state.subconsciousProvider];
      const list: ProviderOption[] = (Array.isArray(all) ? all : [])
        .map(p => ({ id: p.id, name: p.name, connected: p.connected === true }))
        .filter(p => p.connected || chosen.includes(p.id));

      for (const id of chosen) {
        if (id && id !== 'default' && !list.some(p => p.id === id)) {
          list.push({ id, name: id, connected: false });
        }
      }
      list.sort((a, b) => Number(b.connected) - Number(a.connected));
      providers.value = list;
      suspicious = !list.some(p => p.connected);
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
  }

  async function run(work: () => Promise<unknown>) {
    error.value = '';
    try {
      await work();
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
    window.removeEventListener('focus', onFocus);
    if (retryTimer) {
      clearTimeout(retryTimer);
    }
  });

  return {
    state,
    providers,
    models,
    accounts,
    loading,
    error,
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
