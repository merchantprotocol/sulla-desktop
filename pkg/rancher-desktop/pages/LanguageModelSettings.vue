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
import { useTheme } from '../composables/useTheme';

// Nav items for the Language Model Settings sidebar
const navItems = [
  { id: 'overview', name: 'Overview' },
  { id: 'models', name: 'Models' },
  { id: 'claude-code', name: 'Claude Code' },
  { id: 'soul', name: 'Soul' },
  { id: 'heartbeat', name: 'Heartbeat' },
];

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
      // Which tab is being viewed
      viewingTab:            'remote' as string,
      // Which mode is currently active (saved in settings)
      activeMode:            'remote' as string,
      // Active model
      activeModel:           '' as string,
      pendingModel:          '' as string,
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
      primaryProvider:      'grok' as string,
      secondaryProvider:    'grok' as string,
      availableProviders:   [] as { id: string; name: string }[],

      // Activation state
      activating:           false,
      activationError:      '' as string,
      savingSettings:       false,
      // Guard flag to prevent feedback loop between primaryProvider watcher and IPC handler
      _suppressProviderWatch: false,

      // Claude Code auth
      claudeAuthMode:    'none' as 'none' | 'api-key' | 'oauth',
      claudeApiKey:      '',
      claudeOAuthToken:  '',
      claudeApiKeyVisible: false,
      claudeSaving:      false,
      claudeOAuthRunning: false,
      claudeOAuthStatus: 'Starting...',
      claudeOAuthError:  '',
      claudeOAuthUrl:    '',
      claudeOAuthCode:   '',
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
  },

  async mounted() {
    console.log('LanguageModelSettings mounted');
    // Listen for settings write errors from main process
    ipcRenderer.on('settings-write-error', (_event: unknown, error: any) => {
      console.error('[LM Settings] Settings write error from main process:', error);
      this.activationError = `Failed to save settings: ${ error?.message || 'Unknown error' }`;
    });

    this.activeMode = await SullaSettingsModel.get('activeMode', 'remote');

    // Load Claude Code credentials
    await this.loadClaudeCredentials();

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
      const config = await ipcRenderer.invoke('model-provider:get-provider-config', mpsState.primaryProvider);
      this.selectedProvider = mpsState.primaryProvider;
      this.selectedRemoteModel = mpsState.activeModelId;
      this.apiKey = config.api_key || '';
    } catch (err) {
      console.warn('[LM Settings] Failed to load from ModelProviderService, falling back:', err);
      this.activeMode = 'remote';
      this.viewingTab = 'remote';
      this.selectedProvider = await SullaSettingsModel.get('remoteProvider', 'grok');
      this.selectedRemoteModel = await SullaSettingsModel.get('remoteModel', 'grok-4-1-fast-reasoning');
      this.apiKey = await SullaSettingsModel.get('remoteApiKey', '');
    }
    this.remoteRetryCount = await SullaSettingsModel.get('remoteRetryCount', 3);
    this.remoteTimeoutSeconds = Number(await SullaSettingsModel.get('remoteTimeoutSeconds', 60));
    this.heartbeatEnabled = await SullaSettingsModel.get('heartbeatEnabled', true);

    console.log('Loaded settings values:', {
      activeMode:           this.activeMode,
      viewingTab:           this.viewingTab,
      selectedProvider:     this.selectedProvider,
      selectedRemoteModel:  this.selectedRemoteModel,
      remoteTimeoutSeconds: this.remoteTimeoutSeconds,
      remoteRetryCount:     this.remoteRetryCount,
    });

    // Build available providers list from ModelProviderService
    try {
      const providers = await ipcRenderer.invoke('model-provider:get-providers');
      this.availableProviders = providers
        .map((p: { id: string; name: string; connected?: boolean }) => ({
          id: p.id, name: p.connected === false ? `${ p.name } (not connected)` : p.name,
        }));
    } catch (err) {
      console.warn('[LM Settings] Failed to load available providers:', err);
    }

    // Load remote models if API key exists
    if (this.selectedProvider && this.apiKey.trim()) {
      await this.loadRemoteModels();
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

        // Tell the source of truth — it persists and broadcasts
        const newState = await ipcRenderer.invoke('model-provider:select-model', newProvider, preferredModel);

        this.activeMode = newState.modelMode;
        this.viewingTab = newState.modelMode;
        this.activeModel = newState.activeModelId;
        this.selectedProvider = newProvider;
        this.selectedRemoteModel = newState.activeModelId;
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
      if (navId === 'models') {
        console.log('After models nav, viewingTab:', this.viewingTab);
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

        // Tell the source of truth — it persists and broadcasts
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

    async startClaudeOAuth() {
      this.claudeOAuthError = '';
      this.claudeOAuthStatus = 'Starting claude setup-token in the VM...';
      this.claudeOAuthUrl = '';
      this.claudeOAuthCode = '';
      this.claudeOAuthRunning = true;

      const onProgress = (_event: unknown, text: string) => {
        const trimmed = text.trim();
        if (trimmed) this.claudeOAuthStatus = trimmed.split('\n').pop() || this.claudeOAuthStatus;
      };
      const onUrl = (_event: unknown, url: string) => {
        this.claudeOAuthUrl = url;
        this.claudeOAuthStatus = 'Sign in in your browser, then paste the code below.';
      };
      ipcRenderer.on('claude-oauth:progress', onProgress);
      ipcRenderer.on('claude-oauth:url', onUrl);

      try {
        const result = await ipcRenderer.invoke('claude-oauth:start');
        if (result.token) {
          this.claudeOAuthToken = result.token;
          await ipcRenderer.invoke('sulla-settings-set', 'claudeOAuthToken', result.token, 'string');
          await ipcRenderer.invoke('sulla-settings-set', 'claudeApiKey', '', 'string');
          this.claudeApiKey = '';
          this.claudeOAuthStatus = 'Signed in';
        } else if (result.error) {
          this.claudeOAuthError = result.error;
        }
      } catch (err: any) {
        this.claudeOAuthError = err?.message || 'OAuth flow failed';
      } finally {
        ipcRenderer.removeListener('claude-oauth:progress', onProgress);
        ipcRenderer.removeListener('claude-oauth:url', onUrl);
        this.claudeOAuthRunning = false;
        this.claudeOAuthUrl = '';
      }
    },

    async submitClaudeOAuthCode() {
      const code = this.claudeOAuthCode.trim();
      if (!code) return;
      try {
        // Send the code followed by newline to feed the CLI's stdin
        await ipcRenderer.invoke('claude-oauth:send-input', code + '\r');
        this.claudeOAuthCode = '';
        this.claudeOAuthStatus = 'Code submitted, waiting for token...';
      } catch (err) {
        console.warn('Failed to submit OAuth code:', err);
      }
    },

    async copyAuthUrl() {
      const { clipboard } = require('electron');
      if (this.claudeOAuthUrl) {
        clipboard.writeText(this.claudeOAuthUrl);
        this.claudeOAuthStatus = 'URL copied to clipboard. Paste it into your browser.';
      }
    },

    async cancelClaudeOAuth() {
      try {
        await ipcRenderer.invoke('claude-oauth:cancel');
      } catch { /* ignore */ }
      this.claudeOAuthRunning = false;
      this.claudeOAuthStatus = 'Starting...';
      this.claudeOAuthUrl = '';
      this.claudeOAuthCode = '';
    },

    async disconnectClaudeOAuth() {
      this.claudeOAuthToken = '';
      await ipcRenderer.invoke('sulla-settings-set', 'claudeOAuthToken', '', 'string');
    },

    async saveClaudeCredentials() {
      this.claudeSaving = true;
      try {
        if (this.claudeAuthMode === 'api-key' && this.claudeApiKey) {
          await ipcRenderer.invoke('sulla-settings-set', 'claudeApiKey', this.claudeApiKey, 'string');
          await ipcRenderer.invoke('sulla-settings-set', 'claudeOAuthToken', '', 'string');
        } else if (this.claudeAuthMode === 'oauth' && this.claudeOAuthToken) {
          await ipcRenderer.invoke('sulla-settings-set', 'claudeOAuthToken', this.claudeOAuthToken.trim(), 'string');
          await ipcRenderer.invoke('sulla-settings-set', 'claudeApiKey', '', 'string');
        }
        console.log('[LM Settings] Claude credentials saved');
      } catch (err) {
        console.error('Failed to save Claude credentials:', err);
      } finally {
        this.claudeSaving = false;
      }
    },

    async loadClaudeCredentials() {
      try {
        const apiKey = await ipcRenderer.invoke('sulla-settings-get', 'claudeApiKey', '');
        const oauthToken = await ipcRenderer.invoke('sulla-settings-get', 'claudeOAuthToken', '');
        this.claudeApiKey = apiKey || '';
        this.claudeOAuthToken = oauthToken || '';
        if (oauthToken) {
          this.claudeAuthMode = 'oauth';
        } else if (apiKey) {
          this.claudeAuthMode = 'api-key';
        } else {
          this.claudeAuthMode = 'none';
        }
      } catch {
        // Settings not available yet
      }
    },

    openExternal(url: string) {
      const { shell } = require('electron');
      shell.openExternal(url);
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
    handleModelChanged(_event: IpcRendererEvent, data: { model: string; type: string; provider?: string }) {
      this.activeModel = data.model;
      this.activeMode = data.type;
      if (data.provider) {
        this.selectedProvider = data.provider;
        this.selectedRemoteModel = data.model;
      }
      this.pendingModel = this.activeModel;
      const newPrimary = data.provider || this.primaryProvider;
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
          <h2>Overview</h2>
          <p class="description">
            View the active AI configuration.
          </p>

          <!-- Active Model Info -->
          <div class="active-model-section mb-10">
            <h3>Active Configuration</h3>
            <div class="config-item">
              <span class="config-label">Mode:</span>
              <span class="config-value">Remote (API)</span>
            </div>
            <div class="config-item">
              <span class="config-label">Provider:</span>
              <span class="config-value">{{ selectedProvider }} / {{ selectedRemoteModel }}</span>
            </div>
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
            v-if="availableProviders.length === 0"
            class="info-box"
          >
            <p>
              Loading providers...
            </p>
          </div>
          <div
            v-else
            class="info-box"
          >
            <p>
              Providers marked <em>(not connected)</em> require an API key. Open
              <strong>Integrations</strong> to configure credentials for Grok, OpenAI, Anthropic, etc.
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

        <!-- Claude Code Tab -->
        <div
          v-if="currentNav === 'claude-code'"
          class="tab-content"
        >
          <h2>Claude Code</h2>
          <p class="description">
            Claude Code runs inside the virtual machine with full access to your projects.
            Connect your Anthropic account to enable it.
          </p>

          <!-- Auth Mode Selection -->
          <div class="setting-group">
            <label class="setting-label">Authentication Method</label>
            <div class="claude-auth-buttons">
              <button
                class="btn"
                :class="claudeAuthMode === 'api-key' ? 'role-primary' : 'role-secondary'"
                @click="claudeAuthMode = 'api-key'"
              >
                API Key
              </button>
              <button
                class="btn"
                :class="claudeAuthMode === 'oauth' ? 'role-primary' : 'role-secondary'"
                @click="claudeAuthMode = 'oauth'"
              >
                Claude Max (OAuth)
              </button>
            </div>
            <p class="setting-description">
              Use an API key for pay-per-token billing, or sign in with your Claude Max/Pro subscription.
            </p>
          </div>

          <!-- API Key Input -->
          <div
            v-if="claudeAuthMode === 'api-key'"
            class="setting-group"
          >
            <label class="setting-label">Anthropic API Key</label>
            <div class="claude-input-row">
              <input
                v-model="claudeApiKey"
                :type="claudeApiKeyVisible ? 'text' : 'password'"
                class="input-field claude-input-field"
                placeholder="sk-ant-..."
              >
              <button
                class="btn role-secondary"
                @click="claudeApiKeyVisible = !claudeApiKeyVisible"
              >
                {{ claudeApiKeyVisible ? 'Hide' : 'Show' }}
              </button>
            </div>
            <p class="setting-description">
              Get your API key from
              <a
                href="#"
                @click.prevent="openExternal('https://console.anthropic.com/settings/keys')"
              >console.anthropic.com</a>
            </p>
          </div>

          <!-- OAuth Sign-In -->
          <div
            v-if="claudeAuthMode === 'oauth'"
            class="setting-group"
          >
            <label class="setting-label">Claude Max / Pro Subscription</label>
            <p class="setting-description claude-oauth-instructions">
              Sign in with your Anthropic account to use your Claude Max or Pro subscription.
              We'll open a browser window for you to authorize.
            </p>
            <button
              v-if="!claudeOAuthToken && !claudeOAuthRunning"
              class="btn role-primary"
              @click="startClaudeOAuth"
            >
              Sign in with Claude
            </button>
            <div
              v-if="claudeOAuthRunning"
              class="claude-oauth-progress-container"
            >
              <p class="setting-description">
                {{ claudeOAuthStatus }}
              </p>
              <button
                class="btn role-secondary"
                @click="cancelClaudeOAuth"
              >
                Cancel
              </button>
            </div>
            <div
              v-if="claudeOAuthToken && !claudeOAuthRunning"
              class="claude-oauth-signed-in"
            >
              <span class="claude-status-dot" />
              <span class="setting-description claude-status-text">Signed in</span>
              <button
                class="btn role-secondary"
                @click="disconnectClaudeOAuth"
              >
                Sign out
              </button>
            </div>
            <p
              v-if="claudeOAuthError"
              class="setting-description claude-oauth-error"
            >
              {{ claudeOAuthError }}
            </p>
          </div>

          <!-- Save Button (API key only) -->
          <div
            v-if="claudeAuthMode === 'api-key'"
            class="setting-group"
          >
            <button
              class="btn role-primary"
              :disabled="claudeSaving"
              @click="saveClaudeCredentials"
            >
              {{ claudeSaving ? 'Saving...' : 'Save API Key' }}
            </button>
          </div>

          <!-- Status -->
          <div
            v-if="claudeAuthMode !== 'none' && (claudeApiKey || claudeOAuthToken)"
            class="setting-group"
          >
            <div class="claude-status">
              <span class="claude-status-dot" />
              <span class="setting-description claude-status-text">
                Claude Code credentials configured. They will be injected into the VM on next boot.
              </span>
            </div>
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

.claude-auth-buttons {
  display: flex;
  gap: 0.5rem;
  margin-top: 0.5rem;
}

.claude-input-row {
  display: flex;
  gap: 0.5rem;
  align-items: center;
}

.claude-input-field {
  flex: 1;
}

.claude-oauth-instructions {
  margin-bottom: 0.5rem;
}

.claude-oauth-textarea {
  font-family: var(--font-mono);
  font-size: 12px;
  resize: vertical;
  width: 100%;
}

.claude-status {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.claude-status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--status-success, #3fb950);
}

.claude-status-text {
  margin: 0;
}

.claude-oauth-progress-container {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  margin-top: 0.5rem;
}

.claude-oauth-paste-row {
  display: flex;
  gap: 0.5rem;
  align-items: center;
}

.claude-oauth-signed-in {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-top: 0.5rem;
}

.claude-oauth-error {
  color: var(--status-error, #f85149);
  margin-top: 0.5rem;
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
