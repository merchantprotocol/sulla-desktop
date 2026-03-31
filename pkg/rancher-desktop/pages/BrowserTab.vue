<template>
  <div
    class="h-full overflow-hidden font-sans page-root flex flex-col"
    :class="{ dark: isDark }"
  >
    <AgentHeader
      :is-dark="isDark"
      :toggle-theme="toggleTheme"
    />

    <!-- Browser toolbar — always visible in welcome and browser modes -->
    <template v-if="tabMode === 'welcome' || tabMode === 'browser'">
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
    </template>

    <!-- Welcome / New Tab page -->
    <template v-if="tabMode === 'welcome'">
      <div class="flex-1 min-h-0 overflow-hidden">
        <NewTabWelcome
          @start-chat="onStartChat"
          @set-mode="onSetMode"
        />
      </div>
    </template>

    <!-- Browser mode: WebContentsView positioning container -->
    <template v-else-if="tabMode === 'browser'">
      <div ref="viewContainerRef" class="view-container" />
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
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue';

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
import { ipcRenderer } from '@pkg/utils/ipcRenderer';
import { useStartupProgress } from './agent/useStartupProgress';
import {
  WebviewHostBridge,
  setActiveHostBridge,
  hostBridgeRegistry,
} from '@pkg/agent/scripts/injected';

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
const { showOverlay } = useStartupProgress();

const tabMode = computed<BrowserTabMode>(() => getTab(props.tabId)?.mode || 'welcome');
const tabContent = computed(() => getTab(props.tabId)?.content || '');

function onSetMode(mode: BrowserTabMode) {
  updateTab(props.tabId, { mode, title: MODE_TITLES[mode] });
}

function onStartChat(_chatQuery: string) {
  // Switch this tab to chat mode
  updateTab(props.tabId, { mode: 'chat', title: 'New Chat' });
}

// Bridge registration — lets agent tools see this tab as open
let hostBridge: WebviewHostBridge | null = null;

/** Asset ID used by the bridge registry and agent tools */
const bridgeId = () => {
  const bt = getTab(props.tabId);
  return bt?.assetId || `browser-tab-${ props.tabId }`;
};

/**
 * Create a WebviewLike adapter that routes executeJavaScript through IPC
 * to the main process BrowserTabViewManager instead of an iframe.
 */
function createViewBridgeAdapter() {
  const domReadyListeners: ((event: unknown) => void)[] = [];

  return {
    get src() { return addressBarUrl.value; },
    getURL() { return addressBarUrl.value; },
    async executeJavaScript(code: string): Promise<unknown> {
      try {
        return await ipcRenderer.invoke('browser-tab-view:exec-js', props.tabId, code);
      } catch (err) {
        console.warn('[BrowserTab] executeJavaScript via IPC failed:', err);
        return undefined;
      }
    },
    addEventListener(event: string, listener: (event: unknown) => void) {
      if (event === 'dom-ready') domReadyListeners.push(listener);
    },
    removeEventListener(event: string, listener: (event: unknown) => void) {
      if (event === 'dom-ready') {
        const idx = domReadyListeners.indexOf(listener);
        if (idx >= 0) domReadyListeners.splice(idx, 1);
      }
    },
    emitDomReady() {
      for (const fn of domReadyListeners) {
        try { fn({}) } catch { /* no-op */ }
      }
    },
  };
}

let bridgeAdapter: ReturnType<typeof createViewBridgeAdapter> | null = null;

function setupBridge() {
  bridgeAdapter = createViewBridgeAdapter();
  hostBridge = new WebviewHostBridge({ injectDelayMs: 100 });
  hostBridge.attach(bridgeAdapter);
  setActiveHostBridge(hostBridge);

  const id = bridgeId();
  hostBridgeRegistry.registerBridge(id, hostBridge, {
    title: getTab(props.tabId)?.title || 'Browser Tab',
    url:   addressBarUrl.value,
  });
  hostBridgeRegistry.setActiveBridge(id);
}

const viewContainerRef = ref<HTMLDivElement | null>(null);
const addressInput = ref<HTMLInputElement | null>(null);
const addressBarUrl = ref('');
const loading = ref(false);
const canGoBack = ref(false);
const canGoForward = ref(false);
let viewCreated = false;

