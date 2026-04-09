<template>
  <div class="agent-router-root">
    <!-- Master password unlock — renders ABOVE everything including startup overlay and native views -->
    <VaultUnlockScreen
      v-if="!loggedIn && vaultSetUp"
    />

    <div class="agent-router-content flex flex-col">
      <!--
        Non-browser routes use keep-alive normally.
        Hidden when a browser tab is the active route.
      -->
      <router-view
        v-slot="{ Component }"
        v-show="!isBrowserRoute"
      >
        <keep-alive>
          <component
            :is="Component"
            :key="route.path"
          />
        </keep-alive>
      </router-view>

      <!--
        Browser tabs are rendered OUTSIDE of keep-alive so their iframes
        are never removed from the DOM.  We avoid v-show (display:none)
        because browsers tear down the iframe render tree when display
        is none, causing a visible "blink" on re-show.  Instead we use
        visibility:hidden + pointer-events:none so the iframe stays
        fully rendered and composited in the background.
      -->
      <BrowserTab
        v-for="tab in browserTabs"
        :key="tab.id"
        class="browser-tab-layer"
        :class="{ 'browser-tab-hidden': route.path !== `/Browser/${tab.id}` }"
        :tab-id="tab.id"
        :is-visible="route.path === `/Browser/${tab.id}`"
      />
    </div>

    <!-- Startup progress overlay -->
    <StartupOverlay />

    <!-- Status Bar Footer -->
    <footer class="agent-footer">
      <div class="agent-footer-left">
        <span
          v-if="appVersion"
          class="footer-item footer-version"
          :title="`Sulla Desktop v${appVersion}`"
        >
          v{{ appVersion }}
        </span>
        <span
          class="footer-item"
          :title="`${formatBytes(footerStats.availableBytes)} free on disk`"
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          ><rect
            x="2"
            y="2"
            width="20"
            height="20"
            rx="2"
          /><path d="M16 2v20" /><path d="M2 12h14" /></svg>
          {{ formatBytes(footerStats.availableBytes) }} free
        </span>
        <span
          class="footer-item"
          :title="`${formatBytes(footerStats.unprocessedTrainingBytes)} of unprocessed training data`"
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          ><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" /><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" /></svg>
          {{ formatBytes(footerStats.unprocessedTrainingBytes) }} queued
        </span>
      </div>
      <div class="agent-footer-right">
        <span
          v-if="backendProgressDesc"
          class="footer-item footer-progress-text"
        >
          {{ backendProgressDesc }}
        </span>
        <span
          v-if="backendProgressActive"
          class="footer-progress-bar-wrapper"
        >
          <span
            class="footer-progress-bar-fill"
            :class="{ indeterminate: backendProgressPct < 0 }"
            :style="backendProgressPct >= 0 ? { width: backendProgressPct + '%' } : {}"
          />
        </span>
        <span
          class="footer-item footer-state"
          :class="backendStateClass"
        >{{ backendStateLabel }}</span>
      </div>
    </footer>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch, onMounted, onUnmounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import BrowserTab from './BrowserTab.vue';
import StartupOverlay from './agent/StartupOverlay.vue';
import VaultUnlockScreen from './agent/VaultUnlockScreen.vue';
import { useBrowserTabs } from '@pkg/composables/useBrowserTabs';
import { useVaultUnlock } from '@pkg/composables/useVaultUnlock';
import { useStartupProgress } from './agent/useStartupProgress';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';
import { getHumanPresenceTracker } from '@pkg/agent/services/HumanPresenceTracker';

const route = useRoute();
const router = useRouter();
const { tabs: browserTabs, createTab, ensureOneTab, restoreClosedTab } = useBrowserTabs();
const { loggedIn, vaultSetUp, tryAutoLogin } = useVaultUnlock();
const { showOverlay: startupOverlayVisible } = useStartupProgress();

// Close the side panel when a full-screen overlay is active (vault lock or startup)
const sidePanelBlocked = computed(() => (!loggedIn.value && vaultSetUp.value) || startupOverlayVisible.value);
watch(sidePanelBlocked, (blocked) => {
  if (blocked) {
    ipcRenderer.invoke('chrome-api:sidePanel:close' as any, { all: true });
  }
});

const isBrowserRoute = computed(() => route.path.startsWith('/Browser/'));

// ── App version ──
const appVersion = ref('');

// ── Footer state ──
const footerStats = reactive({ availableBytes: 0, unprocessedTrainingBytes: 0 });
let footerStatsTimer: ReturnType<typeof setInterval> | undefined;

