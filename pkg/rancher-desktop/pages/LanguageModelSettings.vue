<script lang="ts">

import { IpcRendererEvent } from 'electron';
import { defineComponent } from 'vue';

// Import soul prompt from TypeScript file
import { SullaSettingsModel } from '../agent/database/models/SullaSettingsModel';
import { getSupportedProviders, fetchModelsForProvider, clearModelCache } from '../agent/languagemodels';
import { heartbeatPrompt } from '../agent/prompts/heartbeat';
import { soulPrompt } from '../agent/prompts/soul';
import { useTheme } from '../composables/useTheme';
import { REMOTE_PROVIDERS } from '../shared/remoteProviders';

import { ipcRenderer } from '@pkg/utils/ipcRenderer';

// Nav items for the Language Model Settings sidebar
const navItems = [
  { id: 'overview', name: 'Overview' },
  { id: 'models', name: 'Models' },
  { id: 'system-prompt', name: 'System Prompt' },
  { id: 'heartbeat', name: 'Heartbeat' },
];

// Shape of a system-prompt section row returned by the `system-prompt:*` IPC.
interface SystemPromptSectionRow {
  id:            string;
  title:         string;
  content:       string;
  priority:      number;
  enabled:       boolean;
  is_builtin:    boolean;
  is_generated:  boolean;
  is_customized: boolean;
}

// A staged, AI-proposed edit awaiting human review (`system-prompt-edits:*`).
interface SectionEditRow {
  id:               string;
  section_id:       string;
  proposed_content: string;
  base_content:     string;
  rationale:        string | null;
  status:           string;
  proposed_by:      string | null;
  created_at:       string;
}

type DiffLine = { type: 'ctx' | 'add' | 'del'; text: string };

