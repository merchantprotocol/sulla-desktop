<script lang="ts">
import { defineComponent } from 'vue';

import { ipcRenderer } from '@pkg/utils/ipcRenderer';
import { IpcRendererEvent } from 'electron';

// Import soul prompt from TypeScript file
import { soulPrompt } from '../agent/prompts/soul';
import { heartbeatPrompt } from '../agent/prompts/heartbeat';
import { SullaSettingsModel } from '../agent/database/models/SullaSettingsModel';
import { REMOTE_PROVIDERS } from '../shared/remoteProviders';
import { getSupportedProviders, fetchModelsForProvider, clearModelCache } from '../agent/languagemodels';
import { LOCAL_MODELS } from '../shared/localModels';
import type { LocalModelOption } from '../shared/localModels';
import { useTheme } from '../composables/useTheme';

// Nav items for the Language Model Settings sidebar
const navItems = [
  { id: 'overview', name: 'Overview' },
  { id: 'models', name: 'Models' },
  { id: 'local-models', name: 'Local Models' },
  { id: 'soul', name: 'Soul' },
  { id: 'heartbeat', name: 'Heartbeat' },
];

// llama.cpp models sorted by resource requirements (smallest to largest)
const OLLAMA_MODELS = [
  {
    name: 'qwen2:0.5b', displayName: 'Qwen2 0.5B', size: '377MB', minMemoryGB: 1, minCPUs: 1, description: 'Alibaba\'s compact Qwen2 model, very lightweight',
  },
  {
    name: 'qwen3:0.6b', displayName: 'Qwen3 ASR 0.6B', size: '400MB', minMemoryGB: 1, minCPUs: 1, description: 'Alibaba\'s Qwen3 ASR model, optimized for speech recognition tasks',
  },
  {
    name: 'qwen2:1.5b', displayName: 'Qwen2 1.5B', size: '934MB', minMemoryGB: 2, minCPUs: 2, description: 'Alibaba\'s Qwen2 model, efficient for basic tasks',
  },
  {
    name: 'phi3:mini', displayName: 'Phi-3 Mini', size: '2.2GB', minMemoryGB: 4, minCPUs: 2, description: 'Microsoft\'s efficient 3.8B model, great reasoning capabilities',
  },
  {
    name: 'gemma:2b', displayName: 'Gemma 2B', size: '1.7GB', minMemoryGB: 4, minCPUs: 2, description: 'Google\'s lightweight model, good general performance',
  },
  {
    name: 'llama3.2:1b', displayName: 'Llama 3.2 1B', size: '1.3GB', minMemoryGB: 4, minCPUs: 2, description: 'Meta\'s smallest Llama 3.2, efficient and capable',
  },
  {
    name: 'llama3.2:3b', displayName: 'Llama 3.2 3B', size: '2.0GB', minMemoryGB: 4, minCPUs: 2, description: 'Meta\'s compact Llama 3.2, balanced performance',
  },
  {
    name: 'mistral:7b', displayName: 'Mistral 7B', size: '4.1GB', minMemoryGB: 5, minCPUs: 2, description: 'Excellent 7B model, strong coding and reasoning',
  },
  {
    name: 'qwen2:7b', displayName: 'Qwen2 7B', size: '4.4GB', minMemoryGB: 5, minCPUs: 2, description: 'Alibaba\'s Qwen2 7B model, strong performance',
  },
  {
    name: 'llama3.1:8b', displayName: 'Llama 3.1 8B', size: '4.7GB', minMemoryGB: 6, minCPUs: 2, description: 'Meta\'s latest 8B model, excellent all-around performance',
  },
  {
    name: 'huihui_ai/foundation-sec-8b-abliterated', displayName: 'Foundation-Sec 8B Abliterated', size: '5.0GB', minMemoryGB: 8, minCPUs: 2, description: 'Cisco\'s security-focused 8B — purpose-built for pentesting and vuln analysis, no refusals',
  },
  {
    name: 'huihui_ai/qwen3-abliterated:8b', displayName: 'Qwen3 8B Abliterated', size: '5.0GB', minMemoryGB: 8, minCPUs: 2, description: 'Qwen3 8B abliterated — strong at code and reasoning, no refusals',
  },
  {
    name: 'dolphin3', displayName: 'Dolphin 3.0 8B', size: '4.9GB', minMemoryGB: 8, minCPUs: 2, description: 'Eric Hartford\'s Dolphin 3.0 — uncensored Llama 3.1 8B, the OG unrestricted model',
  },
  {
    name: 'gemma:7b', displayName: 'Gemma 7B', size: '5.0GB', minMemoryGB: 6, minCPUs: 2, description: 'Google\'s larger model, improved capabilities',
  },
  {
    name: 'gemma4:e2b', displayName: 'Gemma 4 E2B', size: '3.1GB', minMemoryGB: 4, minCPUs: 2, description: 'Google\'s Gemma 4 E2B — multimodal (text+image+audio), ultralight',
  },
  {
    name: 'gemma4', displayName: 'Gemma 4 E4B', size: '9.6GB', minMemoryGB: 12, minCPUs: 2, description: 'Google\'s Gemma 4 E4B — multimodal (text+image+audio), recommended default',
  },
  {
    name: 'codellama:7b', displayName: 'Code Llama 7B', size: '3.8GB', minMemoryGB: 5, minCPUs: 2, description: 'Specialized for code generation and understanding',
  },
  {
    name: 'llama3.1:70b', displayName: 'Llama 3.1 70B', size: '40GB', minMemoryGB: 48, minCPUs: 8, description: 'Meta\'s flagship model, state-of-the-art performance',
  },
  {
    name: 'mixtral:8x7b', displayName: 'Mixtral 8x7B', size: '26GB', minMemoryGB: 32, minCPUs: 8, description: 'Mixture of experts, excellent quality and speed',
  },
  {
    name: 'deepseek-coder:33b', displayName: 'DeepSeek Coder 33B', size: '19GB', minMemoryGB: 24, minCPUs: 6, description: 'Advanced coding model, excellent for development',
  },
  {
    name: 'gemma4:26b', displayName: 'Gemma 4 26B-A4B', size: '18GB', minMemoryGB: 22, minCPUs: 4, description: 'Google\'s Gemma 4 MoE — only 3.8B params active, runs like a 4B at frontier quality',
  },
];

interface InstalledModel {
  name:        string;
  size:        number;
  modified_at: string;
  digest:      string;
}