const backendState = ref('STOPPED');
const backendProgressDesc = ref('');
const backendProgressCurrent = ref(0);
const backendProgressMax = ref(0);

const STATE_LABELS: Record<string, string> = {
  STOPPED:  'Stopped',
  STARTING: 'Starting…',
  STARTED:  'Running',
  STOPPING: 'Shutting down…',
  ERROR:    'Error',
  DISABLED: 'Connected',
};

const backendStateLabel = computed(() => STATE_LABELS[backendState.value] || backendState.value);
const backendStateClass = computed(() => {
  const s = backendState.value;

  if (s === 'STARTED' || s === 'DISABLED') return 'state-ok';
  if (s === 'ERROR') return 'state-error';
  if (s === 'STARTING' || s === 'STOPPING') return 'state-busy';

  return 'state-stopped';
});

const backendProgressActive = computed(() => {
  if (backendProgressMax.value <= 0) {
    return !!backendProgressDesc.value;
  }

  return backendProgressCurrent.value < backendProgressMax.value;
});

const backendProgressPct = computed(() => {
  if (backendProgressMax.value <= 0) return -1;

  return Math.round((backendProgressCurrent.value / backendProgressMax.value) * 100);
});

function onK8sCheckState(_event: any, state: any) {
  backendState.value = String(state);
}

function onK8sProgress(_event: any, progress: any) {
  if (progress?.description) {
    backendProgressDesc.value = progress.description;
  }
  if (typeof progress?.current === 'number') {
    backendProgressCurrent.value = progress.current;
  }
  if (typeof progress?.max === 'number') {
    backendProgressMax.value = progress.max;
  }
  if (progress?.current >= progress?.max && progress?.max > 0) {
    backendProgressDesc.value = '';
    backendProgressCurrent.value = 0;
    backendProgressMax.value = 0;
  }
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const val = bytes / (1024 ** i);

  return `${ val < 10 ? val.toFixed(1) : Math.round(val) } ${ units[i] }`;
}

async function refreshFooterStats() {
  try {
    const stats = await ipcRenderer.invoke('editor-footer-stats');

    footerStats.availableBytes = stats.availableBytes;
    footerStats.unprocessedTrainingBytes = stats.unprocessedTrainingBytes;
  } catch { /* ignore */ }
}

function onRoute(_event: any, args: any) {
  if (args?.path) {
    router.push(args.path);
  }
}

function onAgentCommand(_event: any, args: any) {
  if (!args?.command) return;

  switch (args.command) {
  case 'new-chat-tab': {
    const tab = createTab('about:blank', { mode: 'chat' });

    router.push(`/Browser/${ tab.id }`);
    break;
  }
  case 'new-browser-tab': {
    const tab = createTab('https://www.google.com');

    router.push(`/Browser/${ tab.id }`);
    break;
  }
  case 'new-secretary-tab': {
    const tab = createTab('about:blank', { mode: 'secretary' });

    router.push(`/Browser/${ tab.id }`);
    break;
  }
  case 'open-tab': {
    const tab = createTab('about:blank', { mode: args.mode || 'welcome' });

    router.push(`/Browser/${ tab.id }`);
    break;
  }
  case 'open-url': {
    const url = args.url || 'about:blank';
    const tab = createTab(url);

    router.push(`/Browser/${ tab.id }`);
    break;
  }
  }
}

// ── Conversation history IPC handlers ──

function onHistoryShowAll() {
  const tab = createTab('about:blank', { mode: 'history' as any });

  router.push(`/Browser/${ tab.id }`);
}

function onHistoryRestoreLastClosed() {
  const restored = restoreClosedTab(0);

  if (restored) {
    router.push(`/Browser/${ restored.id }`);
  }
}

function onHistoryNavigate(_event: any, ...args: any[]) {
  const entry = args[0] as { id: string; type: string; url?: string; title?: string; tab_id?: string };
  if (!entry) return;
  if (entry.type === 'browser' && entry.url && entry.url !== 'about:blank') {
    const tab = createTab(entry.url);

    router.push(`/Browser/${ tab.id }`);
  } else {
    const tab = createTab('about:blank', { mode: 'chat' as any });

    router.push(`/Browser/${ tab.id }`);
  }
}

const presenceTracker = getHumanPresenceTracker();

