<template>
  <div
    class="h-full overflow-hidden font-sans page-root flex flex-col"
    :class="{ dark: isDark }"
  >
    <AgentHeader
      :is-dark="isDark"
      :toggle-theme="toggleTheme"
    />

    <!-- Welcome / New Tab page -->
    <template v-if="tabMode === 'welcome'">
      <div class="flex-1 min-h-0 overflow-hidden">
        <NewTabWelcome
          @start-chat="onStartChat"
          @set-mode="onSetMode"
        />
      </div>
    </template>

    <!-- Browser mode: toolbar + iframe -->
    <template v-else-if="tabMode === 'browser'">
      <div class="flex items-center gap-2 px-4 py-2 browser-toolbar">
        <button
          class="browser-nav-btn"
          type="button"
          aria-label="Go back"
          :disabled="!canGoBack"
          @click="goBack"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" class="h-4 w-4">
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
        <button
          class="browser-nav-btn"
          type="button"
          aria-label="Go forward"
          :disabled="!canGoForward"
          @click="goForward"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" class="h-4 w-4">
            <path d="M9 18l6-6-6-6" />
          </svg>
        </button>
        <button
          class="browser-nav-btn"
          type="button"
          :aria-label="loading ? 'Stop loading' : 'Reload'"
          @click="loading ? stop() : reload()"
        >
          <svg v-if="loading" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" class="h-4 w-4">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
          <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" class="h-4 w-4">
            <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
            <path d="M3 3v5h5" />
            <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
            <path d="M16 16h5v5" />
          </svg>
        </button>

        <form
          class="flex-1"
          @submit.prevent="navigate"
        >
          <input
            ref="addressInput"
            v-model="addressBarUrl"
            type="text"
            class="address-bar"
            placeholder="Search or enter URL"
            @focus="($event.target as HTMLInputElement).select()"
            @keydown.meta.l.prevent="focusAddressBar"
          />
        </form>
      </div>

      <div class="iframe-container">
        <iframe
          ref="iframeRef"
          :src="currentUrl"
          class="browser-frame"
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation"
          referrerpolicy="no-referrer-when-downgrade"
          @load="onFrameLoad"
        />
      </div>
    </template>

    <!-- Embedded page modes -->
    <template v-else-if="tabMode === 'calendar'">
      <div class="flex-1 min-h-0 overflow-auto">
        <AgentCalendar embedded />
      </div>
    </template>

    <template v-else-if="tabMode === 'integrations'">
      <div class="flex-1 min-h-0 overflow-auto">
        <AgentIntegrations embedded />
      </div>
    </template>

    <template v-else-if="tabMode === 'extensions'">
      <div class="flex-1 min-h-0 overflow-auto">
        <AgentExtensions embedded />
      </div>
    </template>

    <!-- Document mode: raw HTML rendered in Shadow DOM -->
    <template v-else-if="tabMode === 'document'">
      <div class="flex-1 min-h-0 overflow-auto bg-[#0d1117]">
        <HtmlMessageRenderer
          v-if="tabContent"
          :content="tabContent"
          :is-dark="isDark"
          :full-page="true"
          class="h-full w-full"
        />
        <div
          v-else
          class="flex h-full items-center justify-center text-sm text-slate-500"
        >
          Document content unavailable
        </div>
      </div>
    </template>

    <!-- Chat mode: independent chat session per tab -->
    <template v-else-if="tabMode === 'chat'">
      <div class="flex-1 min-h-0 overflow-hidden">
        <BrowserTabChat :tab-id="props.tabId" @set-mode="onSetMode" />
      </div>
    </template>

    <!-- Secretary mode: continuous transcription with wake word -->
    <template v-else-if="tabMode === 'secretary'">
      <div class="flex-1 min-h-0 overflow-hidden">
        <SecretaryMode :tab-id="props.tabId" @set-mode="onSetMode" />
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';