export default defineComponent({
  name: 'language-model-settings',

  setup() {
    // Initialize theme system so this window receives theme changes
    const { currentTheme, isDark } = useTheme();

    return { currentTheme, isDark };
  },

  data() {
    return {
      currentNav:       'overview' as string,
      navItems,
      // Overview dashboard metrics
      containerStats: {
        cpuPercent:    0,
        memoryUsage:   0,
        memoryLimit:   0,
        memoryPercent: 0,
        status:        'unknown' as string,
      },
      statsInterval:         null as ReturnType<typeof setInterval> | null,
      loadingStats:          false,
      // Which tab is being viewed (local or remote)
      viewingTab:            'local' as 'local' | 'remote',
      // Which mode is currently active (saved in settings)
      activeMode:            'local' as 'local' | 'remote',
      // Local model settings
      activeModel:           'qwen2:0.5b', // The currently saved/active local model
      pendingModel:          'qwen2:0.5b', // The model selected in dropdown
      installedModels:       [] as InstalledModel[],
      loadingModels:         false,
      downloadingModel:      null as string | null,
      downloadProgress:      0,
      // Remote model settings
      remoteProviders:       REMOTE_PROVIDERS,
      selectedProvider:      'grok',
      selectedRemoteModel:   'grok-4-1-fast-reasoning',
      apiKey:                '',
      apiKeyVisible:         false,
      // Dynamic model loading
      dynamicModels:         {} as Record<string, { id: string; name: string; description: string; pricing?: string }[]>,
      loadingRemoteModels:   false,
      modelLoadError:        '' as string,
      remoteRetryCount:      3, // Number of retries before falling back to local LLM
      remoteTimeoutSeconds:  60, // Remote API timeout limit in seconds
      // Local llama.cpp settings
      localTimeoutSeconds:   600, // Local llama.cpp timeout limit in seconds
      localRetryCount:       2, // Number of retries for local llama.cpp
      // Model status tracking
      modelStatuses:         {} as Record<string, 'installed' | 'missing' | 'failed'>,
      checkingModelStatuses: false,
      // Heartbeat settings
      heartbeatEnabled:      true,
      heartbeatDelayMinutes: 15,
      heartbeatPrompt:       '',
      heartbeatProvider:     'default' as string, // 'default' = use primary provider, or a specific provider id

      // Soul prompt settings
      soulPrompt:      '',
      botName:         'Sulla',
      primaryUserName: '',

      // Default prompts for reset
      soulPromptDefault:      soulPrompt,
      heartbeatPromptDefault: heartbeatPrompt,

      // Primary / Secondary provider selection
      primaryProvider:      'ollama' as string,
      secondaryProvider:    'ollama' as string,
      availableProviders:   [{ id: 'ollama', name: 'llama.cpp (Local)' }] as { id: string; name: string }[],

      // Activation state
      activating:           false,
      activationError:      '' as string,
      savingSettings:       false,
      // Local llama-server state
      localServerRunning:   false,
      localServerEnabled:   true,
      togglingLocalServer:  false,

      // Guard flag to prevent feedback loop between primaryProvider watcher and IPC handler
      _suppressProviderWatch: false,

      // Local Models tab
      localModels:              LOCAL_MODELS,
      localModelDownloadStatus: {} as Record<string, boolean>,
      localModelSelected:       '' as string,
      localModelDownloading:      null as string | null,
      localModelDownloadProgress: 0,
      localModelError:            '' as string,
      localContextSize:           0 as number,
      loadingLocalModels:         false,
      activatedLocalModel:        '' as string,
      systemTotalMemoryGB:        0,
      systemAvailableMemoryGB:    0,
      systemAvailableDiskGB:      0,

    };
  },

  computed: {
    currentNavItem(): { id: string; name: string } {
      const item = this.navItems.find(item => item.id === this.currentNav) || this.navItems[0];
      console.log('computed currentNavItem:', item, 'currentNav:', this.currentNav);
      return item;
    },
    soulPromptEditor: {
      get(): string {
        return this.soulPrompt;
      },
      set(val: string) {
        this.soulPrompt = String(val || '');
      },
    },
    heartbeatPromptEditor: {
      get(): string {
        return this.heartbeatPrompt;
      },
      set(val: string) {
        this.heartbeatPrompt = String(val || '');
      },
    },
    availableModels(): { name: string; displayName: string; size: string; description: string }[] {
      return OLLAMA_MODELS;
    },
    pendingModelDescription(): string {
      const model = OLLAMA_MODELS.find(m => m.name === this.pendingModel);
      const desc = model?.description || '';
      console.log('computed pendingModelDescription:', desc, 'pendingModel:', this.pendingModel);
      return desc;
    },
    isPendingModelInstalled(): boolean {
      const installed = this.installedModels.some(m => m.name === this.pendingModel);
      console.log('computed isPendingModelInstalled:', installed, 'pendingModel:', this.pendingModel, 'installedModels:', this.installedModels.map(m => m.name));
      return installed;
    },
    isPendingDifferentFromActive(): boolean {
      return this.pendingModel !== this.activeModel;
    },
    formattedInstalledModels(): (InstalledModel & { formattedSize: string })[] {
      return this.installedModels.map(model => ({
        ...model,
        formattedSize: this.formatBytes(model.size),
      }));
    },
    currentProvider(): typeof REMOTE_PROVIDERS[0] | undefined {
      return this.remoteProviders.find(p => p.id === this.selectedProvider);
    },
    currentProviderModels(): { id: string; name: string; description: string; pricing?: string }[] {
      // Use dynamic models if available, fallback to static ones
      return this.dynamicModels[this.selectedProvider] || this.currentProvider?.models || [];
    },
    selectedRemoteModelDescription(): string {
      const model = this.currentProviderModels.find(m => m.id === this.selectedRemoteModel);

      return model?.description || '';
    },
    formattedMemoryUsage(): string {
      return this.formatBytes(this.containerStats.memoryUsage);
    },
    formattedMemoryLimit(): string {
      return this.formatBytes(this.containerStats.memoryLimit);
    },
    // Key model status getters
    embeddingModelStatus(): 'installed' | 'missing' | 'failed' {
      return this.modelStatuses['nomic-embed-text'] || 'missing';
    },
    defaultModelStatus(): 'installed' | 'missing' | 'failed' {
      const status = this.modelStatuses[this.activeModel] || 'missing';
      console.log('computed defaultModelStatus:', status, 'activeModel:', this.activeModel, 'modelStatuses:', this.modelStatuses);
      return status;
    },
    hasDownloadedModels(): boolean {
      return this.installedModels.length > 0;
    },
  },

  async mounted() {
    console.log('LanguageModelSettings mounted');
    // Listen for settings write errors from main process
    ipcRenderer.on('settings-write-error', (_event: unknown, error: any) => {
      console.error('[LM Settings] Settings write error from main process:', error);
      this.activationError = `Failed to save settings: ${ error?.message || 'Unknown error' }`;
    });

    this.activeMode = await SullaSettingsModel.get('activeMode', 'local');

    // Listen for state changes from ModelProviderService (source of truth)
    ipcRenderer.on('model-provider:state-changed', this.handleProviderStateChanged);
    // Legacy listener for backward compat
    ipcRenderer.on('model-changed', this.handleModelChanged);

    // Load all settings from database
    // Soul and heartbeat prompts are now managed via agent config .md files.
    // Keeping defaults for backwards compatibility with UI references.
    this.soulPrompt = soulPrompt;
    this.heartbeatPrompt = heartbeatPrompt;
    this.heartbeatProvider = await SullaSettingsModel.get('heartbeatProvider', 'default');
    this.heartbeatDelayMinutes = await SullaSettingsModel.get('heartbeatDelayMinutes', 15);
    this.botName = await SullaSettingsModel.get('botName', 'Sulla');
    this.primaryUserName = await SullaSettingsModel.get('primaryUserName', '');
    // Load provider/model state from ModelProviderService (source of truth)
    try {
      const mpsState = await ipcRenderer.invoke('model-provider:get-state');
      this.activeMode = mpsState.modelMode;
      this.viewingTab = mpsState.modelMode;
      this.primaryProvider = mpsState.primaryProvider;
      this.secondaryProvider = mpsState.secondaryProvider;
      this.activeModel = mpsState.activeModelId;
      this.pendingModel = mpsState.activeModelId;

      // Load the provider-specific config (API key, selected model, etc.)
      if (mpsState.primaryProvider !== 'ollama') {
        const config = await ipcRenderer.invoke('model-provider:get-provider-config', mpsState.primaryProvider);
        this.selectedProvider = mpsState.primaryProvider;
        this.selectedRemoteModel = mpsState.activeModelId;
        this.apiKey = config.api_key || '';
      } else {
        // Load remote provider config separately for when user switches tabs
        this.selectedProvider = await SullaSettingsModel.get('remoteProvider', 'grok');
        this.selectedRemoteModel = await SullaSettingsModel.get('remoteModel', 'grok-4-1-fast-reasoning');
        this.apiKey = await SullaSettingsModel.get('remoteApiKey', '');
      }
    } catch (err) {
      console.warn('[LM Settings] Failed to load from ModelProviderService, falling back:', err);
      this.activeMode = (await SullaSettingsModel.get('modelMode', 'local')) as 'local' | 'remote';
      const mode = typeof this.activeMode === 'string' ? this.activeMode.replace(/^"|"$/g, '') : this.activeMode;
      this.activeMode = (mode === 'local' || mode === 'remote') ? mode : 'local';
      this.viewingTab = this.activeMode;
      this.selectedProvider = await SullaSettingsModel.get('remoteProvider', 'grok');
      this.selectedRemoteModel = await SullaSettingsModel.get('remoteModel', 'grok-4-1-fast-reasoning');
      this.apiKey = await SullaSettingsModel.get('remoteApiKey', '');
    }
    this.remoteRetryCount = await SullaSettingsModel.get('remoteRetryCount', 3);
    this.remoteTimeoutSeconds = Number(await SullaSettingsModel.get('remoteTimeoutSeconds', 60));
    this.localTimeoutSeconds = await SullaSettingsModel.get('localTimeoutSeconds', 600);
    this.localRetryCount = await SullaSettingsModel.get('localRetryCount', 2);
    this.heartbeatEnabled = await SullaSettingsModel.get('heartbeatEnabled', true);

    console.log('Loaded settings values:', {
      activeMode:           this.activeMode,
      viewingTab:           this.viewingTab,
      selectedProvider:     this.selectedProvider,
      selectedRemoteModel:  this.selectedRemoteModel,
      remoteTimeoutSeconds: this.remoteTimeoutSeconds,
      localTimeoutSeconds:  this.localTimeoutSeconds,
      remoteRetryCount:     this.remoteRetryCount,
      localRetryCount:      this.localRetryCount,
    });

    // Build available providers list from ModelProviderService
    try {
      const providers = await ipcRenderer.invoke('model-provider:get-providers');
      this.availableProviders = providers.map((p: { id: string; name: string }) => ({
        id: p.id, name: p.id === 'ollama' ? 'llama.cpp (Local)' : p.name,
      }));
    } catch (err) {
      console.warn('[LM Settings] Failed to load available providers:', err);
    }

    await this.loadModels();

    // Load remote models if API key exists
    if (this.selectedProvider && this.apiKey.trim()) {
      await this.loadRemoteModels();
    }

    // Listen for download progress events from main process
    ipcRenderer.on('local-model-download-progress', (
      _event: unknown,
      data: { modelKey: string; received: number; total: number; percent: number },
    ) => {
      if (data.modelKey === this.localModelDownloading) {
        this.localModelDownloadProgress = data.percent;
      }
    });

    // Load persisted local server enabled preference
    try {
      const savedEnabled = await SullaSettingsModel.get('localServerEnabled', '');
      if (savedEnabled === 'true' || savedEnabled === 'false') {
        this.localServerEnabled = savedEnabled === 'true';
      } else {
        // No saved preference — derive from current mode
        this.localServerEnabled = this.activeMode !== 'remote';
      }
    } catch {
      this.localServerEnabled = this.activeMode !== 'remote';
    }
    try {
      const status = await ipcRenderer.invoke('llama-server:status');
      this.localServerRunning = status?.running ?? false;
    } catch {
      this.localServerRunning = false;
    }

    // Load system resource info for fitness indicators
    this.loadSystemResources();

    // Load which local model is currently activated
    if (this.activeModel && LOCAL_MODELS.some(m => m.name === this.activeModel)) {
      this.activatedLocalModel = this.activeModel;
    }

    ipcRenderer.send('dialog/ready');
  },

  watch: {
    // Watch for API key changes to automatically load models
    async apiKey(newApiKey: string, oldApiKey: string) {
      if (newApiKey && newApiKey.trim() && newApiKey !== oldApiKey && this.selectedProvider) {
        await this.loadRemoteModels();
      }
    },

    // Watch for provider changes to automatically load models
    async selectedProvider(newProvider: string, oldProvider: string) {
      if (newProvider && newProvider !== oldProvider && this.apiKey.trim()) {
        await this.loadRemoteModels();
      }
    },

    // Watch for primary provider changes — delegate to ModelProviderService
    async primaryProvider(newProvider: string, oldProvider: string) {
      if (!newProvider || newProvider === oldProvider) return;
      if (this._suppressProviderWatch) {
        this._suppressProviderWatch = false;
        return;
      }

      try {
        // Read the current model for this provider from the service
        const config = await ipcRenderer.invoke('model-provider:get-provider-config', newProvider);
        const preferredModel = config.model || '';

        // Tell the source of truth — it persists, broadcasts, and manages llama-server
        const newState = await ipcRenderer.invoke('model-provider:select-model', newProvider, preferredModel);

        this.activeMode = newState.modelMode;
        this.viewingTab = newState.modelMode;
        this.activeModel = newState.activeModelId;
        if (newProvider !== 'ollama') {
          this.selectedProvider = newProvider;
          this.selectedRemoteModel = newState.activeModelId;
        }
      } catch (err) {
        console.error('[LM Settings] Failed to change primary provider via service:', err);
      }
    },
  },

  beforeUnmount() {
    // Clean up IPC listeners
    ipcRenderer.removeAllListeners('settings-write-error');
    ipcRenderer.removeAllListeners('model-provider:state-changed');
    ipcRenderer.removeAllListeners('model-changed');
    ipcRenderer.removeAllListeners('local-model-download-progress');
  },

  methods: {
    // Silent fetch that doesn't log network errors to console
    silentFetch(url: string, options: RequestInit = {}): Promise<Response | null> {
      return new Promise((resolve) => {
        const xhr = new XMLHttpRequest();
        xhr.open(options.method || 'GET', url);

        // Set headers
        if (options.headers) {
          for (const [key, value] of Object.entries(options.headers)) {
            xhr.setRequestHeader(key, value as string);
          }
        }

        // Set timeout
        if (options.signal) {
          // For AbortSignal, we can't directly set timeout, but we can use a timer
          const timeoutId = setTimeout(() => {
            xhr.abort();
            resolve(null);
          }, 5000); // Default 5s timeout

          xhr.onload = () => {
            clearTimeout(timeoutId);
            // Convert XMLHttpRequest to Response-like object
            const response = {
              ok:         xhr.status >= 200 && xhr.status < 300,
              status:     xhr.status,
              statusText: xhr.statusText,
              text:       () => Promise.resolve(xhr.responseText),
              json:       () => Promise.resolve(JSON.parse(xhr.responseText || '{}')),
              body:       null, // Not supported
            };
            resolve(response as any);
          };

          xhr.onerror = () => {
            clearTimeout(timeoutId);
            resolve(null);
          };

          xhr.ontimeout = () => {
            clearTimeout(timeoutId);
            resolve(null);
          };
        } else {
          xhr.timeout = 5000; // Default timeout
          xhr.onload = () => {
            const response = {
              ok:         xhr.status >= 200 && xhr.status < 300,
              status:     xhr.status,
              statusText: xhr.statusText,
              text:       () => Promise.resolve(xhr.responseText),
              json:       () => Promise.resolve(JSON.parse(xhr.responseText || '{}')),
              body:       null,
            };
            resolve(response as any);
          };

          xhr.onerror = () => resolve(null);
          xhr.ontimeout = () => resolve(null);
        }

        // Send request
        if (options.body) {
          xhr.send(options.body as string);
        } else {
          xhr.send();
        }
      });
    },
    navClicked(navId: string) {
      console.log('navClicked called with navId:', navId, 'current viewingTab:', this.viewingTab);
      this.currentNav = navId;
      console.log('currentNav set to:', this.currentNav);
      if (navId === 'overview') {
        this.fetchContainerStats();
      } else if (navId === 'models') {
        this.loadModels();
        this.fetchContainerStats();
        this.checkModelStatuses();
        console.log('After models nav, viewingTab:', this.viewingTab);
      } else if (navId === 'local-models') {
        this.loadLocalModelStatuses();
      }
    },

    async fetchContainerStats() {
      try {
        // Query llama.cpp API for service status and running models
        const [tagsRes, psRes] = await Promise.all([
          this.silentFetch('http://127.0.0.1:30114/api/tags', { signal: AbortSignal.timeout(3000) }),
          this.silentFetch('http://127.0.0.1:30114/api/ps', { signal: AbortSignal.timeout(3000) }),
        ]);

        if (!tagsRes?.ok) {
          this.containerStats.status = 'offline';

          return;
        }

        this.containerStats.status = 'running';

        // Get running models info from /api/ps
        if (psRes && psRes.ok) {
          const psData = await psRes.json();
          const runningModels = psData.models || [];

          if (runningModels.length > 0) {
            // Sum up memory usage from all running models
            let totalSize = 0;
            let totalVramSize = 0;

            for (const model of runningModels) {
              totalSize += model.size || 0;
              totalVramSize += model.size_vram || 0;
            }

            // Use model size as memory indicator (actual VRAM/RAM used)
            this.containerStats.memoryUsage = totalVramSize || totalSize;
            // Estimate limit based on typical system (this is approximate)
            this.containerStats.memoryLimit = 16 * 1024 * 1024 * 1024; // 16GB default
            this.containerStats.memoryPercent = (this.containerStats.memoryUsage / this.containerStats.memoryLimit) * 100;

            // Store running model count for display
            (this.containerStats as Record<string, unknown>).runningModels = runningModels.length;
            (this.containerStats as Record<string, unknown>).modelDetails = runningModels.map((m: { name: string; size: number }) => ({
              name:  m.name,
              size:  m.size,
            }));
          } else {
            this.containerStats.memoryUsage = 0;
            this.containerStats.memoryPercent = 0;
            (this.containerStats as Record<string, unknown>).runningModels = 0;
            (this.containerStats as Record<string, unknown>).modelDetails = [];
          }
        }
      } catch (err) {
        console.warn('[LM Settings] Failed to fetch llama.cpp stats:', err);
        this.containerStats.status = 'error';
      }
    },

    formatBytes(bytes: number): string {
      if (bytes === 0) {
        return '0 B';
      }
      const k = 1024;
      const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
      const i = Math.floor(Math.log(bytes) / Math.log(k));

      return `${ parseFloat((bytes / Math.pow(k, i)).toFixed(1)) } ${ sizes[i] }`;
    },

    // Models tab methods
    async loadModels() {
      this.loadingModels = true;
      try {
        const res = await this.silentFetch('http://127.0.0.1:30114/api/tags', {
          signal: AbortSignal.timeout(5000),
        });

        if (res && res.ok) {
          const data = await res.json();

          this.installedModels = data.models || [];
        }
      } catch (err) {
        console.error('Failed to load models:', err);
      } finally {
        this.loadingModels = false;
      }
    },

    async downloadPendingModel() {
      await this.pullModel(this.pendingModel);
    },

    async pullModel(modelName: string) {
      this.downloadingModel = modelName;
      this.downloadProgress = 0;

      try {
        const res = await fetch('http://127.0.0.1:30114/api/pull', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ name: modelName, stream: true }),
        });

        if (!res.ok || !res.body) {
          console.error('Failed to download model:', res.status);

          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();

        while (true) {
          const { done, value } = await reader.read();

          if (done) {
            break;
          }

          const text = decoder.decode(value, { stream: true });
          const lines = text.split('\n').filter(line => line.trim());

          for (const line of lines) {
            try {
              const data = JSON.parse(line);

              if (data.total && data.completed) {
                this.downloadProgress = Math.round((data.completed / data.total) * 100);
              } else if (data.status === 'success') {
                this.downloadProgress = 100;
              }
            } catch {
              // Ignore parse errors for partial JSON
            }
          }
        }

        await this.loadModels();
        // After successful download, activate the model
        this.activateModel();
      } catch (err) {
        console.error('Error downloading model:', err);
      } finally {
        this.downloadingModel = null;
        this.downloadProgress = 0;
      }
    },

    async activateModel() {
      // Save the pending model as the active model
      this.activeModel = this.pendingModel;
      try {
        await SullaSettingsModel.set('sullaModel', this.pendingModel, 'string');
        console.log(`[LM Settings] Model activated: ${ this.pendingModel }`);
      } catch (err) {
        console.error('Failed to save model setting:', err);
      }
    },

    // Remote model methods
    async onProviderChange() {
      // Clear current model selection
      this.selectedRemoteModel = '';

      // Load models for the new provider if we have an API key
      if (this.apiKey.trim()) {
        await this.loadRemoteModels();
      } else {
        // Use static fallback if no API key
        const provider = this.remoteProviders.find(p => p.id === this.selectedProvider);
        if (provider && provider.models.length > 0) {
          this.selectedRemoteModel = provider.models[0].id;
        }
      }
    },

    async loadRemoteModels() {
      if (!this.selectedProvider || !this.apiKey.trim()) {
        return;
      }

      this.loadingRemoteModels = true;
      this.modelLoadError = '';

      try {
        const modelList = await fetchModelsForProvider(this.selectedProvider, this.apiKey);

        // Transform models to match expected format
        const transformedModels = modelList.map(modelInfo => ({
          id:          modelInfo.id,
          name:        modelInfo.name,
          description: modelInfo.description || `${ modelInfo.name } model`,
          pricing:     modelInfo.pricing
            ? `Input: $${ modelInfo.pricing.input || 0 }/1M tokens, Output: $${ modelInfo.pricing.output || 0 }/1M tokens`
            : undefined,
        }));

        this.dynamicModels[this.selectedProvider] = transformedModels;

        // Auto-select first model if none selected
        if (transformedModels.length > 0 && (!this.selectedRemoteModel || !transformedModels.find(m => m.id === this.selectedRemoteModel))) {
          this.selectedRemoteModel = transformedModels[0].id;
        }
      } catch (error) {
        this.modelLoadError = `Failed to load models: ${ error instanceof Error ? error.message : String(error) }`;
        console.error('[LM Settings] Failed to load remote models:', error);

        // Fallback to static models on error
        const provider = this.remoteProviders.find(p => p.id === this.selectedProvider);
        if (provider && provider.models.length > 0 && !this.selectedRemoteModel) {
          this.selectedRemoteModel = provider.models[0].id;
        }
      } finally {
        this.loadingRemoteModels = false;
      }
    },

    async refreshRemoteModels() {
      if (!this.selectedProvider || !this.apiKey.trim()) {
        return;
      }

      try {
        // Clear the cache for this provider
        clearModelCache(this.selectedProvider);

        // Clear current models and reload
        this.dynamicModels[this.selectedProvider] = [];
        this.selectedRemoteModel = '';

        // Force reload models from API
        await this.loadRemoteModels();
      } catch (error) {
        this.modelLoadError = `Failed to refresh models: ${ error instanceof Error ? error.message : String(error) }`;
        console.error('[LM Settings] Model refresh failed:', error);
      }
    },

    async activateLocalModel() {
      this.activating = true;
      this.activationError = '';

      try {
        // Check if llama.cpp is running
        const ollamaRes = await this.silentFetch('http://127.0.0.1:30114/api/tags', {
          signal: AbortSignal.timeout(5000),
        });

        if (!ollamaRes?.ok) {
          this.activationError = 'Cannot connect to llama.cpp. Make sure the service is running.';

          return;
        }

        // Check if selected model is installed
        if (!this.isPendingModelInstalled) {
          this.activationError = `Model "${ this.pendingModel }" is not installed. Please download it first.`;

          return;
        }

        // Tell the source of truth — it persists, broadcasts, and manages llama-server
        const newState = await ipcRenderer.invoke('model-provider:select-model', 'ollama', this.pendingModel);
        // Save non-model settings (timeouts, retry counts, etc.)
        await this.writeExperimentalSettings();

        this.activeMode = newState.modelMode;
        this.viewingTab = 'local';
        this.activeModel = newState.activeModelId;
        console.log(`[LM Settings] Local model activated: ${ newState.activeModelId }`);
      } catch (err) {
        this.activationError = 'Failed to connect to llama.cpp. Is the service running?';
        console.error('Failed to activate local model:', err);
      } finally {
        this.activating = false;
      }
    },

    async activateRemoteModel() {
      this.activating = true;
      this.activationError = '';

      try {
        // Validate API key
        if (!this.apiKey.trim()) {
          this.activationError = 'Please enter an API key.';

          return;
        }

        // Test connection to remote API
        const provider = this.currentProvider;

        if (!provider) {
          this.activationError = 'Invalid provider selected.';

          return;
        }

        // Try a simple API call to validate the key
        const timeoutMs = Math.max(1000, Math.min(300, this.remoteTimeoutSeconds)) * 1000;

        if (provider.id === 'grok' || provider.id === 'openai' || provider.id === 'kimi' || provider.id === 'nvidia') {
          const testUrl = `${ provider.baseUrl }/chat/completions`;
          const testBody = {
            model:       this.selectedRemoteModel,
            messages:    [{ role: 'user', content: 'Reply with the word: OK' }],
            temperature: 0,
            max_tokens:  10,
          };

          console.log('[Remote Test] Provider:', provider.id);
          console.log('[Remote Test] URL:', testUrl);
          console.log('[Remote Test] Model:', this.selectedRemoteModel);
          console.log('[Remote Test] API Key starts with:', this.apiKey.substring(0, 10) + '...');

          try {
            const testRes = await fetch(testUrl, {
              method:  'POST',
              headers: {
                'Content-Type':  'application/json',
                Authorization:   `Bearer ${ this.apiKey }`,
              },
              body:    JSON.stringify(testBody),
              signal:  AbortSignal.timeout(timeoutMs),
            });

            if (!testRes.ok) {
              const errorText = await testRes.text();
              console.error('[Remote Test] Error response:', testRes.status, errorText);

              this.activationError = `Remote model test failed: ${ testRes.status }. Check model, key, and timeout.`;
              console.error('Remote model test error:', errorText);

              return;
            }
          } catch (err) {
            this.activationError = 'Remote model test failed (timeout/network). Check connection, API key, and timeout.';
            console.error('Remote model test error:', err);

            return;
          }
        } else if (provider.id === 'anthropic') {
          const testUrl = `${ provider.baseUrl }/messages`;
          const testBody = {
            model:      this.selectedRemoteModel,
            max_tokens: 10,
            messages:   [{ role: 'user', content: 'Reply with the word: OK' }],
          };

          console.log('[Remote Test] Provider:', provider.id);
          console.log('[Remote Test] URL:', testUrl);
          console.log('[Remote Test] Model:', this.selectedRemoteModel);
          console.log('[Remote Test] API Key starts with:', this.apiKey.substring(0, 10) + '...');

          try {
            const testRes = await fetch(testUrl, {
              method:  'POST',
              headers: {
                'Content-Type':      'application/json',
                'x-api-key':         this.apiKey,
                'anthropic-version': '2023-06-01',
              },
              body:   JSON.stringify(testBody),
              signal: AbortSignal.timeout(timeoutMs),
            });

            if (!testRes.ok) {
              const errorText = await testRes.text();
              console.error('[Remote Test] Error response:', testRes.status, errorText);

              this.activationError = `Remote model test failed: ${ testRes.status }. Check model, key, and timeout.`;
              console.error('Remote model test error:', errorText);

              return;
            }
          } catch (err) {
            this.activationError = 'Remote model test failed (timeout/network). Check connection, API key, and timeout.';
            console.error('Remote model test error:', err);

            return;
          }
        } else {
          this.activationError = 'Remote provider test is not supported for this provider yet.';

          return;
        }

        // Save provider config (API key, model) via the source of truth
        await ipcRenderer.invoke('model-provider:update-provider-config', this.selectedProvider, {
          api_key:  this.apiKey,
          model:    this.selectedRemoteModel,
        });

        // Tell the source of truth — it persists, broadcasts, and manages llama-server
        const newState = await ipcRenderer.invoke('model-provider:select-model', this.selectedProvider, this.selectedRemoteModel);
        // Save non-model settings (timeouts, retry counts, etc.)
        await this.writeExperimentalSettings();

        this.activeMode = newState.modelMode;
        this.viewingTab = 'remote';
        this.activeModel = newState.activeModelId;
        console.log(`[LM Settings] Remote model activated: ${ this.selectedProvider }/${ this.selectedRemoteModel }`);
      } catch (err) {
        this.activationError = 'Failed to save remote settings.';
        console.error('Failed to activate remote model:', err);
      } finally {
        this.activating = false;
      }
    },

    async toggleLocalServer() {
      this.togglingLocalServer = true;
      this.activationError = '';
      try {
        if (this.localServerEnabled) {
          // Disable — stop the server, then save preference
          await ipcRenderer.invoke('llama-server:stop');
          await SullaSettingsModel.set('localServerEnabled', 'false', 'string');
          this.localServerEnabled = false;
          this.localServerRunning = false;
          console.log('[LM Settings] Local model server disabled');
        } else {
          // Enable — start the server first, only persist on success
          const result = await ipcRenderer.invoke('llama-server:start');

          if (!result?.running) {
            this.activationError = result?.error
              ? `Local model server failed: ${ result.error }`
              : 'Local model server failed to start.';

            return;
          }
          await SullaSettingsModel.set('localServerEnabled', 'true', 'string');
          this.localServerEnabled = true;
          this.localServerRunning = true;
          console.log('[LM Settings] Local model server enabled');
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);

        console.error('[LM Settings] Failed to toggle local server:', msg);
        this.activationError = `Failed to ${ this.localServerEnabled ? 'stop' : 'start' } local model server: ${ msg }`;
      } finally {
        this.togglingLocalServer = false;
      }
    },

    async checkModelStatuses() {
      this.checkingModelStatuses = true;
      try {
        // Server availability already checked in loadModels(), proceed with model checks

        // Check status of key models by checking against installed models list
        const keyModels = ['nomic-embed-text', this.activeModel].filter((model, index, arr) => arr.indexOf(model) === index);

        for (const modelName of keyModels) {
          try {
            // Check if model is in the installed models list from /api/tags
            const isInstalled = this.installedModels.some(model => model.name === modelName);
            this.modelStatuses[modelName] = isInstalled ? 'installed' : 'missing';
          } catch (error) {
            // Silently handle errors - don't log or break the interface
            this.modelStatuses[modelName] = 'failed';
          }
        }
      } catch (error) {
        // If the entire loop fails, silently continue
      } finally {
        this.checkingModelStatuses = false;
      }
    },

    async redownloadModel(modelName: string) {
      await this.pullModel(modelName);
      // Re-check statuses after download
      await this.checkModelStatuses();
    },

    async redownloadEmbeddingModel() {
      await this.redownloadModel('nomic-embed-text');
    },

    async redownloadDefaultModel() {
      await this.redownloadModel(this.activeModel);
    },

    async saveSettings() {
      if (this.savingSettings) {
        return;
      }

      this.savingSettings = true;
      try {
        await this.writeExperimentalSettings();
        // Soul and heartbeat prompts are now managed via agent config .md files.
        // No longer saved to database settings.
        console.log('[LM Settings] Settings saved');
      } catch (err) {
        console.error('Failed to save LM settings:', err);
      } finally {
        this.savingSettings = false;
      }
    },

    async writeExperimentalSettings(extra: Record<string, unknown> = {}) {
      try {
        // Save non-model settings to database.
        // Model/provider settings are owned by ModelProviderService.
        const settingsToSave = {
          botName:               String(this.botName || ''),
          primaryUserName:       String(this.primaryUserName || ''),
          remoteRetryCount:      Number(this.remoteRetryCount) || 3,
          remoteTimeoutSeconds:  Number(this.remoteTimeoutSeconds) || 60,
          localTimeoutSeconds:   Number(this.localTimeoutSeconds) || 600,
          localRetryCount:       Number(this.localRetryCount) || 2,
          heartbeatEnabled:      Boolean(this.heartbeatEnabled),
          heartbeatDelayMinutes: Number(this.heartbeatDelayMinutes) || 15,
          heartbeatPrompt:       String(this.heartbeatPrompt || ''),
          heartbeatProvider:     String(this.heartbeatProvider || 'default'),
          ...extra,
        };

        // Define cast types for settings
        const settingCasts: Record<string, string> = {
          remoteRetryCount:      'number',
          remoteTimeoutSeconds:  'number',
          localTimeoutSeconds:   'number',
          localRetryCount:       'number',
          heartbeatDelayMinutes: 'number',
          heartbeatEnabled:      'boolean',
        };

        for (const [key, value] of Object.entries(settingsToSave)) {
          const cast = settingCasts[key];
          await SullaSettingsModel.set(key, value, cast);
        }
      } catch (err) {
        console.error('[LM Settings] Error in writeExperimentalSettings:', err);
        throw err;
      }
    },

    async loadSystemResources() {
      try {
        const result: { totalMemoryGB: number; availableMemoryGB: number; availableDiskGB: number } =
          await ipcRenderer.invoke('system-resources');

        this.systemTotalMemoryGB = result.totalMemoryGB;
        this.systemAvailableMemoryGB = result.availableMemoryGB;
        this.systemAvailableDiskGB = result.availableDiskGB;
      } catch (err) {
        console.warn('[LM Settings] Failed to load system resources:', err);
      }
    },

    resourceFitness(model: LocalModelOption): 'green' | 'yellow' | 'red' {
      const totalMem = this.systemTotalMemoryGB;
      const availDisk = this.systemAvailableDiskGB;

      if (totalMem === 0) return 'green';

      let sizeGB = 0;

      if (model.size.endsWith('GB')) {
        sizeGB = parseFloat(model.size);
      } else if (model.size.endsWith('MB')) {
        sizeGB = parseFloat(model.size) / 1024;
      }

      if (totalMem < model.minMemoryGB || (availDisk > 0 && availDisk < sizeGB)) {
        return 'red';
      }

      const memHeadroom = totalMem - model.minMemoryGB;
      const diskHeadroom = availDisk > 0 ? availDisk - sizeGB : 999;

      if (memHeadroom < 4 || diskHeadroom < sizeGB) {
        return 'yellow';
      }

      return 'green';
    },

    resourceFitnessLabel(model: LocalModelOption): string {
      const fit = this.resourceFitness(model);

      if (fit === 'green') return 'Resources OK';
      if (fit === 'yellow') return 'Tight fit';

      return 'Insufficient';
    },

    async loadLocalModelStatuses() {
      this.loadingLocalModels = true;
      this.localModelError = '';
      try {
        const status: Record<string, boolean> = await ipcRenderer.invoke('local-models-status');
        this.localModelDownloadStatus = status;

        // Use the current active model if it's a local GGUF model
        if (this.activeModel && LOCAL_MODELS.some(m => m.name === this.activeModel)) {
          this.localModelSelected = this.activeModel;
          // Initialize context slider for the active model
          await this.selectLocalModel(this.activeModel);
        }
      } catch (err) {
        console.error('[LM Settings] Failed to load local model statuses:', err);
        this.localModelError = 'Failed to load model statuses.';
      } finally {
        this.loadingLocalModels = false;
      }
    },

    async selectLocalModel(modelName: string) {
      this.localModelSelected = modelName;
      this.localModelError = '';

      // Calculate max achievable context for this model given available RAM
      const model = this.localModels.find((m: LocalModelOption) => m.name === modelName);
      if (model) {
        const saved = await SullaSettingsModel.get('localContextSize', 0);
        if (saved > 0) {
          this.localContextSize = Math.min(Number(saved), this.maxContextForModel(model));
        } else {
          this.localContextSize = this.maxContextForModel(model);
        }
      }
    },

    maxContextForModel(model: LocalModelOption): number {
      const totalRam = this.systemTotalMemoryGB * 1e9;
      const osOverhead = 2 * 1024 * 1024 * 1024;
      const available = totalRam - model.sizeBytes - osOverhead;
      if (available <= 0) return 2048;
      let ctx = Math.floor(available / model.kvBytesPerToken);
      ctx = Math.floor(ctx / 1024) * 1024;
      return Math.max(2048, Math.min(model.nativeCtx, ctx));
    },

    async downloadLocalModel(modelName: string) {
      this.localModelDownloading = modelName;
      this.localModelDownloadProgress = 0;
      this.localModelError = '';
      try {
        await ipcRenderer.invoke('local-model-download', modelName);
        this.localModelDownloadStatus[modelName] = true;
        this.localModelDownloadProgress = 100;
      } catch (err) {
        console.error('[LM Settings] Failed to download local model:', err);
        this.localModelError = `Failed to download ${ modelName }. Check your internet connection.`;
      } finally {
        this.localModelDownloading = null;
        this.localModelDownloadProgress = 0;
      }
    },

    async activateSelectedGgufModel() {
      if (!this.localModelSelected) return;
      this.localModelError = '';
      try {
        // Save the user's context size preference before activating
        if (this.localContextSize > 0) {
          await SullaSettingsModel.set('localContextSize', this.localContextSize, 'number');
        }

        // Tell the source of truth — it persists, broadcasts, and manages llama-server
        const newState = await ipcRenderer.invoke('model-provider:select-model', 'ollama', this.localModelSelected);

        this._suppressProviderWatch = true;
        this.primaryProvider = newState.primaryProvider;
        this.activeMode = newState.modelMode;
        this.activeModel = newState.activeModelId;
        this.activatedLocalModel = this.localModelSelected;

        console.log(`[LM Settings] Local GGUF model activated: ${ this.localModelSelected } (ctx=${ this.localContextSize })`);
      } catch (err) {
        console.error('[LM Settings] Failed to activate local GGUF model:', err);
        this.localModelError = 'Failed to activate model.';
      }
    },

    closeWindow() {
      window.close();
    },

    // Handle state changes from ModelProviderService (source of truth)
    handleProviderStateChanged(
      _event: IpcRendererEvent,
      state: { primaryProvider: string; activeModelId: string; modelMode: 'local' | 'remote' },
    ) {
      this.activeModel = state.activeModelId;
      this.activeMode = state.modelMode;
      this.pendingModel = state.activeModelId;
      if (state.modelMode === 'remote') {
        this.selectedProvider = state.primaryProvider;
        this.selectedRemoteModel = state.activeModelId;
      }
      // Suppress watcher to avoid IPC loop
      if (this.primaryProvider !== state.primaryProvider) {
        this._suppressProviderWatch = true;
        this.primaryProvider = state.primaryProvider;
      }
    },

    // Legacy handler for backward compat
    handleModelChanged(_event: IpcRendererEvent, data: { model: string; type: 'local' } | { model: string; type: 'remote'; provider: string }) {
      this.activeModel = data.model;
      this.activeMode = data.type;
      if (data.type === 'remote' && (data as any).provider) {
        this.selectedProvider = (data as any).provider;
        this.selectedRemoteModel = data.model;
      }
      this.pendingModel = this.activeModel;
      const newPrimary = data.type === 'local' ? 'ollama' : (data as any).provider || 'ollama';
      if (this.primaryProvider !== newPrimary) {
        this._suppressProviderWatch = true;
        this.primaryProvider = newPrimary;
      }
    },

  },
});
</script>