/** Returns true if the input looks like a URL the user wants to navigate to */
function looksLikeUrl(input: string): boolean {
  const trimmed = input.trim();
  if (/^https?:\/\//i.test(trimmed)) return true;
  if (/^localhost(:\d+)?/i.test(trimmed)) return true;
  if (/^127\.0\.0\.1(:\d+)?/i.test(trimmed)) return true;
  if (/^[a-zA-Z0-9-]+\.[a-zA-Z]{2,}(\/|$)/.test(trimmed)) return true;
  return false;
}

function normalizeUrl(input: string): string {
  const trimmed = input.trim();

  if (!trimmed) {
    return 'about:blank';
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  if (/^localhost(:\d+)?/i.test(trimmed) || /^127\.0\.0\.1(:\d+)?/i.test(trimmed)) {
    return `http://${ trimmed }`;
  }
  if (/^[a-zA-Z0-9-]+\.[a-zA-Z]{2,}/.test(trimmed)) {
    return `https://${ trimmed }`;
  }

  return `https://www.google.com/search?q=${ encodeURIComponent(trimmed) }`;
}

function sendBounds() {
  const el = viewContainerRef.value;
  if (!el) return;
  const rect = el.getBoundingClientRect();
  // setBounds() uses logical/CSS pixels, not physical pixels.
  // Subtract footer height (22px) so the view doesn't cover it.
  const FOOTER_HEIGHT = 22;
  const remainingHeight = window.innerHeight - rect.y - FOOTER_HEIGHT;
  ipcRenderer.invoke('browser-tab-view:set-bounds', props.tabId, {
    x:      Math.round(rect.x),
    y:      Math.round(rect.y),
    width:  Math.round(rect.width),
    height: Math.round(remainingHeight),
  });
}

/**
 * Create the WebContentsView if it doesn't exist yet.
 * Must be called after the viewContainerRef div is in the DOM (browser mode).
 */
function ensureView(url: string) {
  if (viewCreated) return;
  viewCreated = true;

  nextTick(() => {
    const el = viewContainerRef.value;
    const rect = el?.getBoundingClientRect();
    const FOOTER_HEIGHT = 22;
    const remainingHeight = rect ? window.innerHeight - rect.y - FOOTER_HEIGHT : 600;
    const bounds = rect
      ? {
        x:      Math.round(rect.x),
        y:      Math.round(rect.y),
        width:  Math.round(rect.width),
        height: Math.round(remainingHeight),
      }
      : { x: 0, y: 0, width: 800, height: 600 };

    ipcRenderer.invoke('browser-tab-view:create', props.tabId, url, bounds);

    // Register with bridge so agent tools can see this tab
    setupBridge();

    if (props.isVisible) {
      ipcRenderer.invoke('browser-tab-view:show', props.tabId);
    }

    // Set up ResizeObserver to track bounds changes
    if (el) {
      resizeObserver = new ResizeObserver(() => {
        if (props.isVisible) {
          sendBounds();
        }
      });
      resizeObserver.observe(el);
    }
  });
}

function navigate() {
  const input = addressBarUrl.value.trim();
  if (!input) return;

  // If input looks like a URL, navigate the browser
  if (looksLikeUrl(input)) {
    const url = normalizeUrl(input);

    if (tabMode.value === 'welcome') {
      onSetMode('browser');
    }

    addressBarUrl.value = url;
    loading.value = true;

    if (!viewCreated) {
      ensureView(url);
    } else {
      ipcRenderer.invoke('browser-tab-view:navigate', props.tabId, url);
    }
    return;
  }

  // Otherwise treat it as a chat message — switch to chat mode
  onStartChat(input);
  addressBarUrl.value = '';
}

function goBack() {
  ipcRenderer.invoke('browser-tab-view:go-back', props.tabId);
}

function goForward() {
  ipcRenderer.invoke('browser-tab-view:go-forward', props.tabId);
}

function reload() {
  loading.value = true;
  ipcRenderer.invoke('browser-tab-view:reload', props.tabId);
}

function stop() {
  ipcRenderer.invoke('browser-tab-view:stop', props.tabId);
  loading.value = false;
}

function focusAddressBar() {
  addressInput.value?.focus();
  addressInput.value?.select();
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

// IPC state-update listener
function onStateUpdate(_event: unknown, state: { tabId: string; url: string; title: string; canGoBack: boolean; canGoForward: boolean; isLoading: boolean }) {
  if (state.tabId !== props.tabId) return;
  addressBarUrl.value = state.url;
  canGoBack.value = state.canGoBack;
  canGoForward.value = state.canGoForward;
  loading.value = state.isLoading;
  if (state.title) {
    updateTab(props.tabId, { title: state.title, url: state.url });
    hostBridgeRegistry.updateMeta(bridgeId(), { title: state.title, url: state.url });
  }
}

// ResizeObserver for bounds tracking
let resizeObserver: ResizeObserver | null = null;

// ── Visibility management ──
// This component is rendered with v-show (never removed from DOM).
// We watch the isVisible prop to manage event listeners and view visibility.

// Should the native view be visible right now?
const shouldShowView = () => props.isVisible && !showOverlay.value && viewCreated && tabMode.value === 'browser';

watch([() => props.isVisible, showOverlay], ([visible]) => {
  if (visible) {
    window.addEventListener('keydown', onKeydown);
  } else {
    window.removeEventListener('keydown', onKeydown);
  }

  if (shouldShowView()) {
    ipcRenderer.invoke('browser-tab-view:show', props.tabId);
    nextTick(() => sendBounds());
    if (hostBridge) {
      hostBridgeRegistry.setActiveBridge(bridgeId());
      setActiveHostBridge(hostBridge);
    }
  } else if (viewCreated) {
    ipcRenderer.invoke('browser-tab-view:hide', props.tabId);
  }
}, { immediate: true });

// ── Lifecycle ──
// onMounted: fires once when the tab is created. Sets URL and creates the WebContentsView.
// onUnmounted: fires when the tab is closed (removed from the tab list).

onMounted(() => {
  // Listen for state updates from the main process
  ipcRenderer.on('browser-tab-view:state-update' as any, onStateUpdate);

  // Read initial URL from the shared tab state
  const tab = getTab(props.tabId);
  const url = tab?.url || '';

  if (url && url !== 'about:blank') {
    addressBarUrl.value = url;
    // If URL was set, ensure mode is browser and create the view
    if (tab?.mode === 'welcome') {
      onSetMode('browser');
    }
    ensureView(url);
  }
  // If no URL, stay in welcome mode — view will be created when user navigates
});

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown);

  ipcRenderer.removeListener('browser-tab-view:state-update' as any, onStateUpdate);

  if (resizeObserver) {
    resizeObserver.disconnect();
    resizeObserver = null;
  }

  // Unregister from bridge registry
  hostBridgeRegistry.unregisterBridge(bridgeId());
  hostBridge?.detach();
  hostBridge = null;
  bridgeAdapter = null;
  setActiveHostBridge(null);

  if (viewCreated) {
    ipcRenderer.invoke('browser-tab-view:destroy', props.tabId);
  }
});
</script>

<style scoped>
.browser-toolbar {
  background-color: var(--bg-surface-alt);
  border-bottom: 1px solid var(--border-default);
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

.view-container {
  /* This div is only a positioning reference for the native WebContentsView.
     It must not take up visible space — the WebContentsView renders on top
     of the window at OS level, not inside the DOM. We keep it in the layout
     flow at zero height so getBoundingClientRect() reports the correct
     x/y position (right below the toolbar). */
  flex: 0 0 0px;
  overflow: hidden;
}

/* Theme-aware scrollbar styling for overflow-auto containers */
.overflow-auto::-webkit-scrollbar {
  width: 10px;
  height: 10px;
}

.overflow-auto::-webkit-scrollbar-track {
  background: var(--bg-surface);
  border-radius: 4px;
}

.overflow-auto::-webkit-scrollbar-thumb {
  background: var(--border-default);
  border-radius: 4px;
  transition: background-color 150ms;
}

.overflow-auto::-webkit-scrollbar-thumb:hover {
  background: var(--text-muted);
}

.overflow-auto::-webkit-scrollbar-corner {
  background: var(--bg-surface);
}
</style>