export default defineComponent({
  name: 'language-model-settings',

  setup() {
    // Initialize theme system so this window receives theme changes
    const { currentTheme, isDark } = useTheme();

    return { currentTheme, isDark };
  },

  data() {
    return {
      currentNav:            'overview' as string,
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
      // Automated Project Management (protected routine concurrency + custody)
      automatedProjectManagementEnabled: true,
      routineConcurrencyPlanning:  1,
      routineConcurrencyExecution: 3,
      routineConcurrencyReview:    3,
      routineConcurrencyRepair:    2,
      routineConcurrencyDreaming:  1,
      routineConcurrencyOther:     2,
      routineConcurrencyTotalLimit: 0,
      projectWipBacklog:   0,
      projectWipPlanning:  2,
      projectWipExecution: 3,
      projectWipReview:    3,
      projectWipBlocked:   3,
      projectWipTerminal:  0,
      projectWipManual:    0,
      // Heartbeat settings
      heartbeatEnabled:      true,
      heartbeatDelayMinutes: 15,
      heartbeatPrompt:       '',
      heartbeatProvider:     'default' as string, // 'default' = use primary provider, or a specific provider id
      subconsciousProvider:  'default' as string, // 'default' = use primary provider, or a specific provider id

      // Per-slot model overrides ('' = use provider's integration config default)
      secondaryModelId:      '' as string,
      subconsciousModelId:   '' as string,

      // Models lists for each provider slot
      primaryModels:         [] as { id: string; name: string }[],
      secondaryModels:       [] as { id: string; name: string }[],
      subconsciousModels:    [] as { id: string; name: string }[],

      // Soul prompt settings
      soulPrompt:      '',
      botName:         'Sulla',
      primaryUserName: '',

      // System Prompt tab — DB-backed editable sections (master → detail)
      systemPromptSections: [] as SystemPromptSectionRow[],
      selectedSectionId:    '' as string,   // '' = list view; id = detail view
      sectionDraft:         '' as string,   // working copy of the open section's content
      envGeneratedPreview:  '' as string,   // read-only runtime-generated tail for `environment`
      loadingSections:      false,
      savingSection:        false,
      sectionError:         '' as string,

      // Staged AI-proposed edits awaiting review (approve / edit / deny)
      pendingEdits:         [] as SectionEditRow[],
      reviewingEditId:      '' as string,   // '' = not reviewing; id = review view
      editApproveMode:      false,          // false = diff view, true = amend-before-approve
      editApproveDraft:     '' as string,
      reviewError:          '' as string,

      // Default prompts for reset
      soulPromptDefault:      soulPrompt,
      heartbeatPromptDefault: heartbeatPrompt,

      // Primary / Secondary provider selection
      primaryProvider:      'grok' as string,
      secondaryProvider:    'grok' as string,
      availableProviders:   [] as { id: string; name: string }[],

      // Activation state
      activating:             false,
      activationError:        '' as string,
      savingSettings:         false,
      // Guard flag to prevent feedback loop between primaryProvider watcher and IPC handler
      _suppressProviderWatch: false,
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
    selectedSection(): SystemPromptSectionRow | null {
      return this.systemPromptSections.find(s => s.id === this.selectedSectionId) || null;
    },
    reviewingEdit(): SectionEditRow | null {
      return this.pendingEdits.find(e => e.id === this.reviewingEditId) || null;
    },
    reviewingEditSection(): SystemPromptSectionRow | null {
      const e = this.reviewingEdit;
      return e ? (this.systemPromptSections.find(s => s.id === e.section_id) || null) : null;
    },
    reviewingEditIndex(): number {
      return this.pendingEdits.findIndex(e => e.id === this.reviewingEditId);
    },
    pendingCountBySection(): Record<string, number> {
      const counts: Record<string, number> = {};
      for (const e of this.pendingEdits) counts[e.section_id] = (counts[e.section_id] || 0) + 1;
      return counts;
    },
    reviewDiff(): DiffLine[] {
      const e = this.reviewingEdit;
      return e ? this.diffLines(e.base_content, e.proposed_content) : [];
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
    this.subconsciousProvider = await SullaSettingsModel.get('subconsciousProvider', 'default');
    this.heartbeatDelayMinutes = await SullaSettingsModel.get('heartbeatDelayMinutes', 15);
    this.automatedProjectManagementEnabled = Boolean(await SullaSettingsModel.get('automatedProjectManagementEnabled', true));
    this.routineConcurrencyPlanning  = Number(await SullaSettingsModel.get('routineConcurrency_planning', 1));
    this.routineConcurrencyExecution = Number(await SullaSettingsModel.get('routineConcurrency_execution', 3));
    this.routineConcurrencyReview    = Number(await SullaSettingsModel.get('routineConcurrency_review', 3));
    this.routineConcurrencyRepair    = Number(await SullaSettingsModel.get('routineConcurrency_repair', 2));
    this.routineConcurrencyDreaming  = Number(await SullaSettingsModel.get('routineConcurrency_dreaming', 1));
    this.routineConcurrencyOther     = Number(await SullaSettingsModel.get('routineConcurrency_other', 2));
    this.routineConcurrencyTotalLimit = Number(await SullaSettingsModel.get('routineConcurrencyTotalLimit', 0));
    this.projectWipBacklog   = Number(await SullaSettingsModel.get('projectAutomation.wip.backlog', 0));
    this.projectWipPlanning  = Number(await SullaSettingsModel.get('projectAutomation.wip.planning', 2));
    this.projectWipExecution = Number(await SullaSettingsModel.get('projectAutomation.wip.execution', 3));
    this.projectWipReview    = Number(await SullaSettingsModel.get('projectAutomation.wip.review', 3));
    this.projectWipBlocked   = Number(await SullaSettingsModel.get('projectAutomation.wip.blocked', 3));
    this.projectWipTerminal  = Number(await SullaSettingsModel.get('projectAutomation.wip.terminal', 0));
    this.projectWipManual    = Number(await SullaSettingsModel.get('projectAutomation.wip.manual', 0));
    this.botName = await SullaSettingsModel.get('botName', 'Sulla');
    this.primaryUserName = await SullaSettingsModel.get('primaryUserName', '');
    // Load provider/model state from ModelProviderService (source of truth)
    try {
      const mpsState = await ipcRenderer.invoke('model-provider:get-state');
      this.activeMode = mpsState.modelMode;
      this.viewingTab = mpsState.modelMode;
      this.primaryProvider = mpsState.primaryProvider;
      this.secondaryProvider = mpsState.secondaryProvider;
      this.subconsciousProvider = mpsState.subconsciousProvider || 'default';
      this.secondaryModelId = mpsState.secondaryModelId || '';
      this.subconsciousModelId = mpsState.subconsciousModelId || '';
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
        .filter((p: { id: string; name: string; connected?: boolean }) => p.connected !== false)
        .map((p: { id: string; name: string; connected?: boolean }) => ({
          id: p.id, name: p.name,
        }));
    } catch (err) {
      console.warn('[LM Settings] Failed to load available providers:', err);
    }

    // Load remote models if API key exists
    if (this.selectedProvider && this.apiKey.trim()) {
      await this.loadRemoteModels();
    }

    // Load model lists for all three provider slots
    await this.loadSlotModels();

    // Load DB-backed system prompt sections + any staged AI edits for review
    await this.loadSystemPromptSections();
    await this.loadPendingEdits();

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

    // Watch secondary provider — persist via ModelProviderService + reload model list
    async secondaryProvider(newProvider: string, oldProvider: string) {
      if (!newProvider || newProvider === oldProvider) return;
      try {
        await ipcRenderer.invoke('model-provider:set-secondary', newProvider);
        this.secondaryModels = await ipcRenderer.invoke('model-provider:get-models', newProvider);
      } catch (err) {
        console.error('[LM Settings] Failed to set secondary provider:', err);
      }
    },

    // Watch secondary model override
    async secondaryModelId(newId: string, oldId: string) {
      // Skip no-op re-syncs: handleProviderStateChanged re-assigns this from the
      // service's broadcast state, which would otherwise fire a redundant persist.
      if (newId === oldId) return;
      try {
        await ipcRenderer.invoke('model-provider:set-secondary-model', newId);
      } catch (err) {
        console.error('[LM Settings] Failed to set secondary model:', err);
      }
    },

    // Watch subconscious provider — persist + reload model list
    async subconsciousProvider(newProvider: string, oldProvider: string) {
      if (newProvider === oldProvider) return;
      try {
        await ipcRenderer.invoke('model-provider:set-subconscious', newProvider);
        const effectiveProvider = newProvider === 'default' ? this.primaryProvider : newProvider;
        if (effectiveProvider) {
          this.subconsciousModels = await ipcRenderer.invoke('model-provider:get-models', effectiveProvider);
        }
      } catch (err) {
        console.error('[LM Settings] Failed to set subconscious provider:', err);
      }
    },

    // Watch subconscious model override
    async subconsciousModelId(newId: string, oldId: string) {
      // Skip no-op re-syncs: handleProviderStateChanged re-assigns this from the
      // service's broadcast state, which would otherwise fire a redundant persist
      // and could re-pin a stale model id (source of the subconscious model drift).
      if (newId === oldId) return;
      try {
        await ipcRenderer.invoke('model-provider:set-subconscious-model', newId);
      } catch (err) {
        console.error('[LM Settings] Failed to set subconscious model:', err);
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

        // Reload primary model list for the new provider
        try {
          this.primaryModels = await ipcRenderer.invoke('model-provider:get-models', newProvider) || [];
        } catch { /* ignore */ }
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
          automatedProjectManagementEnabled:        Boolean(this.automatedProjectManagementEnabled),
          routineConcurrency_planning:  Number(this.routineConcurrencyPlanning),
          routineConcurrency_execution: Number(this.routineConcurrencyExecution),
          routineConcurrency_review:    Number(this.routineConcurrencyReview),
          routineConcurrency_repair:    Number(this.routineConcurrencyRepair),
          routineConcurrency_dreaming:  Number(this.routineConcurrencyDreaming),
          routineConcurrency_other:     Number(this.routineConcurrencyOther),
          routineConcurrencyTotalLimit: Number(this.routineConcurrencyTotalLimit),
          'projectAutomation.wip.backlog':   Number(this.projectWipBacklog),
          'projectAutomation.wip.planning':  Number(this.projectWipPlanning),
          'projectAutomation.wip.execution': Number(this.projectWipExecution),
          'projectAutomation.wip.review':    Number(this.projectWipReview),
          'projectAutomation.wip.blocked':   Number(this.projectWipBlocked),
          'projectAutomation.wip.terminal':  Number(this.projectWipTerminal),
          'projectAutomation.wip.manual':    Number(this.projectWipManual),
          heartbeatPrompt:       String(this.heartbeatPrompt || ''),
          heartbeatProvider:     String(this.heartbeatProvider || 'default'),
          subconsciousProvider:  String(this.subconsciousProvider || 'default'),
          ...extra,
        };

        // Define cast types for settings
        const settingCasts: Record<string, string> = {
          remoteRetryCount:      'number',
          remoteTimeoutSeconds:  'number',
          heartbeatDelayMinutes: 'number',
          heartbeatEnabled:      'boolean',
          automatedProjectManagementEnabled:        'boolean',
          routineConcurrency_planning:  'number',
          routineConcurrency_execution: 'number',
          routineConcurrency_review:    'number',
          routineConcurrency_repair:    'number',
          routineConcurrency_dreaming:  'number',
          routineConcurrency_other:     'number',
          routineConcurrencyTotalLimit: 'number',
          'projectAutomation.wip.backlog':   'number',
          'projectAutomation.wip.planning':  'number',
          'projectAutomation.wip.execution': 'number',
          'projectAutomation.wip.review':    'number',
          'projectAutomation.wip.blocked':   'number',
          'projectAutomation.wip.terminal':  'number',
          'projectAutomation.wip.manual':    'number',
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

    // ── System Prompt tab (DB-backed sections) ──────────────────────────
    async loadSystemPromptSections() {
      this.loadingSections = true;
      this.sectionError = '';
      try {
        this.systemPromptSections = await ipcRenderer.invoke('system-prompt:list') || [];
      } catch (err) {
        console.error('[LM Settings] Failed to load system prompt sections:', err);
        this.sectionError = 'Could not load system prompt sections.';
      } finally {
        this.loadingSections = false;
      }
    },

    async openSection(id: string) {
      const section = this.systemPromptSections.find(s => s.id === id);
      if (!section) return;
      this.selectedSectionId = id;
      this.sectionDraft = section.content;
      this.sectionError = '';
      this.envGeneratedPreview = '';
      // For generated sections (e.g. environment) fetch the live read-only tail.
      if (section.is_generated) {
        try {
          this.envGeneratedPreview = await ipcRenderer.invoke('system-prompt:preview-generated', id) || '';
        } catch (err) {
          console.warn('[LM Settings] Failed to load generated preview for', id, err);
        }
      }
    },

    closeSection() {
      this.selectedSectionId = '';
      this.sectionDraft = '';
      this.envGeneratedPreview = '';
    },

    async saveSection() {
      if (!this.selectedSection || this.savingSection) return;
      this.savingSection = true;
      this.sectionError = '';
      try {
        const updated = await ipcRenderer.invoke('system-prompt:update', this.selectedSection.id, { content: this.sectionDraft });
        if (updated) this.applyUpdatedSection(updated);
      } catch (err) {
        console.error('[LM Settings] Failed to save section:', err);
        this.sectionError = 'Failed to save this section.';
      } finally {
        this.savingSection = false;
      }
    },

    async toggleSection(section: SystemPromptSectionRow) {
      try {
        const updated = await ipcRenderer.invoke('system-prompt:update', section.id, { enabled: !section.enabled });
        if (updated) this.applyUpdatedSection(updated);
      } catch (err) {
        console.error('[LM Settings] Failed to toggle section:', err);
      }
    },

    async resetSection(section: SystemPromptSectionRow) {
      try {
        const updated = await ipcRenderer.invoke('system-prompt:reset', section.id);
        if (updated) {
          this.applyUpdatedSection(updated);
          if (this.selectedSectionId === section.id) this.sectionDraft = updated.content;
        }
      } catch (err) {
        console.error('[LM Settings] Failed to reset section:', err);
      }
    },

    async addSection() {
      const title = String(window.prompt('New section title (e.g. Business Context):') || '').trim();
      if (!title) return;
      const id = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
      if (!id) return;
      try {
        const created = await ipcRenderer.invoke('system-prompt:add', { id, title, priority: 100 });
        if (created) {
          await this.loadSystemPromptSections();
          this.openSection(created.id);
        }
      } catch (err) {
        console.error('[LM Settings] Failed to add section:', err);
        this.sectionError = 'Could not add section (id may already exist).';
      }
    },

    async deleteSection(section: SystemPromptSectionRow) {
      if (section.is_builtin) return; // builtin rows can be disabled/reset, not deleted
      if (!window.confirm(`Delete the "${ section.title }" section? This cannot be undone.`)) return;
      try {
        await ipcRenderer.invoke('system-prompt:remove', section.id);
        if (this.selectedSectionId === section.id) this.closeSection();
        await this.loadSystemPromptSections();
      } catch (err) {
        console.error('[LM Settings] Failed to delete section:', err);
      }
    },

    // Merge an updated row back into the in-memory list without a full reload.
    applyUpdatedSection(updated: SystemPromptSectionRow) {
      const idx = this.systemPromptSections.findIndex(s => s.id === updated.id);
      if (idx !== -1) this.systemPromptSections.splice(idx, 1, updated);
    },

    sectionSnippet(content: string): string {
      const oneLine = String(content || '').replace(/\s+/g, ' ').trim();
      return oneLine.length > 90 ? `${ oneLine.slice(0, 90) }…` : (oneLine || 'Empty');
    },

    // ── Staged AI edits: review queue ──────────────────────────────────
    async loadPendingEdits() {
      try {
        this.pendingEdits = await ipcRenderer.invoke('system-prompt-edits:list-pending') || [];
      } catch (err) {
        console.error('[LM Settings] Failed to load pending edits:', err);
      }
    },

    sectionTitle(sectionId: string): string {
      return this.systemPromptSections.find(s => s.id === sectionId)?.title || sectionId;
    },

    openReview(editId: string) {
      const edit = this.pendingEdits.find(e => e.id === editId);
      if (!edit) return;
      this.reviewingEditId = editId;
      this.editApproveMode = false;
      this.editApproveDraft = edit.proposed_content;
      this.reviewError = '';
      // Leave any open section editor — the review takes over the panel.
      this.selectedSectionId = '';
    },

    openFirstPendingForSection(sectionId: string) {
      const edit = this.pendingEdits.find(e => e.section_id === sectionId);
      if (edit) this.openReview(edit.id);
    },

    closeReview() {
      this.reviewingEditId = '';
      this.editApproveMode = false;
      this.editApproveDraft = '';
      this.reviewError = '';
    },

    // After a review action, jump to the next pending edit or exit the queue.
    advanceReviewQueue() {
      const next = this.pendingEdits[0];
      if (next) this.openReview(next.id);
      else this.closeReview();
    },

    async approveEdit() {
      const edit = this.reviewingEdit;
      if (!edit) return;
      this.reviewError = '';
      try {
        const finalContent = this.editApproveMode ? this.editApproveDraft : undefined;
        await ipcRenderer.invoke('system-prompt-edits:approve', edit.id, finalContent);
        await Promise.all([this.loadSystemPromptSections(), this.loadPendingEdits()]);
        this.advanceReviewQueue();
      } catch (err) {
        console.error('[LM Settings] Failed to approve edit:', err);
        this.reviewError = 'Failed to approve this change.';
      }
    },

    async denyEdit() {
      const edit = this.reviewingEdit;
      if (!edit) return;
      this.reviewError = '';
      try {
        await ipcRenderer.invoke('system-prompt-edits:deny', edit.id);
        await this.loadPendingEdits();
        this.advanceReviewQueue();
      } catch (err) {
        console.error('[LM Settings] Failed to deny edit:', err);
        this.reviewError = 'Failed to deny this change.';
      }
    },

    // Compact LCS line diff (base → proposed). Prompts are at most a few hundred
    // lines, so the O(n*m) table is negligible.
    diffLines(base: string, proposed: string): DiffLine[] {
      const a = String(base || '').split('\n');
      const b = String(proposed || '').split('\n');
      const n = a.length;
      const m = b.length;
      const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
      for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
          dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
      }
      const out: DiffLine[] = [];
      let i = 0;
      let j = 0;
      while (i < n && j < m) {
        if (a[i] === b[j]) { out.push({ type: 'ctx', text: a[i] }); i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ type: 'del', text: a[i] }); i++; } else { out.push({ type: 'add', text: b[j] }); j++; }
      }
      while (i < n) { out.push({ type: 'del', text: a[i] }); i++; }
      while (j < m) { out.push({ type: 'add', text: b[j] }); j++; }
      return out;
    },

    closeWindow() {
      window.close();
    },

    async onPrimaryModelChange(event: Event) {
      const modelId = (event.target as HTMLSelectElement).value;
      try {
        const newState = await ipcRenderer.invoke('model-provider:select-model', this.primaryProvider, modelId);
        this.activeModel = newState.activeModelId;
        this.selectedRemoteModel = newState.activeModelId;
      } catch (err) {
        console.error('[LM Settings] Failed to change primary model:', err);
      }
    },

    // Load model lists for primary, secondary, and subconscious provider slots
    async loadSlotModels() {
      try {
        const [primary, secondary] = await Promise.all([
          ipcRenderer.invoke('model-provider:get-models', this.primaryProvider),
          ipcRenderer.invoke('model-provider:get-models', this.secondaryProvider),
        ]);
        this.primaryModels = primary || [];
        this.secondaryModels = secondary || [];

        const effectiveSubProvider = this.subconsciousProvider === 'default'
          ? this.primaryProvider
          : this.subconsciousProvider;
        if (effectiveSubProvider) {
          this.subconsciousModels = await ipcRenderer.invoke('model-provider:get-models', effectiveSubProvider) || [];
        }
      } catch (err) {
        console.warn('[LM Settings] Failed to load slot model lists:', err);
      }
    },

    // Handle state changes from ModelProviderService (source of truth)
    handleProviderStateChanged(
      _event: IpcRendererEvent,
      state: { primaryProvider: string; secondaryProvider: string; subconsciousProvider: string; activeModelId: string; modelMode: 'local' | 'remote'; secondaryModelId: string; subconsciousModelId: string },
    ) {
      this.activeModel = state.activeModelId;
      this.activeMode = state.modelMode;
      this.pendingModel = state.activeModelId;
      if (state.secondaryModelId !== undefined) this.secondaryModelId = state.secondaryModelId;
      if (state.subconsciousModelId !== undefined) this.subconsciousModelId = state.subconsciousModelId;
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

          <!-- Primary Model -->
          <div class="setting-group setting-group--indent">
            <label class="setting-label">Primary Model</label>
            <select
              v-model="selectedRemoteModel"
              class="model-select"
              @change="onPrimaryModelChange"
            >
              <option
                v-if="primaryModels.length === 0"
                value=""
                disabled
              >
                Loading models...
              </option>
              <option
                v-for="model in primaryModels"
                :key="model.id"
                :value="model.id"
              >
                {{ model.name }}
              </option>
            </select>
            <p class="setting-description">
              The specific model version to use. "Auto" lets Claude Code pick the best model for each task.
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
              If the primary provider is inaccessible, the agent falls back to this provider.
            </p>
          </div>

          <!-- Secondary Model -->
          <div class="setting-group setting-group--indent">
            <label class="setting-label">Secondary Model Override</label>
            <select
              v-model="secondaryModelId"
              class="model-select"
            >
              <option value="">
                Use provider default
              </option>
              <option value="fast">
                fast (cheapest/fastest tier)
              </option>
              <option value="balanced">
                balanced (mid tier)
              </option>
              <option value="powerful">
                powerful (best tier)
              </option>
              <option
                v-for="model in secondaryModels"
                :key="model.id"
                :value="model.id"
              >
                {{ model.name }}
              </option>
            </select>
            <p class="setting-description">
              Override which model the secondary provider uses. Leave blank to use the provider's configured default.
            </p>
          </div>

          <!-- Subconscious Provider -->
          <div class="setting-group">
            <label class="setting-label">Subconscious Provider</label>
            <select
              v-model="subconsciousProvider"
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
              Provider for background agents (memory recall, observation, unstuck research). "Use Primary Provider" mirrors your primary provider above.
            </p>
          </div>

          <!-- Subconscious Model -->
          <div class="setting-group setting-group--indent">
            <label class="setting-label">Subconscious Model Override</label>
            <select
              v-model="subconsciousModelId"
              class="model-select"
            >
              <option value="">
                Use provider default
              </option>
              <option value="fast">
                fast (cheapest/fastest tier)
              </option>
              <option value="balanced">
                balanced (mid tier)
              </option>
              <option value="powerful">
                powerful (best tier)
              </option>
              <option
                v-for="model in subconsciousModels"
                :key="model.id"
                :value="model.id"
              >
                {{ model.name }}
              </option>
            </select>
            <p class="setting-description">
              Override the model used by subconscious agents. Tier names (fast/balanced/powerful) are resolved dynamically from the provider's live model list. Avoid slow autonomous models here — memory recall needs a fast chat model.
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
              Only connected providers appear in these dropdowns. Open
              <strong>Integrations</strong> to add credentials for Grok, OpenAI, Anthropic, etc.
            </p>
          </div>
        </div>

        <!-- System Prompt Tab -->
        <div
          v-if="currentNav === 'system-prompt'"
          class="tab-content sp-tab"
        >
          <!-- REVIEW VIEW — a staged AI-proposed edit -->
          <template v-if="reviewingEdit">
            <div class="sp-detail-bar">
              <span
                class="sp-back"
                @click="closeReview"
              >‹ Back to sections</span>
              <span class="sp-detail-bar-spacer" />
              <span
                v-if="pendingEdits.length > 1"
                class="sp-detail-meta"
              >{{ reviewingEditIndex + 1 }} of {{ pendingEdits.length }}</span>
            </div>

            <div class="sp-detail-head">
              <h2>{{ sectionTitle(reviewingEdit.section_id) }}</h2>
              <span class="sp-detail-meta">proposed edit · staged, not live</span>
            </div>
            <div class="sp-review-by">
              Proposed by <strong>{{ reviewingEdit.proposed_by || 'an agent' }}</strong>
              <span v-if="reviewingEdit.created_at"> · {{ reviewingEdit.created_at }}</span>
            </div>

            <div
              v-if="reviewingEdit.rationale"
              class="sp-rationale"
            >
              <div class="sp-rationale-label">WHY THIS CHANGE</div>
              <div class="sp-rationale-body">{{ reviewingEdit.rationale }}</div>
            </div>

            <!-- Diff (default) or amend-before-approve editor -->
            <template v-if="!editApproveMode">
              <div class="sp-list-header">PROPOSED CHANGES</div>
              <div class="sp-diff">
                <div
                  v-for="(line, i) in reviewDiff"
                  :key="i"
                  class="sp-diff-line"
                  :class="'sp-diff-' + line.type"
                >
                  <span class="sp-diff-gutter">{{ line.type === 'add' ? '+' : (line.type === 'del' ? '−' : '') }}</span>
                  <span class="sp-diff-text">{{ line.text || ' ' }}</span>
                </div>
              </div>
            </template>
            <template v-else>
              <div class="sp-list-header">AMEND BEFORE APPROVING</div>
              <textarea
                v-model="editApproveDraft"
                class="sp-editor"
                spellcheck="false"
              />
            </template>

            <div
              v-if="reviewError"
              class="activation-error"
            >
              {{ reviewError }}
            </div>

            <div class="sp-detail-actions">
              <button
                class="btn sp-approve-btn"
                @click="approveEdit"
              >
                ✓ {{ editApproveMode ? 'Approve amended' : 'Approve & apply' }}
              </button>
              <button
                class="btn role-secondary"
                @click="editApproveMode = !editApproveMode"
              >
                {{ editApproveMode ? 'View diff' : 'Edit & approve' }}
              </button>
              <button
                class="btn sp-deny-btn"
                @click="denyEdit"
              >
                Deny
              </button>
              <span class="sp-detail-bar-spacer" />
              <span class="sp-review-note">Approving writes this into the live prompt.</span>
            </div>
          </template>

          <!-- LIST VIEW -->
          <template v-else-if="!selectedSectionId">
            <h2>System Prompt</h2>
            <p class="description">
              The compiled system prompt for every Sulla agent. Each row is editable raw markdown, seeded from the shipped defaults. Agent-specific <code>.md</code> files still override these per-agent.
            </p>

            <!-- Staged AI edits awaiting review -->
            <div
              v-if="pendingEdits.length"
              class="sp-review-banner"
            >
              <span class="sp-review-banner-icon">⏳</span>
              <div class="sp-review-banner-text">
                <div class="sp-review-banner-title">
                  {{ pendingEdits.length }} proposed edit{{ pendingEdits.length === 1 ? '' : 's' }} awaiting your review
                </div>
                <div class="sp-review-banner-sub">Staged by Sulla — nothing is live until you approve.</div>
              </div>
              <button
                class="btn sp-review-banner-btn"
                @click="openReview(pendingEdits[0].id)"
              >
                Review
              </button>
            </div>

            <!-- Identity fields -->
            <div class="sp-identity">
              <div class="form-group">
                <label class="form-label">Sulla's Name</label>
                <input
                  v-model="botName"
                  type="text"
                  class="text-input"
                  placeholder="Sulla"
                >
              </div>
              <div class="form-group">
                <label class="form-label">Human's Name</label>
                <input
                  v-model="primaryUserName"
                  type="text"
                  class="text-input"
                  placeholder="Your name (optional)"
                >
              </div>
            </div>

            <div class="sp-list-header">
              SECTIONS · compiled top → bottom by priority
            </div>

            <div
              v-if="sectionError"
              class="activation-error"
            >
              {{ sectionError }}
            </div>

            <div class="sp-list">
              <div
                v-for="section in systemPromptSections"
                :key="section.id"
                class="sp-row"
                :class="{ 'sp-row--disabled': !section.enabled }"
                @click="openSection(section.id)"
              >
                <span class="sp-grip">⋮⋮</span>
                <div class="sp-row-main">
                  <div class="sp-row-title">
                    {{ section.title }}
                    <span
                      v-if="pendingCountBySection[section.id]"
                      class="sp-badge sp-badge--pending"
                      @click.stop="openFirstPendingForSection(section.id)"
                    >● {{ pendingCountBySection[section.id] }} proposed</span>
                    <span
                      v-if="section.is_generated"
                      class="sp-badge sp-badge--warn"
                    >partly generated</span>
                    <span
                      v-if="section.id === 'heartbeat'"
                      class="sp-badge sp-badge--dim"
                    >heartbeat agent only</span>
                  </div>
                  <div class="sp-row-snippet">
                    {{ sectionSnippet(section.content) }}
                  </div>
                </div>
                <span
                  v-if="section.is_builtin"
                  class="sp-badge sp-badge--accent"
                >builtin</span>
                <span
                  v-else
                  class="sp-badge sp-badge--custom"
                >custom</span>
                <label
                  class="switch"
                  @click.stop
                >
                  <input
                    type="checkbox"
                    :checked="section.enabled"
                    @change="toggleSection(section)"
                  >
                  <span class="slider" />
                </label>
                <span class="sp-chevron">›</span>
              </div>
            </div>

            <div class="sp-list-actions">
              <button
                class="btn role-primary"
                @click="addSection"
              >
                + Add section
              </button>
            </div>
          </template>

          <!-- DETAIL VIEW -->
          <template v-else-if="selectedSection">
            <div class="sp-detail-bar">
              <span
                class="sp-back"
                @click="closeSection"
              >‹ All sections</span>
              <span class="sp-detail-bar-spacer" />
              <span
                v-if="selectedSection.is_builtin"
                class="sp-badge sp-badge--accent"
              >builtin</span>
              <span
                v-else
                class="sp-badge sp-badge--custom"
              >custom</span>
              <button
                v-if="selectedSection.is_builtin"
                class="btn role-secondary sp-mini-btn"
                @click="resetSection(selectedSection)"
              >
                Reset to default
              </button>
              <button
                v-else
                class="btn role-secondary sp-mini-btn"
                @click="deleteSection(selectedSection)"
              >
                Delete
              </button>
              <label class="switch">
                <input
                  type="checkbox"
                  :checked="selectedSection.enabled"
                  @change="toggleSection(selectedSection)"
                >
                <span class="slider" />
              </label>
            </div>

            <div class="sp-detail-head">
              <h2>{{ selectedSection.title }}</h2>
              <span class="sp-detail-meta">
                {{ selectedSection.id }} · priority {{ selectedSection.priority }}
                <template v-if="selectedSection.is_customized"> · customized</template>
              </span>
            </div>

            <textarea
              v-model="sectionDraft"
              class="sp-editor"
              spellcheck="false"
              placeholder="Raw markdown for this section…"
            />

            <!-- Read-only runtime-generated tail (environment, etc.) -->
            <div
              v-if="selectedSection.is_generated"
              class="sp-generated"
            >
              <div class="sp-generated-label">🔒 RUNTIME-GENERATED · appended live, read-only</div>
              <pre class="sp-generated-body">{{ envGeneratedPreview || 'Nothing generated right now (e.g. no installed extensions).' }}</pre>
            </div>

            <div
              v-if="sectionError"
              class="activation-error"
            >
              {{ sectionError }}
            </div>

            <div class="sp-detail-actions">
              <button
                class="btn role-primary"
                :disabled="savingSection"
                @click="saveSection"
              >
                {{ savingSection ? 'Saving…' : 'Save' }}
              </button>
            </div>
          </template>
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
            <label class="setting-label">Enable Autonomous Heartbeat (runs every 15 min)</label>
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

          <!-- Automated Project Management -->

          <div class="setting-group">

            <label class="setting-label">Automated Project Management</label>

            <div class="toggle-switch">

              <label class="switch">

                <input

                  v-model="automatedProjectManagementEnabled"

                  type="checkbox"

                >

                <span class="slider" />

              </label>

              <span class="toggle-label">{{ automatedProjectManagementEnabled ? 'Enforcing limits' : 'Disabled' }}</span>

            </div>

            <p class="setting-description">

              Cap how many protected Projects routines may run at once so mechanical work cannot overwhelm system resources. When disabled, the legacy per-pool defaults apply.

            </p>

          </div>

          <div

            v-if="automatedProjectManagementEnabled"

            class="setting-group"

          >

            <label class="setting-label">Concurrent running limits by routine kind</label>

            <div style="display:flex; flex-wrap:wrap; gap:12px;">

              <label class="setting-label" style="display:inline-flex; align-items:center; gap:8px; width:220px;">Planning

                <input v-model.number="routineConcurrencyPlanning" type="number" class="text-input" min="0" max="32" style="width: 80px;">

              </label>

              <label class="setting-label" style="display:inline-flex; align-items:center; gap:8px; width:220px;">Execution

                <input v-model.number="routineConcurrencyExecution" type="number" class="text-input" min="0" max="32" style="width: 80px;">

              </label>

              <label class="setting-label" style="display:inline-flex; align-items:center; gap:8px; width:220px;">Review

                <input v-model.number="routineConcurrencyReview" type="number" class="text-input" min="0" max="32" style="width: 80px;">

              </label>

              <label class="setting-label" style="display:inline-flex; align-items:center; gap:8px; width:220px;">Repair

                <input v-model.number="routineConcurrencyRepair" type="number" class="text-input" min="0" max="32" style="width: 80px;">

              </label>

              <label class="setting-label" style="display:inline-flex; align-items:center; gap:8px; width:220px;">Dreaming

                <input v-model.number="routineConcurrencyDreaming" type="number" class="text-input" min="0" max="32" style="width: 80px;">

              </label>

              <label class="setting-label" style="display:inline-flex; align-items:center; gap:8px; width:220px;">Other

                <input v-model.number="routineConcurrencyOther" type="number" class="text-input" min="0" max="32" style="width: 80px;">

              </label>

              <label class="setting-label" style="display:inline-flex; align-items:center; gap:8px; width:220px;">Total cap (0 = none)

                <input v-model.number="routineConcurrencyTotalLimit" type="number" class="text-input" min="0" max="32" style="width: 80px;">

              </label>

            </div>

            <p class="setting-description">

              Maximum simultaneously-running protected routines per kind (0 pauses that kind). Enforced atomically at launch across planning, execution, review, repair, dreaming, and other core routines.

            </p>

          </div>

          <div
            v-if="automatedProjectManagementEnabled"
            class="setting-group"
          >
            <label class="setting-label">Projects work-in-progress limits by semantic stage</label>
            <div style="display:flex; flex-wrap:wrap; gap:12px;">
              <label class="setting-label" style="display:inline-flex; align-items:center; gap:8px; width:220px;">Backlog intake
                <input v-model.number="projectWipBacklog" type="number" class="text-input" min="0" max="20" style="width:80px;">
              </label>
              <label class="setting-label" style="display:inline-flex; align-items:center; gap:8px; width:220px;">Planning
                <input v-model.number="projectWipPlanning" type="number" class="text-input" min="0" max="20" style="width:80px;">
              </label>
              <label class="setting-label" style="display:inline-flex; align-items:center; gap:8px; width:220px;">Execution
                <input v-model.number="projectWipExecution" type="number" class="text-input" min="0" max="20" style="width:80px;">
              </label>
              <label class="setting-label" style="display:inline-flex; align-items:center; gap:8px; width:220px;">Review
                <input v-model.number="projectWipReview" type="number" class="text-input" min="0" max="20" style="width:80px;">
              </label>
              <label class="setting-label" style="display:inline-flex; align-items:center; gap:8px; width:220px;">Blocked recovery
                <input v-model.number="projectWipBlocked" type="number" class="text-input" min="0" max="20" style="width:80px;">
              </label>
              <label class="setting-label" style="display:inline-flex; align-items:center; gap:8px; width:220px;">Terminal handoff
                <input v-model.number="projectWipTerminal" type="number" class="text-input" min="0" max="20" style="width:80px;">
              </label>
              <label class="setting-label" style="display:inline-flex; align-items:center; gap:8px; width:220px;">Custom/manual lanes
                <input v-model.number="projectWipManual" type="number" class="text-input" min="0" max="20" style="width:80px;">
              </label>
            </div>
            <p class="setting-description">
              Counts queued and active work after resolving each project lane to its semantic role. Zero means unlimited. Saturated downstream stages pause new upstream claims without moving tasks or adding comments.
            </p>
          </div>

          <div

            v-if="automatedProjectManagementEnabled"

            class="setting-group"

          >

            <label class="setting-label">Artifact-evidence custody</label>

            <p class="setting-description">

              Always enforced. A task cannot enter review unless coding work records branch, commit SHA, PR URL, head SHA, validation evidence, and provenance (or non-code work records an authoritative artifact id/URL and evidence).

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

          <!-- Subconscious Provider Setting -->
          <div class="setting-group">
            <label class="setting-label">Subconscious Provider</label>
            <select
              v-model="subconsciousProvider"
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
              Subconscious agents (memory recall, observation, unstuck research) run in the background and need a fast tool-emitting chat model. "Use Primary Provider" mirrors your main provider. Avoid autonomous models like Claude Code here — they over-invest in quick recall tasks.
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

  &.setting-group--indent {
    margin-left: 1.25rem;
    padding-left: 1rem;
    border-left: 2px solid var(--border-muted, rgba(255,255,255,0.1));
    margin-bottom: 1.25rem;
  }

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

<!-- ─────────────────────────────────────────────────────────────
     Unified "noir / steel-blue" restyle. This block is intentionally
     LAST so its rules win at equal specificity, retuning the shared
     chrome (header, sidebar, inputs, buttons) across EVERY tab, plus
     the System Prompt master → detail styles.
     ───────────────────────────────────────────────────────────── -->
<style lang="scss" scoped>
.lm-settings {
  // Theme-driven aliases. Every value resolves from the ACTIVE theme's tokens
  // (Protocol gives the steel-blue/noir/mono look; Ocean/Nord/Default give
  // their own). Fallbacks are generic (never a pinned brand colour) so nothing
  // is hardcoded and every theme renders correctly.
  --sp-accent:        var(--accent-primary);
  --sp-accent-dim:    var(--bg-active, var(--bg-surface-hover));
  --sp-accent-border: var(--border-accent, var(--border-default));
  --sp-bg:            var(--bg-page, var(--bg));
  --sp-surface-1:     var(--bg-surface, var(--surface-1));
  --sp-surface-2:     var(--bg-surface-alt, var(--surface-2));
  --sp-surface-3:     var(--bg-surface-hover, var(--surface-3));
  --sp-border:        var(--border-default, var(--border-muted));
  --sp-text:          var(--text-primary, var(--text));
  --sp-text-muted:    var(--text-muted);
  --sp-text-dim:      var(--text-dim, var(--text-muted));

  // Body font follows the theme's monospace token; headings follow an optional
  // per-theme display token, falling back to inherit (never a pinned face).
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  background: var(--sp-bg);
  color: var(--sp-text);
}

.lm-header {
  background: var(--sp-surface-1);

  h1 {
    font-family: var(--font-display, inherit);
    font-size: 1.1rem;
    letter-spacing: 0.01em;
  }
}

.lm-nav {
  background: var(--sp-surface-1);

  .nav-item {
    font-size: 0.82rem;

    &.active {
      background: var(--sp-accent-dim);
      color: var(--sp-text);
      border-left: 2px solid var(--sp-accent);
    }

    &:hover:not(.active) {
      background: var(--sp-surface-2);
    }
  }
}

.tab-content {
  h2 {
    font-family: var(--font-display, inherit);
    font-size: 1.35rem;
    font-weight: 600;
  }
}

// Shared form controls — retuned for the whole window.
.text-input,
.model-select {
  background-color: var(--sp-surface-2);
  border: 1px solid var(--sp-border);
  border-radius: 6px;
  color: var(--sp-text);
  font-family: inherit;
  font-size: 0.82rem;

  &:focus {
    outline: none;
    border-color: var(--sp-accent);
  }
}

.btn.role-primary {
  background: var(--sp-accent);
  border-color: var(--sp-accent);
  color: var(--text-on-accent, #fff);
  font-weight: 600;
}

.switch input:checked + .slider {
  background-color: var(--sp-accent);
}

// ── System Prompt tab ───────────────────────────────────────────
.sp-identity {
  display: flex;
  gap: 1rem;
  margin-bottom: 1.5rem;
  max-width: 640px;

  .form-group { flex: 1; }

  .form-label {
    display: block;
    font-size: 0.7rem;
    letter-spacing: 0.04em;
    color: var(--sp-text-dim);
    margin-bottom: 0.35rem;
    text-transform: uppercase;
  }

  .text-input { width: 100%; }
}

.sp-list-header {
  font-size: 0.7rem;
  letter-spacing: 0.05em;
  color: var(--sp-text-dim);
  margin-bottom: 0.6rem;
}

.sp-list {
  border: 1px solid var(--sp-border);
  border-radius: 8px;
  overflow: hidden;
}

.sp-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.8rem 0.85rem;
  border-bottom: 1px solid var(--sp-border);
  cursor: pointer;
  transition: background 0.12s;

  &:last-child { border-bottom: none; }
  &:hover { background: var(--sp-surface-1); }
  &--disabled { opacity: 0.5; }

  .sp-grip {
    color: var(--sp-text-dim);
    cursor: grab;
    font-size: 0.8rem;
  }

  .sp-row-main { flex: 1; min-width: 0; }

  .sp-row-title {
    font-size: 0.85rem;
    color: var(--sp-text);
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }

  .sp-row-snippet {
    font-size: 0.72rem;
    color: var(--sp-text-dim);
    margin-top: 0.2rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .sp-chevron {
    color: var(--sp-text-dim);
    font-size: 1.1rem;
  }
}

.sp-badge {
  font-size: 0.62rem;
  padding: 0.12rem 0.4rem;
  border-radius: 4px;
  border: 1px solid var(--sp-border);
  color: var(--sp-text-muted);
  white-space: nowrap;

  &--accent { color: var(--sp-accent); border-color: var(--sp-accent-border); }
  &--custom { color: var(--status-info, var(--info)); border-color: var(--border-info, var(--sp-border)); }
  &--warn   { color: var(--status-warning, var(--warning)); border-color: var(--border-warning, var(--sp-border)); }
  &--dim    { color: var(--sp-text-dim); }
}

.sp-list-actions { margin-top: 0.85rem; }

// Detail view
.sp-tab {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.sp-detail-bar {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  margin-bottom: 0.75rem;

  .sp-detail-bar-spacer { flex: 1; }
}

.sp-back {
  color: var(--sp-accent);
  font-size: 0.82rem;
  cursor: pointer;

  &:hover { text-decoration: underline; }
}

.sp-mini-btn {
  font-size: 0.72rem;
  padding: 0.25rem 0.6rem;
}

.sp-detail-head {
  display: flex;
  align-items: baseline;
  gap: 0.6rem;
  margin-bottom: 0.85rem;

  h2 { margin: 0; }

  .sp-detail-meta {
    font-size: 0.72rem;
    color: var(--sp-text-dim);
  }
}

.sp-editor {
  flex: 1;
  min-height: 320px;
  width: 100%;
  box-sizing: border-box;
  background: var(--sp-surface-2);
  border: 1px solid var(--sp-border);
  border-radius: 8px;
  color: var(--sp-text);
  font-family: var(--font-mono, ui-monospace, Menlo, monospace);
  font-size: 0.82rem;
  line-height: 1.6;
  padding: 0.9rem;
  resize: none;

  &:focus { outline: none; border-color: var(--sp-accent); }
}

.sp-generated {
  margin-top: 0.75rem;
  border: 1px dashed var(--sp-border);
  border-radius: 8px;
  background: var(--sp-surface-1);
  padding: 0.65rem 0.8rem;

  .sp-generated-label {
    font-size: 0.65rem;
    letter-spacing: 0.05em;
    color: var(--sp-text-dim);
    margin-bottom: 0.4rem;
  }

  .sp-generated-body {
    margin: 0;
    font-family: var(--font-mono, ui-monospace, Menlo, monospace);
    font-size: 0.72rem;
    color: var(--sp-text-dim);
    white-space: pre-wrap;
    word-break: break-word;
  }
}

.sp-detail-actions {
  margin-top: 0.85rem;
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

// ── Staged AI edits: review banner, pending badge, rationale, diff ──
.sp-review-banner {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 11px 14px;
  margin-bottom: 16px;
  border-radius: 8px;
  background: var(--bg-warning, rgba(254, 188, 46, .08));
  border: 1px solid var(--border-warning, var(--sp-border));

  .sp-review-banner-icon { font-size: 15px; }
  .sp-review-banner-text { flex: 1; }
  .sp-review-banner-title { font-size: 13px; color: var(--sp-text); }
  .sp-review-banner-sub { font-size: 11px; color: var(--sp-text-dim); margin-top: 2px; }

  .sp-review-banner-btn {
    background: var(--status-warning, var(--warning));
    border: none;
    color: var(--text-on-accent, #1a1300);
    font-weight: 600;
    font-size: 12px;
    padding: 7px 13px;
  }
}

.sp-badge--pending {
  color: var(--status-warning, var(--warning));
  border-color: var(--border-warning, var(--sp-border));
  background: var(--bg-warning, rgba(254, 188, 46, .08));
  cursor: pointer;
}

.sp-review-by {
  font-size: 11px;
  color: var(--sp-text-muted);
  margin-bottom: 14px;

  strong { color: var(--sp-text); }
}

.sp-rationale {
  border-left: 2px solid var(--sp-accent);
  background: var(--sp-surface-1);
  padding: 10px 14px;
  border-radius: 0 6px 6px 0;
  margin-bottom: 16px;

  .sp-rationale-label {
    font-size: 10px;
    letter-spacing: .05em;
    color: var(--sp-text-dim);
    margin-bottom: 4px;
  }
  .sp-rationale-body {
    font-size: 12px;
    color: var(--sp-text-muted);
    line-height: 1.5;
  }
}

.sp-diff {
  border: 1px solid var(--sp-border);
  border-radius: 8px;
  overflow: auto;
  max-height: 46vh;
  font-family: var(--font-mono, ui-monospace, Menlo, monospace);
  font-size: 12px;
  line-height: 1.7;
}

.sp-diff-line {
  display: flex;
  gap: 8px;
  padding: 0 10px;
  white-space: pre-wrap;
  word-break: break-word;

  .sp-diff-gutter { width: 0.8em; flex-shrink: 0; text-align: center; opacity: .8; }
  .sp-diff-text { flex: 1; }

  &.sp-diff-ctx  { color: var(--sp-text-dim); }
  &.sp-diff-add  { background: var(--bg-success, rgba(40, 200, 64, .12)); color: var(--status-success, var(--success)); }
  &.sp-diff-del  { background: var(--bg-error, rgba(255, 95, 87, .12)); color: var(--status-error, var(--danger)); }
}

.sp-approve-btn {
  background: var(--status-success, var(--success));
  border: none;
  color: var(--text-on-accent, #04120a);
  font-weight: 600;
}

.sp-deny-btn {
  background: transparent;
  border: 1px solid var(--border-error, var(--sp-border));
  color: var(--status-error, var(--danger));
}

.sp-review-note {
  font-size: 11px;
  color: var(--sp-text-dim);
}
</style>