<template>
  <div class="lm-settings">
    <!-- Header -->
    <div class="lm-header">
      <h1>Language Model Settings</h1>
    </div>

    <!-- Main content with sidebar -->
    <div class="lm-content">
      <!-- Sidebar navigation -->
      <nav class="lm-nav">
        <div
          v-for="item in navItems"
          :key="item.id"
          class="nav-item"
          :class="{ active: currentNav === item.id }"
          @click="navClicked(item.id)"
        >
          {{ item.name }}
        </div>
      </nav>

      <!-- Content area -->
      <div class="lm-body">
        <!-- Overview Tab -->
        <div
          v-if="currentNav === 'overview'"
          class="tab-content"
        >
          <h2>Local Model Server Status</h2>
          <p class="description">
            Monitor the resource usage of your local llama.cpp server.
          </p>

          <!-- Status Badge -->
          <div class="status-section">
            <span class="status-label">Status:</span>
            <span
              class="status-badge"
              :class="{
                'status-running': containerStats.status === 'running',
                'status-stopped': containerStats.status === 'exited' || containerStats.status === 'stopped',
                'status-error': containerStats.status === 'error' || containerStats.status === 'docker_unavailable',
                'status-unknown': containerStats.status === 'unknown' || containerStats.status === 'not_found',
              }"
            >
              {{ containerStats.status === 'docker_unavailable'
                ? 'Docker Unavailable'
                : containerStats.status === 'not_found'
                  ? 'Container Not Found'
                  : containerStats.status.charAt(0).toUpperCase() + containerStats.status.slice(1) }}
            </span>
          </div>

          <!-- Metrics Cards -->
          <div
            v-if="containerStats.status === 'running'"
            class="metrics-grid"
          >
            <!-- Running Models -->
            <div class="metric-card">
              <div class="metric-header">
                <span class="metric-title">Running Models</span>
              </div>
              <div class="metric-value">
                {{ (containerStats as any).runningModels || 0 }}
              </div>
              <div
                v-if="(containerStats as any).modelDetails?.length"
                class="metric-subtext"
              >
                {{ (containerStats as any).modelDetails.map((m: any) => m.name).join(', ') }}
              </div>
              <div
                v-else
                class="metric-subtext"
              >
                No models loaded
              </div>
            </div>

            <!-- Model Memory Usage -->
            <div class="metric-card">
              <div class="metric-header">
                <span class="metric-title">Model Memory</span>
              </div>
              <div class="metric-value">
                {{ formattedMemoryUsage }}
              </div>
              <div class="metric-bar">
                <div
                  class="metric-bar-fill memory-bar"
                  :style="{ width: Math.min(containerStats.memoryPercent, 100) + '%' }"
                />
              </div>
              <div class="metric-subtext">
                Memory used by loaded models
              </div>
            </div>
          </div>

          <!-- Not Running Message -->
          <div
            v-else
            class="not-running-message mb-10"
          >
            <p v-if="containerStats.status === 'offline'">
              llama.cpp server is offline. Make sure it's running on port 30114.
            </p>
            <p v-else-if="containerStats.status === 'error'">
              Unable to connect to llama.cpp server.
            </p>
            <p v-else>
              Checking llama.cpp status...
            </p>
          </div>

          <!-- Active Model Info -->
          <div class="active-model-section">
            <h3>Active Configuration</h3>
            <div class="config-item">
              <span class="config-label">Mode:</span>
              <span class="config-value">{{ activeMode === 'local' ? 'Local (llama.cpp)' : 'Remote (API)' }}</span>
            </div>
            <div
              v-if="activeMode === 'local'"
              class="config-item"
            >
              <span class="config-label">Model:</span>
              <span class="config-value">{{ activeModel }}</span>
            </div>
            <div
              v-else
              class="config-item"
            >
              <span class="config-label">Provider:</span>
              <span class="config-value">{{ selectedProvider }} / {{ selectedRemoteModel }}</span>
            </div>
          </div>

          <!-- Local Model Server Toggle -->
          <div class="active-model-section">
            <h3>Local Model Server</h3>
            <p class="description">
              The local llama-server runs a GGUF model on your Mac for offline inference.
              Disable it to free CPU and memory when using remote providers only.
            </p>
            <div class="config-item">
              <span class="config-label">Status:</span>
              <span
                class="status-badge"
                :class="localServerRunning ? 'status-running' : 'status-stopped'"
              >
                {{ localServerRunning ? 'Running' : 'Stopped' }}
              </span>
            </div>
            <div class="config-item toggle-row">
              <label class="toggle-label" for="local-server-toggle">
                Enable local model server
              </label>
              <button
                class="toggle-btn"
                :class="{ 'toggle-on': localServerEnabled, 'toggle-off': !localServerEnabled }"
                :disabled="togglingLocalServer"
                @click="toggleLocalServer"
              >
                <span class="toggle-knob" />
              </button>
            </div>
            <p
              v-if="!localServerEnabled"
              class="setting-description"
            >
              The server will stay off until you re-enable it. Sulla will use remote providers only.
            </p>
          </div>
        </div>

        <!-- Models Tab -->
        <div
          v-if="currentNav === 'models'"
          class="tab-content"
        >
          <!-- Primary Provider -->
          <div class="setting-group">
            <label class="setting-label">Primary Provider</label>
            <select
              v-model="primaryProvider"
              class="model-select"
            >
              <option
                v-for="provider in availableProviders"
                :key="provider.id"
                :value="provider.id"
              >
                {{ provider.name }}
              </option>
            </select>
            <p class="setting-description">
              The main language model provider used for all agent tasks.
            </p>
          </div>

          <!-- Secondary (Fallback) Provider -->
          <div class="setting-group">
            <label class="setting-label">Secondary Provider (Fallback)</label>
            <select
              v-model="secondaryProvider"
              class="model-select"
            >
              <option
                v-for="provider in availableProviders"
                :key="provider.id"
                :value="provider.id"
              >
                {{ provider.name }}
              </option>
            </select>
            <p class="setting-description">
              If for some reason the primary provider is inaccessible, we will fall back to the secondary provider.
            </p>
          </div>

          <div
            v-if="availableProviders.length <= 1"
            class="info-box"
          >
            <p>
              Only llama.cpp (local) is available. To add remote providers, go to
              <strong>Integrations</strong> and configure an AI provider (e.g. Grok, OpenAI, Anthropic).
            </p>
          </div>
        </div>

        <!-- Local Models Tab -->
        <div
          v-if="currentNav === 'local-models'"
          class="tab-content"
        >
          <h2>Local Models</h2>
          <p class="description">
            Select and manage locally downloaded GGUF models. The colored dot indicates resource fitness: green = plenty of resources, yellow = tight fit, red = insufficient.
          </p>

          <!-- System Resources Summary -->
          <div
            v-if="systemTotalMemoryGB > 0"
            class="system-resources-bar"
          >
            <span>System: {{ systemTotalMemoryGB }}GB RAM total</span>
            <span v-if="systemAvailableDiskGB > 0">
              &middot; {{ systemAvailableDiskGB }}GB disk free
            </span>
          </div>

          <div
            v-if="localModelError"
            class="activation-error"
          >
            {{ localModelError }}
          </div>

          <div
            v-if="loadingLocalModels"
            class="loading"
          >
            Loading model statuses...
          </div>

          <div
            v-else
            class="local-models-grid"
          >
            <div
              v-for="model in localModels"
              :key="model.name"
              class="local-model-card"
              :class="{
                'is-downloaded': localModelDownloadStatus[model.name],
                'is-not-downloaded': !localModelDownloadStatus[model.name],
                'is-selected': localModelSelected === model.name,
                'is-activated': activatedLocalModel === model.name,
              }"
              @click="selectLocalModel(model.name)"
            >
              <div class="local-model-header">
                <span class="local-model-name">{{ model.displayName }}</span>
                <div class="local-model-badges">
                  <!-- Resource fitness indicator -->
                  <span
                    class="fitness-badge"
                    :class="'fitness-' + resourceFitness(model)"
                    :title="resourceFitnessLabel(model)"
                  >
                    {{ resourceFitnessLabel(model) }}
                  </span>
                  <!-- Activated badge -->
                  <span
                    v-if="activatedLocalModel === model.name"
                    class="local-model-badge badge-activated"
                  >
                    Active
                  </span>
                  <!-- Download status badge -->
                  <span
                    v-else
                    class="local-model-badge"
                    :class="localModelDownloadStatus[model.name] ? 'badge-downloaded' : 'badge-not-downloaded'"
                  >
                    {{ localModelDownloadStatus[model.name] ? 'Downloaded' : 'Not Downloaded' }}
                  </span>
                </div>
              </div>
              <div class="local-model-meta">
                <span>{{ model.size }}</span>
                <span>{{ model.minMemoryGB }}GB RAM</span>
                <span>{{ model.minCPUs }} CPUs</span>
              </div>
              <p class="local-model-desc">
                {{ model.description }}
              </p>

              <!-- Download progress bar — always visible during download -->
              <div
                v-if="localModelDownloading === model.name"
                class="local-model-download-progress"
              >
                <div class="download-status-text">
                  Downloading {{ model.displayName }}... {{ localModelDownloadProgress }}%
                </div>
                <div class="progress-bar-lg">
                  <div
                    class="progress-fill-lg"
                    :style="{ width: localModelDownloadProgress + '%' }"
                  />
                </div>
              </div>

              <!-- Download button — only when selected, not downloaded, and not currently downloading -->
              <div
                v-else-if="localModelSelected === model.name && !localModelDownloadStatus[model.name]"
                class="local-model-actions"
              >
                <button
                  class="btn role-primary"
                  :disabled="!!localModelDownloading"
                  @click.stop="downloadLocalModel(model.name)"
                >
                  Download Model
                </button>
              </div>
            </div>
          </div>

          <!-- Context Size Slider — visible when a model is selected and downloaded -->
          <div
            v-if="localModelSelected && localModelDownloadStatus[localModelSelected] && localContextSize > 0"
            class="context-size-control"
          >
            <label class="form-label">Context Size</label>
            <div class="context-slider-row">
              <span class="context-value-min">2K</span>
              <input
                v-model.number="localContextSize"
                type="range"
                class="context-slider"
                :min="2048"
                :max="maxContextForModel(localModels.find(m => m.name === localModelSelected))"
                step="1024"
              >
              <span class="context-value-max">{{ Math.round((maxContextForModel(localModels.find(m => m.name === localModelSelected)) || 0) / 1024) }}K</span>
            </div>
            <div class="context-readout">
              {{ Math.round(localContextSize / 1024) }}K tokens
              <span class="context-ram-estimate">
                (~{{ Math.round(localContextSize * (localModels.find(m => m.name === localModelSelected)?.kvBytesPerToken || 0) / 1e6) }}MB KV cache)
              </span>
            </div>
          </div>

          <div
            v-if="localModelSelected"
            class="local-model-activate"
          >
            <button
              class="btn activate-btn"
              :class="activatedLocalModel === localModelSelected ? 'is-active' : 'role-primary'"
              :disabled="!localModelDownloadStatus[localModelSelected] || !!localModelDownloading || activatedLocalModel === localModelSelected"
              @click="activateSelectedGgufModel"
            >
              {{ activatedLocalModel === localModelSelected
                ? (localModels.find(m => m.name === localModelSelected)?.displayName || localModelSelected) + ' is Active'
                : 'Activate ' + (localModels.find(m => m.name === localModelSelected)?.displayName || localModelSelected) }}
            </button>
            <p
              v-if="!localModelDownloadStatus[localModelSelected]"
              class="setting-description"
            >
              Download this model first before activating.
            </p>
          </div>
        </div>

        <!-- Soul Tab -->
        <div
          v-if="currentNav === 'soul'"
          class="tab-content"
        >
          <h2>Soul</h2>
          <p class="description">
            Configure the agent's identity and system prompt. The bot name and user name will be prefixed to the soul prompt.
          </p>

          <div
            class="form-group"
            style="margin-bottom: 1.5rem;"
          >
            <label class="form-label">Bot Name</label>
            <input
              v-model="botName"
              type="text"
              class="text-input"
              placeholder="Sulla"
              style="max-width: 400px;"
            >
            <p class="setting-description">
              The name of the AI assistant (default: Sulla)
            </p>
          </div>

          <div
            class="form-group"
            style="margin-bottom: 2rem;"
          >
            <label class="form-label">Your Human's Name</label>
            <input
              v-model="primaryUserName"
              type="text"
              class="text-input"
              placeholder="Enter your name (optional)"
              style="max-width: 400px;"
            >
            <p class="setting-description">
              Your name (optional) - helps personalize interactions
            </p>
          </div>

        </div>

        <!-- Heartbeat Tab -->
        <div
          v-if="currentNav === 'heartbeat'"
          class="tab-content"
        >
          <h2>Heartbeat Settings</h2>
          <p class="description">
            Configure a periodic heartbeat that triggers the agent to check in and review its state.
          </p>

          <!-- Enable/Disable Toggle -->
          <div class="setting-group">
            <label class="setting-label">Enable Heartbeat</label>
            <div class="toggle-switch">
              <label class="switch">
                <input
                  v-model="heartbeatEnabled"
                  type="checkbox"
                >
                <span class="slider" />
              </label>
              <span class="toggle-label">{{ heartbeatEnabled ? 'Enabled' : 'Disabled' }}</span>
            </div>
            <p class="setting-description">
              When enabled, the agent will periodically wake up and process the heartbeat prompt.
            </p>
          </div>

          <!-- Delay Setting -->
          <div class="setting-group">
            <label class="setting-label">Heartbeat Interval (minutes)</label>
            <div class="delay-input">
              <input
                v-model.number="heartbeatDelayMinutes"
                type="number"
                class="text-input"
                min="1"
                max="1440"
                style="width: 120px;"
              >
            </div>
            <p class="setting-description">
              How often the heartbeat should trigger (1-1440 minutes). Default is 30 minutes.
            </p>
          </div>

          <!-- Provider Setting -->
          <div class="setting-group">
            <label class="setting-label">Heartbeat Provider</label>
            <select
              v-model="heartbeatProvider"
              class="model-select"
            >
              <option value="default">
                Use Primary Provider
              </option>
              <option
                v-for="provider in availableProviders"
                :key="provider.id"
                :value="provider.id"
              >
                {{ provider.name }}
              </option>
            </select>
            <p class="setting-description">
              Select which provider to use for heartbeat processing. "Use Primary Provider" follows your primary provider setting from the Models tab.
            </p>
          </div>

        </div>
      </div>
    </div>

    <!-- Footer -->
    <div class="lm-footer">
      <button
        class="btn role-primary"
        :disabled="activating || savingSettings"
        @click="saveSettings"
      >
        {{ savingSettings ? 'Saving...' : 'Save' }}
      </button>
      <button
        class="btn role-secondary"
        @click="closeWindow"
      >
        Close
      </button>
    </div>
  </div>