onMounted(async() => {
  // Ensure at least one tab exists and navigate to it on fresh start
  const initialTab = ensureOneTab();
  if (!route.path.startsWith('/Browser/')) {
    router.replace(`/Browser/${ initialTab.id }`);
  }

  // Attempt vault auto-unlock via safeStorage before anything else
  await tryAutoLogin();

  // Start human presence tracker — top-level shell ensures presence is tracked
  // whenever the app is open, regardless of which tab/pane is active
  presenceTracker.setCurrentView('Sulla Desktop');
  presenceTracker.setActiveChannel('sulla-desktop');
  presenceTracker.start();

  ipcRenderer.on('get-app-version', (_event: any, version: string) => {
    appVersion.value = version;
  });
  ipcRenderer.send('get-app-version');

  refreshFooterStats();
  footerStatsTimer = setInterval(refreshFooterStats, 30_000);

  ipcRenderer.on('route' as any, onRoute);
  ipcRenderer.on('agent-command' as any, onAgentCommand);
  ipcRenderer.on('k8s-check-state' as any, onK8sCheckState);
  ipcRenderer.on('k8s-progress' as any, onK8sProgress);
  ipcRenderer.on('conversation-history:show-all' as any, onHistoryShowAll);
  ipcRenderer.on('conversation-history:restore-last-closed' as any, onHistoryRestoreLastClosed);
  ipcRenderer.on('conversation-history:navigate' as any, onHistoryNavigate);
  // vault:logged-in / vault:logged-out are handled globally in useVaultUnlock composable
  ipcRenderer.invoke('k8s-progress').then((p: any) => {
    if (p?.description) backendProgressDesc.value = p.description;
  }).catch(() => {});
});

onUnmounted(() => {
  presenceTracker.stop();
  if (footerStatsTimer) {
    clearInterval(footerStatsTimer);
  }
  ipcRenderer.removeListener('route' as any, onRoute);
  ipcRenderer.removeListener('agent-command' as any, onAgentCommand);
  ipcRenderer.removeListener('k8s-check-state' as any, onK8sCheckState);
  ipcRenderer.removeListener('k8s-progress' as any, onK8sProgress);
  ipcRenderer.removeListener('conversation-history:show-all' as any, onHistoryShowAll);
  ipcRenderer.removeListener('conversation-history:restore-last-closed' as any, onHistoryRestoreLastClosed);
  ipcRenderer.removeListener('conversation-history:navigate' as any, onHistoryNavigate);
});
</script>

<style scoped>
.agent-router-root {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100vh;
  overflow: hidden;
}

.agent-router-content {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

/*
 * Each BrowserTab fills the content area absolutely.  The active tab
 * sits on top with normal visibility; hidden tabs remain rendered
 * but are invisible and non-interactive — avoiding the display:none
 * blink that occurs when browsers tear down iframe render trees.
 */
.browser-tab-layer {
  position: absolute;
  inset: 0;
  z-index: 1;
}

.browser-tab-hidden {
  visibility: hidden;
  pointer-events: none;
  z-index: 0;
}

/* Status Bar Footer */
.agent-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 22px;
  min-height: 22px;
  max-height: 22px;
  padding: 0 10px;
  font-size: var(--fs-body-sm);
  background: var(--bg-surface-alt);
  border-top: 1px solid var(--border-default);
  color: var(--text-secondary);
  flex-shrink: 0;
  user-select: none;
}

.agent-footer-left,
.agent-footer-right {
  display: flex;
  align-items: center;
  gap: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.footer-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.footer-version {
  font-weight: var(--weight-semibold);
  opacity: 0.7;
}

.footer-item svg {
  opacity: 0.6;
  flex-shrink: 0;
}

.footer-progress-text {
  font-size: var(--fs-caption);
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-muted);
}

.footer-state {
  padding: 0 6px;
  border-radius: 3px;
  font-weight: var(--weight-semibold);
  font-size: var(--fs-caption);
}
.footer-state.state-ok {
  color: var(--text-success);
}
.footer-state.state-error {
  color: var(--text-error);
}
.footer-state.state-busy {
  color: var(--text-warning);
}
.footer-state.state-stopped {
  color: var(--text-muted);
}

.footer-progress-bar-wrapper {
  display: inline-flex;
  align-items: center;
  width: 80px;
  height: 6px;
  background: var(--bg-hover);
  border-radius: 3px;
  overflow: hidden;
  flex-shrink: 0;
}
.footer-progress-bar-fill {
  height: 100%;
  background: var(--accent-primary);
  border-radius: 3px;
  transition: width 0.3s ease;
}
.footer-progress-bar-fill.indeterminate {
  width: 40% !important;
  animation: footer-progress-slide 1.2s ease-in-out infinite;
}
@keyframes footer-progress-slide {
  0%   { margin-left: 0; }
  50%  { margin-left: 60%; }
  100% { margin-left: 0; }
}
</style>