import AgentHeader from './agent/AgentHeader.vue';
import NewTabWelcome from './NewTabWelcome.vue';
import AgentCalendar from './AgentCalendar.vue';
import AgentIntegrations from './AgentIntegrations.vue';
import AgentExtensions from './AgentExtensions.vue';
import BrowserTabChat from './BrowserTabChat.vue';
import SecretaryMode from './SecretaryMode.vue';
import HtmlMessageRenderer from '@pkg/components/HtmlMessageRenderer.vue';
import { useBrowserTabs, type BrowserTabMode } from '@pkg/composables/useBrowserTabs';
import { useTheme } from '@pkg/composables/useTheme';
import {
  BRIDGE_CHANNEL,
  WebviewHostBridge,
  setActiveHostBridge,
  hostBridgeRegistry,
  type HostBridgeEventMap,
} from '@pkg/agent/scripts/injected';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

const MODE_TITLES: Record<BrowserTabMode, string> = {
  welcome:      'New Tab',
  browser:      'New Tab',
  chat:         'Chat',
  calendar:     'Calendar',
  integrations: 'Integrations',
  extensions:   'Extensions',
  document:     'Document',
  secretary:    'Secretary',
};

const props = defineProps<{
  tabId:     string;
  isVisible: boolean;
}>();

const { isDark, toggleTheme } = useTheme();
const { updateTab, getTab } = useBrowserTabs();

const tabMode = computed<BrowserTabMode>(() => getTab(props.tabId)?.mode || 'welcome');
const tabContent = computed(() => getTab(props.tabId)?.content || '');

function onSetMode(mode: BrowserTabMode) {
  updateTab(props.tabId, { mode, title: MODE_TITLES[mode] });
}

function onStartChat(_chatQuery: string) {
  // Switch this tab to chat mode
  updateTab(props.tabId, { mode: 'chat', title: 'New Chat' });
}

/** Bridge ID: use the agent's asset ID if this tab was created by browser_tab */
const bridgeId = () => {
  const bt = getTab(props.tabId);

  return bt?.assetId || `browser-tab-${ props.tabId }`;
};

const iframeRef = ref<HTMLIFrameElement | null>(null);
const addressInput = ref<HTMLInputElement | null>(null);
const addressBarUrl = ref('');
const currentUrl = ref('about:blank');
const loading = ref(true);
const canGoBack = ref(false);
const canGoForward = ref(false);

// Navigation history (iframe doesn't expose history state)
const navHistory: string[] = [];
let navIndex = -1;

// Bridge integration
let hostBridge: WebviewHostBridge | null = null;
const bridgeUnsubs: (() => void)[] = [];

// Create an adapter that lets WebviewHostBridge work with our iframe via main-process IPC
function createIframeBridgeAdapter() {
  const domReadyListeners: ((event: unknown) => void)[] = [];
  const ipcMessageListeners: ((event: unknown) => void)[] = [];

  return {
    get src() {
      return currentUrl.value;
    },
    getURL() {
      return currentUrl.value;
    },
    async executeJavaScript(code: string, _userGesture?: boolean): Promise<unknown> {
      try {
        return await ipcRenderer.invoke('browser-tab:exec-in-frame', code);
      } catch (err) {
        console.warn('[BrowserTab] executeJavaScript via IPC failed:', err);
        return undefined;
      }
    },
    addEventListener(event: 'dom-ready' | 'ipc-message', listener: (event: unknown) => void) {
      if (event === 'dom-ready') {
        domReadyListeners.push(listener);
      } else if (event === 'ipc-message') {
        ipcMessageListeners.push(listener);
      }
    },
    removeEventListener(event: 'dom-ready' | 'ipc-message', listener: (event: unknown) => void) {
      if (event === 'dom-ready') {
        const idx = domReadyListeners.indexOf(listener);
        if (idx >= 0) domReadyListeners.splice(idx, 1);
      } else if (event === 'ipc-message') {
        const idx = ipcMessageListeners.indexOf(listener);
        if (idx >= 0) ipcMessageListeners.splice(idx, 1);
      }
    },
    // Called by our iframe load handler
    emitDomReady() {
      for (const fn of domReadyListeners) {
        try { fn({}) } catch { /* no-op */ }
      }
    },
    // Called by our postMessage handler
    emitIpcMessage(channel: string, args: unknown[]) {
      for (const fn of ipcMessageListeners) {
        try { fn({ channel, args }) } catch { /* no-op */ }
      }
    },
  };
}