</template>

<style lang="scss" src="@pkg/assets/styles/app.scss"></style>
<style lang="scss" scoped>
.lm-settings {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: var(--bg-page, var(--body-bg));
  color: var(--text-primary, var(--body-text));
}

.lm-header {
  height: 3rem;
  font-size: var(--fs-heading);
  line-height: 2rem;
  display: flex;
  align-items: center;
  padding: 0 0.75rem;
  width: 100%;
  border-bottom: 1px solid var(--border-default, var(--header-border));

  h1 {
    flex: 1;
    margin: 0;
    font-size: inherit;
    font-weight: normal;
  }
}

.lm-content {
  display: flex;
  flex: 1;
  overflow: hidden;
}

.lm-nav {
  width: 200px;
  border-right: 1px solid var(--border-default, var(--header-border));
  padding-top: 0.75rem;
  flex-shrink: 0;

  .nav-item {
    font-size: var(--fs-heading);
    line-height: 1.75rem;
    padding: 0.5rem 0.75rem;
    cursor: pointer;
    user-select: none;
    color: var(--text-muted, var(--muted));
    transition: background 0.15s, color 0.15s;

    &:hover {
      background: var(--bg-surface-hover, var(--nav-active));
      color: var(--text-primary, var(--body-text));
    }

    &.active {
      background: var(--bg-active, var(--primary-light-bg, rgba(59, 130, 246, 0.05)));
      color: var(--accent-primary, var(--primary, #3b82f6));
      border-left: 2px solid var(--accent-primary, var(--primary, #3b82f6));
      font-weight: 500;
    }
  }
}

.lm-body {
  flex: 1;
  padding: 1.5rem;
  overflow: auto;
}

.active-mode-banner {
  background: var(--bg-info, var(--primary-bg, rgba(59, 130, 246, 0.1)));
  border: 1px solid var(--accent-primary, var(--primary, #3b82f6));
  border-radius: 6px;
  padding: 0.75rem 1rem;
  margin-bottom: 1rem;
  display: flex;
  align-items: center;
  gap: 0.5rem;

  .active-label {
    font-weight: 600;
    color: var(--accent-primary, var(--primary, #3b82f6));
  }

  .active-value {
    color: var(--text-primary, var(--body-text));
  }
}

.model-tabs {
  display: flex;
  gap: 0;
  margin-bottom: 1.5rem;
  border-bottom: 2px solid var(--border-default, var(--input-border));
}

.model-tab {
  padding: 0.75rem 1.5rem;
  background: transparent;
  border: none;
  border-top: none;
  border-left: none;
  border-right: none;
  border-bottom: 2px solid transparent;
  margin-bottom: -2px;
  cursor: pointer;
  font-size: var(--fs-body);
  color: var(--text-muted, var(--muted));
  transition: all 0.2s;
  outline: none;

  &:focus {
    outline: none;
    box-shadow: none;
  }

  &:focus-visible {
    outline: 2px solid var(--accent-primary, var(--primary, #3b82f6));
    outline-offset: -2px;
  }

  &:hover {
    color: var(--text-primary, var(--body-text));
    background: var(--bg-surface-hover, var(--nav-active));
  }

  &.active {
    color: var(--accent-primary, var(--primary, #3b82f6));
    border-bottom-color: var(--accent-primary, var(--primary, #3b82f6));
    font-weight: 500;
    background: var(--bg-active, var(--primary-bg, rgba(59, 130, 246, 0.1)));
  }
}

.activate-section {
  margin-bottom: 1.5rem;
}

.activate-btn {
  min-width: 200px;

  &.is-active {
    background: var(--status-success, var(--success, #22c55e)) !important;
    border-color: var(--status-success, var(--success, #22c55e)) !important;
    color: var(--text-on-accent, #fff) !important;
    opacity: 1 !important;
    cursor: default;
  }

  &.is-active:disabled {
    background: var(--status-success, var(--success, #22c55e)) !important;
    border-color: var(--status-success, var(--success, #22c55e)) !important;
    color: var(--text-on-accent, #fff) !important;
    opacity: 1 !important;
  }
}

.activation-error {
  background: var(--bg-error, rgba(239, 68, 68, 0.1));
  border: 1px solid var(--border-error, var(--status-error, #ef4444));
  border-radius: 6px;
  padding: 0.75rem 1rem;
  margin-bottom: 1rem;
  color: var(--text-error, var(--status-error, #ef4444));
  font-size: var(--fs-body);
}

.tab-content {
  h2 {
    margin: 0 0 0.5rem;
    font-size: var(--fs-heading);
    font-weight: 500;
  }

  h3 {
    margin: 1.5rem 0 0.75rem;
    font-size: var(--fs-body);
    font-weight: 500;
  }

  .description {
    color: var(--text-muted, var(--muted));
    margin-bottom: 1.5rem;
  }
}

// Overview tab styles
.status-section {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin-bottom: 1.5rem;

  .status-label {
    font-weight: 500;
  }

  .status-badge {
    padding: 0.25rem 0.75rem;
    border-radius: 9999px;
    font-size: var(--fs-code);
    font-weight: 500;

    &.status-running {
      background: var(--bg-success);
      color: var(--status-success);
    }

    &.status-stopped {
      background: var(--bg-warning);
      color: var(--status-warning);
    }

    &.status-error {
      background: var(--bg-error);
      color: var(--status-error);
    }

    &.status-unknown {
      background: var(--bg-hover);
      color: var(--text-muted);
    }
  }
}

.metrics-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
  gap: 1rem;
  margin-bottom: 1.5rem;
}

.metric-card {
  background: var(--bg-surface, var(--input-bg));
  border: 1px solid var(--border-default, var(--input-border));
  border-radius: 8px;
  padding: 1rem;

  .metric-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.5rem;
  }

  .metric-title {
    font-size: var(--fs-body);
    color: var(--text-muted, var(--muted));
  }

  .metric-value {
    font-size: var(--fs-heading);
    font-weight: 600;
    margin-bottom: 0.75rem;
  }

  .metric-bar {
    height: 8px;
    background: var(--border-default, var(--input-border));
    border-radius: 4px;
    overflow: hidden;
  }

  .metric-bar-fill {
    height: 100%;
    border-radius: 4px;
    transition: width 0.3s ease;

    &.cpu-bar {
      background: linear-gradient(90deg, var(--accent-primary), var(--text-accent, #8b5cf6));
    }

    &.memory-bar {
      background: linear-gradient(90deg, var(--status-success), var(--status-warning));
    }
  }

  .metric-subtext {
    font-size: var(--fs-body-sm);
    color: var(--text-muted, var(--muted));
    margin-top: 0.5rem;
  }
}

.not-running-message {
  background: var(--bg-surface, var(--input-bg));
  border: 1px solid var(--border-default, var(--input-border));
  border-radius: 8px;
  padding: 2rem;
  text-align: center;
  color: var(--text-muted, var(--muted));

  p {
    margin: 0;
  }
}

.active-model-section {
  background: var(--bg-surface, var(--input-bg));
  border: 1px solid var(--border-default, var(--input-border));
  border-radius: 8px;
  padding: 1rem;

  h3 {
    margin: 0 0 0.75rem !important;
  }

  .config-item {
    display: flex;
    gap: 0.5rem;
    padding: 0.25rem 0;
    align-items: center;

    .config-label {
      color: var(--text-muted, var(--muted));
      min-width: 80px;
    }

    .config-value {
      font-weight: 500;
    }
  }

  .toggle-row {
    justify-content: space-between;
    margin-top: 0.5rem;
  }

  .toggle-label {
    font-weight: 500;
    cursor: pointer;
  }

  .toggle-btn {
    position: relative;
    display: inline-block;
    width: 48px;
    height: 26px;
    border-radius: 13px;
    border: none;
    cursor: pointer;
    transition: background-color 0.2s ease;
    padding: 0;
    margin: 0;
    flex-shrink: 0;
    outline: none;
    -webkit-appearance: none;
    appearance: none;
    vertical-align: middle;

    &.toggle-on {
      background-color: #34c759;
    }

    &.toggle-off {
      background-color: #c7c7cc;
    }

    &:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }

    .toggle-knob {
      position: absolute;
      top: 3px;
      left: 3px;
      width: 20px;
      height: 20px;
      border-radius: 50%;
      background: #fff;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.15);
      transition: transform 0.2s ease;
      pointer-events: none;
    }

    &.toggle-on .toggle-knob {
      transform: translateX(22px);
    }
  }
}

.lm-footer {
  padding: 1rem 1.5rem;
  border-top: 1px solid var(--border-default, var(--header-border));
  display: flex;
  justify-content: flex-end;
}

.info-box {
  margin-top: 1rem;
  padding: 1rem;
  border-radius: 8px;
  border: 1px solid var(--border-default);
  background: var(--bg-surface-alt, var(--bg-surface));

  p {
    font-size: var(--fs-body);
    color: var(--text-muted, var(--muted));
    margin: 0;
  }
}

// Models tab styles
.setting-group {
  margin-bottom: 1.5rem;

  .setting-label {
    display: block;
    font-weight: 500;
    margin-bottom: 0.5rem;
  }

  .setting-description {
    color: var(--text-muted, var(--muted));
    font-size: var(--fs-body);
    margin-top: 0.5rem;
    opacity: 0.6;
    margin-bottom: 0.5rem;

    .provider-signup-link {
      color: var(--text-link, var(--primary, #3b82f6));
      text-decoration: none;
      font-weight: 500;

      &:hover {
        text-decoration: underline;
      }
    }
  }
}

.radio-group {
  display: flex;
  gap: 1.5rem;

  .radio-option {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    cursor: pointer;

    input[type="radio"] {
      cursor: pointer;
    }
  }
}

.current-model {
  font-size: var(--fs-body);
  color: var(--text-muted, var(--muted));
  margin-bottom: 0.5rem;

  strong {
    color: var(--text-primary, var(--body-text));
  }
}

.model-select {
  width: 100%;
  max-width: 400px;
  padding: 0.5rem;
  font-size: var(--fs-body);
  border: 1px solid var(--border-default, var(--input-border));
  border-radius: 4px;
  background-color: var(--bg-input, var(--input-bg));
  color: var(--text-primary, var(--input-text));

  option {
    background-color: var(--bg-input, var(--input-bg));
    color: var(--text-primary, var(--input-text));
  }

  &:focus {
    outline: none;
    border-color: var(--primary);
  }

  &:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
}

.soul-textarea {
  width: 100%;
  max-width: 900px;
  padding: 0.75rem;
  font-size: var(--fs-code);
  line-height: 1.5;
  border: 1px solid var(--border-default, var(--input-border));
  border-radius: 6px;
  background-color: var(--bg-input, var(--input-bg));
  color: var(--text-primary, var(--input-text));
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  resize: vertical;
  min-height: 520px;

  &:focus {
    outline: none;
    border-color: var(--primary);
  }
}

.soul-actions {
  margin-top: 0.75rem;
  display: flex;
  gap: 0.75rem;
}

.text-input {
  flex: 1;
  padding: 0.5rem;
  font-size: var(--fs-body);
  border: 1px solid var(--border-default, var(--input-border));
  border-radius: 4px;
  background-color: var(--bg-input, var(--input-bg));
  color: var(--text-primary, var(--input-text));

  &:focus {
    outline: none;
    border-color: var(--primary);
  }
}

.api-key-input {
  display: flex;
  gap: 0.5rem;
  max-width: 500px;

  .text-input {
    flex: 1;
  }
}

// Toggle switch styles
.toggle-switch {
  display: flex;
  align-items: center;
  gap: 0.75rem;

  .toggle-label {
    font-size: var(--fs-body);
    color: var(--text-primary, var(--body-text));
  }
}

.switch {
  position: relative;
  display: inline-block;
  width: 48px;
  height: 24px;

  input {
    opacity: 0;
    width: 0;
    height: 0;
  }

  .slider {
    position: absolute;
    cursor: pointer;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background-color: var(--border-default, var(--input-border));
    transition: 0.3s;
    border-radius: 24px;

    &::before {
      position: absolute;
      content: "";
      height: 18px;
      width: 18px;
      left: 3px;
      bottom: 3px;
      background-color: var(--text-on-accent, white);
      transition: 0.3s;
      border-radius: 50%;
    }
  }

  input:checked + .slider {
    background-color: var(--accent-primary, var(--primary, #3b82f6));
  }

  input:checked + .slider::before {
    transform: translateX(24px);
  }

  input:disabled + .slider {
    opacity: 0.5;
    cursor: not-allowed;
  }
}

.prompt-textarea {
  width: 100%;
  max-width: 600px;
  padding: 0.75rem;
  font-size: var(--fs-body);
  border: 1px solid var(--border-default, var(--input-border));
  border-radius: 4px;
  background-color: var(--bg-input, var(--input-bg));
  color: var(--text-primary, var(--input-text));
  font-family: inherit;
  resize: vertical;
  min-height: 100px;

  &:focus {
    outline: none;
    border-color: var(--primary);
  }

  &:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
}

.model-action {
  margin-top: 1rem;
}

.model-status {
  font-size: var(--fs-body);
  margin-bottom: 0.5rem;

  &.not-installed {
    color: var(--status-warning, var(--warning, #f59e0b));
  }

  &.installed {
    color: var(--status-success, var(--success, #22c55e));
  }

  &.downloading {
    color: var(--accent-primary, var(--primary));
  }
}

.download-progress {
  margin-top: 1rem;
}

.progress-bar {
  width: 100%;
  max-width: 400px;
  height: 8px;
  background: var(--border-default, var(--input-border));
  border-radius: 4px;
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  background: var(--accent-primary, var(--primary));
  transition: width 0.3s ease;
}

.progress-text {
  font-size: var(--fs-body-sm);
  color: var(--text-muted, var(--muted));
  margin-top: 0.25rem;
}

.model-status-section {
  border: 1px solid var(--border-default, var(--input-border));
  border-radius: 6px;
  padding: 1rem;
  background: var(--bg-surface, var(--input-bg));
}

.downloaded-models-list {
  margin-bottom: 1.5rem;
}

.model-list {
  max-height: 200px;
  overflow-y: auto;
  border: 1px solid var(--border-default, var(--input-border));
  border-radius: 4px;
  background: var(--bg-page, var(--body-bg));
}

.model-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.5rem 0.75rem;
  border-bottom: 1px solid var(--border-default, var(--input-border));
  font-size: var(--fs-code);
}

.model-item:last-child {
  border-bottom: none;
}

.model-name {
  font-weight: 500;
  color: var(--text-primary, var(--body-text));
}

.model-size {
  color: var(--text-muted, var(--muted));
  font-size: var(--fs-body-sm);
}

.key-models-status {
  margin-bottom: 1rem;
}

.model-status-item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.75rem;
  padding: 0.5rem;
  border-radius: 4px;
  background: var(--bg-page, var(--body-bg));
  border: 1px solid var(--border-default, var(--input-border));
}

.status-label {
  font-size: var(--fs-code);
  color: var(--text-primary, var(--body-text));
  font-weight: 500;
  flex: 1;
}

.status-badge {
  padding: 0.25rem 0.5rem;
  border-radius: 12px;
  font-size: var(--fs-body-sm);
  font-weight: 500;
  text-transform: uppercase;
}

.status-installed {
  background: var(--bg-success);
  color: var(--status-success);
}

.status-missing {
  background: var(--bg-warning);
  color: var(--status-warning);
}

.status-failed {
  background: var(--bg-error);
  color: var(--status-error);
}

.no-models-message {
  padding: 1rem;
  text-align: center;
  color: var(--text-muted, var(--muted));
}

.download-section {
  display: flex;
  gap: 0.75rem;
  margin-bottom: 1.5rem;

  input {
    flex: 1;
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--border-default, var(--input-border));
    border-radius: 4px;
    background-color: var(--bg-input, var(--input-bg));
    color: var(--text-primary, var(--input-text));

    &:focus {
      outline: none;
      border-color: var(--primary);
    }
  }
}

.models-table {
  width: 100%;
  border-collapse: collapse;

  th, td {
    padding: 0.75rem;
    text-align: left;
    border-bottom: 1px solid var(--border-default, var(--header-border));
  }

  th {
    font-weight: 500;
    color: var(--text-muted, var(--muted));
    font-size: var(--fs-body);
  }

  .model-name {
    font-weight: 500;
  }
}

// Memory tab styles
.memory-layout {
  display: flex;
  gap: 1rem;
  height: calc(100vh - 280px);
}

.pages-list {
  width: 250px;
  border: 1px solid var(--border-default, var(--header-border));
  border-radius: 4px;
  overflow: auto;

  .page-item {
    padding: 0.75rem;
    border-bottom: 1px solid var(--border-default, var(--header-border));
    cursor: pointer;

    &:hover {
      background: var(--bg-surface-hover, var(--dropdown-hover-bg));
    }

    &.selected {
      background: var(--accent-primary, var(--primary));
      color: var(--text-on-accent, var(--primary-text));
    }

    .page-title {
      display: block;
      font-weight: 500;
    }

    .page-type {
      font-size: var(--fs-body-sm);
      color: var(--text-muted, var(--muted));
    }

    &.selected .page-type {
      color: inherit;
      opacity: 0.8;
    }
  }
}

.page-editor {
  flex: 1;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border-default, var(--header-border));
  border-radius: 4px;
  padding: 1rem;

  .editor-header {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-bottom: 1rem;

    h3 {
      margin: 0;
      font-size: var(--fs-body);
    }

    .badge {
      font-size: var(--fs-body-sm);
      padding: 0.25rem 0.5rem;
      background: var(--text-muted, var(--muted));
      color: var(--bg-page, var(--body-bg));
      border-radius: 4px;
    }
  }

  .editor-textarea {
    flex: 1;
    padding: 0.75rem;
    border: 1px solid var(--border-default, var(--input-border));
    border-radius: 4px;
    background-color: var(--bg-input, var(--input-bg));
    color: var(--text-primary, var(--input-text));
    resize: none;
    font-family: inherit;

    &:focus {
      outline: none;
      border-color: var(--primary);
    }
  }

  .editor-actions {
    display: flex;
    gap: 0.5rem;
    margin-top: 1rem;
  }
}

// Resources tab styles
.services-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 1rem;
}

.service-card {
  border: 1px solid var(--border-default, var(--header-border));
  border-radius: 8px;
  padding: 1.25rem;

  .service-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.5rem;

    h3 {
      margin: 0;
      font-size: var(--fs-body);
    }
  }

  p {
    color: var(--text-muted, var(--muted));
    font-size: var(--fs-body);
    margin: 0 0 1rem;
  }

  .service-actions {
    display: flex;
    gap: 0.5rem;
  }
}

.status-badge {
  font-size: var(--fs-body-sm);
  padding: 0.25rem 0.5rem;
  border-radius: 4px;
  text-transform: capitalize;

  &.running {
    background: var(--status-success);
    color: var(--text-on-accent, #fff);
  }

  &.stopped {
    background: var(--status-error);
    color: var(--text-on-accent, #fff);
  }

  &.error {
    background: var(--status-warning);
    color: var(--text-on-accent, #fff);
  }

  &.unknown {
    background: var(--text-muted, var(--muted));
    color: var(--text-on-accent, #fff);
  }
}

// Logs tab styles
.logs-container {
  height: calc(100vh - 280px);
  border: 1px solid var(--border-default, var(--header-border));
  border-radius: 4px;
  overflow: auto;
}

.logs-output {
  margin: 0;
  padding: 1rem;
  font-family: monospace;
  font-size: var(--fs-body);
  white-space: pre-wrap;
  word-break: break-all;
}

// Common styles
.loading, .empty-state {
  padding: 2rem;
  text-align: center;
  color: var(--text-muted, var(--muted));
}

.btn {
  padding: 0.5rem 1rem;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: var(--fs-body);
  transition: background 0.15s;

  &.role-primary {
    background: var(--accent-primary, var(--primary));
    color: var(--text-on-accent, var(--primary-text));

    &:hover {
      opacity: 0.9;
    }

    &:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
  }

  &.role-secondary {
    background-color: var(--bg-input, var(--input-bg));
    border: 1px solid var(--border-default, var(--input-border));
    color: var(--text-primary, var(--body-text));

    &:hover {
      background-color: var(--bg-surface-hover, var(--dropdown-hover-bg));
    }
  }

  &.btn-sm {
    padding: 0.25rem 0.5rem;
    font-size: var(--fs-body-sm);
  }
}
// Local Models tab styles
.local-models-grid {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  margin-bottom: 1.5rem;
}

// System resources summary bar
.system-resources-bar {
  display: flex;
  gap: 0.5rem;
  font-size: var(--fs-body-sm);
  color: var(--text-muted, var(--muted));
  padding: 0.5rem 0.75rem;
  background: var(--bg-surface, var(--input-bg));
  border-radius: 6px;
  margin-bottom: 1rem;
}

.local-model-card {
  border: 2px solid var(--border-default, var(--input-border));
  border-radius: 8px;
  padding: 1rem;
  cursor: pointer;
  transition: border-color 0.2s, opacity 0.15s, background 0.2s, box-shadow 0.2s;

  &.is-not-downloaded {
    opacity: 0.9;
  }

  &.is-downloaded {
    opacity: 1;
  }

  &.is-selected {
    border-color: var(--accent-primary, var(--primary, #3b82f6));
    background: var(--bg-active, var(--primary-bg, rgba(59, 130, 246, 0.06)));
  }

  // Activated model gets a prominent green treatment
  &.is-activated {
    border-color: var(--status-success, var(--success, #22c55e));
    background: var(--bg-success);
    box-shadow: 0 0 0 1px var(--status-success, var(--success, #22c55e));
    opacity: 1;
  }

  &.is-activated.is-selected {
    border-color: var(--status-success, var(--success, #22c55e));
    background: var(--bg-success);
    box-shadow: 0 0 0 1px var(--status-success, var(--success, #22c55e));
  }

  &:hover {
    border-color: var(--accent-primary, var(--primary, #3b82f6));
  }

  &.is-activated:hover {
    border-color: var(--status-success, var(--success, #22c55e));
  }
}

.local-model-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 0.5rem;
}

.local-model-badges {
  display: flex;
  gap: 0.4rem;
  align-items: center;
}

.local-model-name {
  font-weight: 600;
  font-size: var(--fs-body);
}

.local-model-badge {
  font-size: var(--fs-body-sm);
  padding: 0.2rem 0.6rem;
  border-radius: 12px;
  font-weight: 500;

  &.badge-downloaded {
    background: var(--bg-success);
    color: var(--status-success);
  }

  &.badge-not-downloaded {
    background: var(--bg-hover);
    color: var(--text-muted);
  }

  &.badge-activated {
    background: var(--status-success, var(--success, #22c55e));
    color: var(--text-on-accent, #fff);
    font-weight: 600;
  }
}

// Resource fitness indicator dot + label
.fitness-badge {
  font-size: var(--fs-body-sm);
  padding: 0.15rem 0.5rem;
  border-radius: 12px;
  font-weight: 500;

  &.fitness-green {
    background: var(--bg-success);
    color: var(--status-success, #22c55e);
  }

  &.fitness-yellow {
    background: var(--bg-warning);
    color: var(--status-warning, #f59e0b);
  }

  &.fitness-red {
    background: var(--bg-error);
    color: var(--status-error, #ef4444);
  }
}

.local-model-meta {
  display: flex;
  gap: 1rem;
  font-size: var(--fs-body-sm);
  color: var(--text-muted, var(--muted));
  margin-bottom: 0.35rem;
}

.local-model-desc {
  font-size: var(--fs-code);
  color: var(--text-muted, var(--muted));
  margin: 0;
}

.local-model-actions {
  margin-top: 0.75rem;
}

// Prominent download progress indicator
.local-model-download-progress {
  margin-top: 0.75rem;
  padding: 0.75rem;
  background: var(--bg-info, var(--primary-bg, rgba(59, 130, 246, 0.08)));
  border: 1px solid var(--accent-primary, var(--primary, #3b82f6));
  border-radius: 6px;

  .download-status-text {
    font-size: var(--fs-body);
    font-weight: 500;
    color: var(--accent-primary, var(--primary, #3b82f6));
    margin-bottom: 0.5rem;
  }
}

.progress-bar-lg {
  width: 100%;
  height: 12px;
  background: var(--border-default, var(--input-border));
  border-radius: 6px;
  overflow: hidden;
}

.progress-fill-lg {
  height: 100%;
  background: linear-gradient(90deg, var(--accent-primary, var(--primary, #3b82f6)), var(--text-accent, #6366f1));
  border-radius: 6px;
  transition: width 0.3s ease;
}

.local-model-activate {
  margin-top: 0.5rem;

  .setting-description {
    margin-top: 0.5rem;
  }
}

// Context size slider
.context-size-control {
  margin-top: 1rem;
  padding: 1rem;
  background: var(--bg-surface, var(--input-bg));
  border-radius: 8px;
  border: 1px solid var(--border-default, var(--input-border));
}

.context-slider-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin-top: 0.5rem;
}

.context-slider {
  flex: 1;
  height: 6px;
  -webkit-appearance: none;
  appearance: none;
  background: var(--border-default, var(--input-border));
  border-radius: 3px;
  outline: none;

  &::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: var(--accent-color, #0366d6);
    cursor: pointer;
    border: 2px solid var(--bg-surface, #fff);
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
  }
}

.context-value-min,
.context-value-max {
  font-size: var(--fs-body-sm);
  color: var(--text-muted, var(--muted));
  white-space: nowrap;
  min-width: 2.5rem;
}

.context-value-max {
  text-align: right;
}

.context-readout {
  margin-top: 0.5rem;
  font-size: var(--fs-body-sm);
  font-weight: 600;
  color: var(--text-primary, var(--body-text));
}

.context-ram-estimate {
  font-weight: 400;
  color: var(--text-muted, var(--muted));
}

</style>