let bridgeAdapter: ReturnType<typeof createIframeBridgeAdapter> | null = null;

function setupBridge() {
  bridgeAdapter = createIframeBridgeAdapter();
  hostBridge = new WebviewHostBridge({ injectDelayMs: 800 });
  hostBridge.attach(bridgeAdapter);
  setActiveHostBridge(hostBridge);

  // Register in the multi-asset registry using the agent's asset ID when available
  const id = bridgeId();

  hostBridgeRegistry.registerBridge(id, hostBridge, {
    title: getTab(props.tabId)?.title || 'Browser Tab',
    url:   currentUrl.value,
  });
  hostBridgeRegistry.setActiveBridge(id);

  // Log bridge events
  bridgeUnsubs.push(hostBridge.on('injected', (payload: HostBridgeEventMap['injected']) => {
    console.log('[BrowserTab] bridge:injected', payload);
    updateTab(props.tabId, { title: payload.title });
  }));
  bridgeUnsubs.push(hostBridge.on('routeChanged', (payload: HostBridgeEventMap['routeChanged']) => {
    console.log('[BrowserTab] bridge:routeChanged', payload);
    addressBarUrl.value = payload.url;
    updateTab(props.tabId, { title: payload.title, url: payload.url });
  }));
  bridgeUnsubs.push(hostBridge.on('domChange', (payload: HostBridgeEventMap['domChange']) => {
    console.log('[BrowserTab] bridge:domChange', payload.summary.slice(0, 200));
  }));
  bridgeUnsubs.push(hostBridge.on('click', (payload: HostBridgeEventMap['click']) => {
    console.log('[BrowserTab] bridge:click', payload);
  }));
}

// Listen for postMessage from the iframe (bridge events)
function onBridgeMessage(event: MessageEvent) {
  if (!event.data || typeof event.data !== 'object') return;
  const { type } = event.data;

  if (typeof type === 'string' && type.startsWith('sulla:')) {
    // Forward to the bridge adapter as an ipc-message
    bridgeAdapter?.emitIpcMessage(BRIDGE_CHANNEL, [event.data]);
  }
}

function normalizeUrl(input: string): string {
  const trimmed = input.trim();

  if (!trimmed) {
    return 'about:blank';
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  if (/^[a-zA-Z0-9-]+\.[a-zA-Z]{2,}/.test(trimmed)) {
    return `https://${ trimmed }`;
  }

  return `https://www.google.com/search?q=${ encodeURIComponent(trimmed) }`;
}

function navigate() {
  const url = normalizeUrl(addressBarUrl.value);

  // If we were in welcome mode, switch to browser
  if (tabMode.value === 'welcome') {
    onSetMode('browser');
  }

  // Push to history
  if (navIndex < navHistory.length - 1) {
    navHistory.splice(navIndex + 1);
  }
  navHistory.push(url);
  navIndex = navHistory.length - 1;

  currentUrl.value = url;
  addressBarUrl.value = url;
  loading.value = true;
  updateNavButtons();

  hostBridgeRegistry.updateMeta(bridgeId(), { url });
}

function goBack() {
  if (navIndex > 0) {
    navIndex--;
    const url = navHistory[navIndex];

    currentUrl.value = url;
    addressBarUrl.value = url;
    loading.value = true;
    updateNavButtons();
  }
}

function goForward() {
  if (navIndex < navHistory.length - 1) {
    navIndex++;
    const url = navHistory[navIndex];

    currentUrl.value = url;
    addressBarUrl.value = url;
    loading.value = true;
    updateNavButtons();
  }
}

function reload() {
  if (iframeRef.value) {
    loading.value = true;
    iframeRef.value.src = currentUrl.value;
  }
}

function stop() {
  if (iframeRef.value) {
    iframeRef.value.contentWindow?.stop();
    loading.value = false;
  }
}

function updateNavButtons() {
  canGoBack.value = navIndex > 0;
  canGoForward.value = navIndex < navHistory.length - 1;
}

function focusAddressBar() {
  addressInput.value?.focus();
  addressInput.value?.select();
}

function onFrameLoad() {
  loading.value = false;
  updateNavButtons();

  // Trigger bridge injection via the adapter
  bridgeAdapter?.emitDomReady();
}

// Handle keyboard shortcuts
function onKeydown(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key === 'l') {
    e.preventDefault();
    focusAddressBar();
  }
  if ((e.metaKey || e.ctrlKey) && e.key === 'r') {
    e.preventDefault();
    reload();
  }
}

// ── Visibility management ──
// This component is rendered with v-show (never removed from DOM).
// We watch the isVisible prop to manage event listeners and bridge state.

watch(() => props.isVisible, (visible) => {
  if (visible) {
    window.addEventListener('keydown', onKeydown);
    window.addEventListener('message', onBridgeMessage);
    if (tabMode.value === 'browser') {
      hostBridgeRegistry.setActiveBridge(bridgeId());
      setActiveHostBridge(hostBridge);
    }
  } else {
    window.removeEventListener('keydown', onKeydown);
    window.removeEventListener('message', onBridgeMessage);
  }
}, { immediate: true });

// ── Lifecycle ──
// onMounted: fires once when the tab is created. Sets URL and starts bridge.
// onUnmounted: fires when the tab is closed (removed from the tab list).

onMounted(() => {
  // Read initial URL from the shared tab state
  const tab = getTab(props.tabId);
  const url = tab?.url || '';

  if (url && url !== 'about:blank') {
    currentUrl.value = url;
    addressBarUrl.value = url;
    navHistory.push(url);
    navIndex = 0;
    // If URL was set, ensure mode is browser
    if (tab?.mode === 'welcome') {
      onSetMode('browser');
    }
  }

  setupBridge();
});

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown);
  window.removeEventListener('message', onBridgeMessage);

  while (bridgeUnsubs.length > 0) {
    const unsub = bridgeUnsubs.pop();
    try { unsub?.() } catch { /* no-op */ }
  }

  hostBridgeRegistry.unregisterBridge(bridgeId());
  hostBridge?.detach();
  hostBridge = null;
  bridgeAdapter = null;
  setActiveHostBridge(null);
});
</script>

<style scoped>
.browser-toolbar {
  background-color: #2a2e34;
  border-bottom: 1px solid #3a3f46;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.4);
  position: relative;
  z-index: 1;
}

.address-bar {
  width: 100%;
  padding: 0.375rem 0.75rem;
  font-size: 0.8125rem;
  background-color: var(--bg-surface);
  color: var(--text-primary);
  border: 1px solid var(--border-default);
  border-radius: 1.5rem;
  outline: none;
  transition: border-color 150ms, box-shadow 150ms;
}

.address-bar:focus {
  border-color: var(--accent-primary);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent-primary) 25%, transparent);
}

.address-bar::placeholder {
  color: var(--text-muted);
}

.browser-nav-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0.375rem;
  border-radius: 0.375rem;
  color: var(--text-secondary);
  background: transparent;
  border: none;
  cursor: pointer;
  transition: color 150ms, background-color 150ms;
}

.browser-nav-btn:hover:not(:disabled) {
  color: var(--text-primary);
  background-color: var(--bg-surface-hover);
}

.browser-nav-btn:disabled {
  opacity: 0.35;
  cursor: default;
}

.iframe-container {
  flex: 1 1 0;
  min-height: 0;
  overflow: hidden;
}

.browser-frame {
  width: 100%;
  height: 100%;
  border: none;
  display: block;
}
</style>
