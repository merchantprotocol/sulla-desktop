<template>
  <header
    class="app-titlebar relative flex flex-none items-end justify-between bg-page pl-4 lg:pl-22 pr-4 lg:pr-4 pt-3 lg:pt-1 pb-0 transition duration-500 z-99"
    style="-webkit-app-region: drag; app-region: drag;"
  >
    <div class="relative flex shrink-0 items-center pb-1">
      <WindowDragLogo :size="20" />
    </div>
    <!-- Phase 4: Scroll wrapper with chevrons -->
    <div class="tab-scroll-wrapper">
      <button
        v-show="canScrollLeft"
        class="tab-scroll-chevron tab-scroll-chevron-left"
        type="button"
        aria-label="Scroll tabs left"
        @click="scrollTabsLeft"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          class="h-3 w-3"
        >
          <path d="M15 18l-6-6 6-6" />
        </svg>
      </button>
      <!-- Phase 8: TransitionGroup as scroll container -->
      <TransitionGroup
        ref="tabScrollContainer"
        tag="div"
        name="tab-anim"
        class="tab-scroll-container"
        @wheel.prevent="onTabWheel"
      >
        <router-link
          v-for="(tab, index) in orderedTabs"
          :key="tab.id"
          :to="tab.route"
          class="tab-item text-sm md:text-base"
          :class="{
            'tab-native': tab.native,
            'tab-active': tab.isActive && !tab.native,
            'tab-active-native': tab.isActive && tab.native,
            'tab-inactive': !tab.isActive,
            'tab-pointer-dragging': dragState !== null && dragState.originIndex === index,
          }"
          @pointerdown="onPointerDown($event, index)"
          @auxclick.prevent="onAuxClick($event, tab)"
          @contextmenu.prevent="onTabContextMenu($event, tab, index)"
        >
          <img
            v-if="tab.favicon"
            :src="tab.favicon"
            class="h-3 w-3 md:h-3.5 md:w-3.5 rounded-sm flex-shrink-0"
            alt=""
          >
          <span class="tab-label">{{ tab.label }}</span>
          <button
            v-if="tab.closeable"
            class="tab-close"
            type="button"
            aria-label="Close tab"
            @click.prevent.stop="closeAnyTab(tab)"
            @pointerdown.stop
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              class="h-2.5 w-2.5 md:h-3 md:w-3"
            >
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </router-link>
      </TransitionGroup>
      <button
        v-show="canScrollRight"
        class="tab-scroll-chevron tab-scroll-chevron-right"
        type="button"
        aria-label="Scroll tabs right"
        @click="scrollTabsRight"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          class="h-3 w-3"
        >
          <path d="M9 18l6-6-6-6" />
        </svg>
      </button>
      <button
        class="tab-new"
        type="button"
        aria-label="New tab"
        @click="openNewBrowserTab"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2.5"
          stroke-linecap="round"
          class="h-3 w-3 md:h-3.5 md:w-3.5"
        >
          <path d="M12 5v14M5 12h14" />
        </svg>
      </button>
    </div>
    <div class="relative flex shrink-0 justify-end items-center gap-4 pb-2">
      <div
        v-if="route.path === '/Filesystem'"
        class="flex gap-2"
      >
        <button
          class="flex h-5 w-5 items-center justify-center rounded-lg shadow-md ring-1 shadow-black/5 ring-black/5 cursor-pointer"
          type="button"
          aria-label="Toggle left pane"
          @click="$emit('toggle-left-pane')"
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            class="h-3.5 w-3.5 fill-sky-400"
          >
            <rect
              x="3"
              y="3"
              width="18"
              height="18"
              rx="2"
              ry="2"
            />
            <line
              x1="9"
              y1="9"
              x2="15"
              y2="9"
            />
            <line
              x1="9"
              y1="12"
              x2="15"
              y2="12"
            />
            <line
              x1="9"
              y1="15"
              x2="13"
              y2="15"
            />
          </svg>
        </button>
        <button
          class="flex h-5 w-5 items-center justify-center rounded-lg shadow-md ring-1 shadow-black/5 ring-black/5 cursor-pointer"
          type="button"
          aria-label="Toggle center pane"
          @click="$emit('toggle-center-pane')"
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            class="h-3.5 w-3.5"
          >
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
          </svg>
        </button>
        <button
          class="flex h-5 w-5 items-center justify-center rounded-lg shadow-md ring-1 shadow-black/5 ring-black/5 cursor-pointer"
          type="button"
          aria-label="Toggle right pane"
          @click="$emit('toggle-right-pane')"
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            class="h-3.5 w-3.5"
          >
            <rect
              x="3"
              y="3"
              width="18"
              height="18"
              rx="2"
              ry="2"
            />
            <circle
              cx="9"
              cy="9"
              r="2"
            />
            <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
          </svg>
        </button>
      </div>
      <div class="relative z-10">
        <label class="sr-only">Theme</label>
        <button
          class="flex h-5 w-5 items-center justify-center rounded-lg shadow-md ring-1 shadow-black/5 ring-black/5 cursor-pointer"
          type="button"
          :aria-label="isDark ? 'Switch to light mode' : 'Switch to dark mode'"
          @click="toggleTheme"
        >
          <svg
            v-if="isDark"
            aria-hidden="true"
            viewBox="0 0 16 16"
            class="h-3.5 w-3.5 fill-sky-400"
          >
            <path
              fill-rule="evenodd"
              clip-rule="evenodd"
              d="M7 1a1 1 0 0 1 2 0v1a1 1 0 1 1-2 0V1Zm4 7a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm2.657-5.657a1 1 0 0 0-1.414 0l-.707.707a1 1 0 0 0 1.414 1.414l.707-.707a1 1 0 0 0 0-1.414Zm-1.415 11.313-.707-.707a1 1 0 0 1 1.415-1.415l.707.708a1 1 0 0 1-1.415 1.414ZM16 7.999a1 1 0 0 0-1-1h-1a1 1 0 1 0 0 2h1a1 1 0 0 0 1-1ZM7 14a1 1 0 1 1 2 0v1a1 1 0 1 1-2 0v-1Zm-2.536-2.464a1 1 0 0 0-1.414 0l-.707.707a1 1 0 0 0 1.414 1.414l.707-.707a1 1 0 0 0 0-1.414Zm0-8.486A1 1 0 0 1 3.05 4.464l-.707-.707a1 1 0 1 1 1.414-1.414l.707.707ZM3 8a1 1 0 0 0-1-1H1a1 1 0 0 0 0 2h1a1 1 0 0 0 1-1Z"
            />
          </svg>
          <svg
            v-else
            aria-hidden="true"
            viewBox="0 0 16 16"
            class="h-3.5 w-3.5 fill-sky-400"
          >
            <path
              fill-rule="evenodd"
              clip-rule="evenodd"
              d="M7.23 3.333C7.757 2.905 7.68 2 7 2a6 6 0 1 0 0 12c.68 0 .758-.905.23-1.332A5.989 5.989 0 0 1 5 8c0-1.885.87-3.568 2.23-4.668ZM12 5a1 1 0 0 1 1 1 1 1 0 0 0 1 1 1 1 0 0 1 0 2 1 1 0 0 0-1 1 1 1 0 1 1-2 0 1 1 0 0 0-1-1 1 1 0 1 1 0-2 1 1 0 0 0 1-1Z"
            />
          </svg>
        </button>
      </div>
      <!-- Three-dot menu (rendered in a popup BrowserWindow via IPC — see moreMenuWindow.ts) -->
      <div class="relative hidden lg:flex">
        <button
          type="button"
          class="flex h-5 w-5 items-center justify-center rounded-lg shadow-md ring-1 shadow-black/5 ring-black/5 cursor-pointer"
          aria-label="More options"
          @click="openMoreMenu"
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            fill="currentColor"
            class="h-4 w-4 text-content"
          >
            <circle
              cx="12"
              cy="5"
              r="2.5"
            />
            <circle
              cx="12"
              cy="12"
              r="2.5"
            />
            <circle
              cx="12"
              cy="19"
              r="2.5"
            />
          </svg>
        </button>
      </div>
      <!-- Hamburger menu: right side, visible on mobile -->
      <div class="flex lg:hidden">
        <button
          type="button"
          class="relative cursor-pointer"
          aria-label="Open navigation"
          @click="toggleMobileMenu"
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            fill="none"
            stroke-width="2"
            stroke-linecap="round"
            class="h-5 w-5 stroke-slate-500"
          >
            <path d="M4 7h16M4 12h16M4 17h16" />
          </svg>
        </button>
      </div>
    </div>
  </header>

  <!-- Tab context menu is now rendered in a separate popup BrowserWindow via IPC.
       See tabContextMenuWindow.ts in the main process. -->

  <!-- Mobile Menu Dropdown (appears below header) -->
  <div
    v-if="isMobileMenuOpen"
    class="fixed inset-0 z-40 lg:hidden"
  >
    <div
      class="fixed inset-0 bg-black/50 backdrop-blur-sm transition-opacity duration-300 cursor-pointer"
      @click="toggleMobileMenu"
    />
    <div class="fixed top-10 left-0 right-0 bg-page shadow-lg transform transition-transform duration-300 ease-in-out rounded-b-lg">
      <nav class="px-4 pb-6 space-y-2">
        <router-link
          to="/Chat"
          class="block py-3 px-4 text-base font-semibold rounded-lg transition-colors"
          :class="route.path === '/Chat' ? 'text-content bg-surface' : 'text-content-secondary hover:text-content hover:bg-surface'"
          @click="toggleMobileMenu"
        >
          Chat
        </router-link>
        <router-link
          to="/Calendar"
          class="block py-3 px-4 text-base font-semibold rounded-lg transition-colors"
          :class="route.path === '/Calendar' ? 'text-content bg-surface' : 'text-content-secondary hover:text-content hover:bg-surface'"
          @click="toggleMobileMenu"
        >
          Calendar
        </router-link>
        <router-link
          to="/Integrations"
          class="block py-3 px-4 text-base font-semibold rounded-lg transition-colors"
          :class="route.path === '/Integrations' ? 'text-content bg-surface' : 'text-content-secondary hover:text-content hover:bg-surface'"
          @click="toggleMobileMenu"
        >
          Integrations
        </router-link>
        <router-link
          to="/Extensions"
          class="block py-3 px-4 text-base font-semibold rounded-lg transition-colors"
          :class="route.path === '/Extensions' ? 'text-content bg-surface' : 'text-content-secondary hover:text-content hover:bg-surface'"
          @click="toggleMobileMenu"
        >
          Extensions
        </router-link>
        <router-link
          v-for="item in extensionMenuItems"
          :key="item.link"
          :to="item.link"
          class="block py-3 px-4 text-base font-semibold rounded-lg transition-colors"
          :class="route.path === item.link ? 'text-content bg-surface' : 'text-content-secondary hover:text-content hover:bg-surface'"
          @click="toggleMobileMenu"
        >
          {{ item.title }}
        </router-link>
      </nav>
    </div>
  </div>
</template>

<script lang="ts">
import { ref, computed, nextTick, onMounted, onUnmounted, watch } from 'vue';

</script>

<script setup lang="ts">
import { useRoute, useRouter } from 'vue-router';

import { getExtensionService } from '@pkg/agent';
import { getAgentPersonaRegistry } from '@pkg/agent/database/registry/AgentPersonaRegistry';
import WindowDragLogo from '@pkg/components/WindowDragLogo.vue';
import { useBrowserTabs, type BrowserTabMode } from '@pkg/composables/useBrowserTabs';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

// Module-level state: shared across all AgentHeader instances (one per keep-alive'd page)
const knownAssetIds = ref(new Set<string>());

// Module-level IPC listeners — registered once regardless of how many
// AgentHeader instances are mounted (each page has its own instance).
// Action callbacks are set by the active (most recent) instance.
let _ipcMountCount = 0;
let _onTabCtxAction:  ((...args: any[]) => void) | null = null;
let _onMoreAction:    ((...args: any[]) => void) | null = null;
let _onMoreFetchHist: ((...args: any[]) => void) | null = null;

function _tabCtxBridge(...args: any[]) { _onTabCtxAction?.(...args) }
function _moreBridge(...args: any[]) { _onMoreAction?.(...args) }
function _moreHistBridge(...args: any[]) { _onMoreFetchHist?.(...args) }

function _mountIpcListeners() {
  if (_ipcMountCount++ === 0) {
    ipcRenderer.on('tab-context-menu:selected' as any, _tabCtxBridge as any);
    ipcRenderer.on('more-menu:selected' as any, _moreBridge as any);
    ipcRenderer.on('more-menu:fetch-history' as any, _moreHistBridge as any);
  }
}

function _unmountIpcListeners() {
  if (--_ipcMountCount <= 0) {
    _ipcMountCount = 0;
    ipcRenderer.removeListener('tab-context-menu:selected' as any, _tabCtxBridge as any);
    ipcRenderer.removeListener('more-menu:selected' as any, _moreBridge as any);
    ipcRenderer.removeListener('more-menu:fetch-history' as any, _moreHistBridge as any);
    _onTabCtxAction = null;
    _onMoreAction = null;
    _onMoreFetchHist = null;
  }
}

interface HistoryRecord {
  id:             string;
  type:           string;
  title:          string;
  url?:           string;
  tab_id?:        string;
  status:         string;
  created_at:     string;
  last_active_at: string;
}

const extensionService = getExtensionService();
const router = useRouter();
const { tabs: browserTabs, closedTabs, tabOrder, createTab, closeTab, updateTab, getTab, ensureOneTab, restoreClosedTab, reorderTabs } = useBrowserTabs();

// Active assets from the agent persona service
const personaRegistry = getAgentPersonaRegistry();
const persona = personaRegistry.getOrCreatePersonaService('sulla-desktop');

defineProps<{
  isDark:      boolean;
  toggleTheme: () => void;
}>();

const emit = defineEmits<{
  'toggle-left-pane':   [];
  'toggle-center-pane': [];
  'toggle-right-pane':  [];
}>();

const extensionMenuItems = computed(() => extensionService.getHeaderMenuItems());

const route = useRoute();
const isMobileMenuOpen = ref(false);

// On initial load, ensure at least one tab exists and handle route recovery
{
  const tab = ensureOneTab();

  if (route.path === '/Chat' || route.path === '/') {
    router.replace(`/Browser/${ tab.id }`);
  } else if (route.path.startsWith('/Browser/')) {
    // If reloading on a /Browser/:id route, verify the tab still exists.
    // Tabs are persisted to localStorage so this normally matches, but if
    // the tab was cleaned up or storage was cleared, fall back to a new tab.
    const routeTabId = route.path.replace('/Browser/', '');
    if (!getTab(routeTabId)) {
      router.replace(`/Browser/${ tab.id }`);
    }
  }
}

function openModeTab(mode: BrowserTabMode) {
  const tab = createTab('about:blank', { mode });

  router.push(`/Browser/${ tab.id }`);
}

// ── Phase 7: Keyboard shortcuts ──

function handleKeyboardShortcuts(e: KeyboardEvent): void {
  const meta = e.metaKey || e.ctrlKey;

  // Cmd+T: new tab
  if (meta && !e.shiftKey && e.key === 't') {
    e.preventDefault();
    openNewBrowserTab();
    return;
  }

  // Cmd+W: close current tab
  if (meta && !e.shiftKey && e.key === 'w') {
    e.preventDefault();
    const activeTab = orderedTabs.value.find(t => t.isActive);
    if (activeTab?.closeable) closeAnyTab(activeTab);
    return;
  }

  // Cmd+Shift+T: reopen last closed tab
  if (meta && e.shiftKey && (e.key === 'T' || e.key === 't')) {
    e.preventDefault();
    if (closedTabs.length > 0) onRestoreClosedTab(0);
    return;
  }

  // Cmd+1 through Cmd+9: switch to nth tab (Cmd+9 = last tab)
  if (meta && !e.shiftKey && e.key >= '1' && e.key <= '9') {
    e.preventDefault();
    const allTabs = orderedTabs.value;
    const idx = e.key === '9' ? allTabs.length - 1 : parseInt(e.key) - 1;
    const target = allTabs[idx];
    if (target) router.push(target.route);
    return;
  }

  // Cmd+Shift+S: secretary mode
  if (meta && e.shiftKey && e.key === 'S') {
    e.preventDefault();
    openModeTab('secretary');
  }
}

function handleNavigateTab(event: Event) {
  const tabId = (event as CustomEvent).detail?.tabId;
  if (tabId) {
    router.push(`/Browser/${ tabId }`);
  }
}

// ── Phase 4: Scroll controls ──

const tabScrollContainer = ref<InstanceType<typeof import('vue').TransitionGroup> | null>(null);
const canScrollLeft = ref(false);
const canScrollRight = ref(false);
let scrollObserver: ResizeObserver | null = null;

function getScrollEl(): HTMLElement | null {
  return (tabScrollContainer.value as any)?.$el ?? null;
}

function updateScrollButtons() {
  const el = getScrollEl();
  if (!el) return;
  canScrollLeft.value = el.scrollLeft > 1;
  canScrollRight.value = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
}

function scrollTabsLeft() {
  const el = getScrollEl();
  if (el) el.scrollBy({ left: -(el.clientWidth * 0.75), behavior: 'smooth' });
}

function scrollTabsRight() {
  const el = getScrollEl();
  if (el) el.scrollBy({ left: el.clientWidth * 0.75, behavior: 'smooth' });
}

function onTabWheel(e: WheelEvent) {
  const el = getScrollEl();
  if (el) {
    el.scrollLeft += e.deltaY !== 0 ? e.deltaY : e.deltaX;
    updateScrollButtons();
  }
}

onMounted(() => {
  window.addEventListener('keydown', handleKeyboardShortcuts);
  window.addEventListener('sulla:navigate-tab', handleNavigateTab);

  // Point the module-level IPC bridges at THIS instance's handlers.
  // The last-mounted instance wins — which is the currently visible page.
  _onTabCtxAction = handleTabContextMenuAction;
  _onMoreAction = handleMoreMenuAction;
  _onMoreFetchHist = handleMoreMenuFetchHistory;
  _mountIpcListeners();

  // Set up ResizeObserver for scroll chevron visibility
  const el = getScrollEl();
  if (el) {
    scrollObserver = new ResizeObserver(() => updateScrollButtons());
    scrollObserver.observe(el);
    el.addEventListener('scroll', updateScrollButtons, { passive: true });
    updateScrollButtons();
  }
});
onUnmounted(() => {
  window.removeEventListener('keydown', handleKeyboardShortcuts);
  window.removeEventListener('sulla:navigate-tab', handleNavigateTab);
  _unmountIpcListeners();

  if (scrollObserver) {
    scrollObserver.disconnect();
    scrollObserver = null;
  }
  const el = getScrollEl();
  if (el) el.removeEventListener('scroll', updateScrollButtons);
});

function onRestoreClosedTab(index: number) {
  const tab = restoreClosedTab(index);

  if (tab) {
    router.push(`/Browser/${ tab.id }`);
  }
}

// ── More menu (popup window via IPC) ──

function openMoreMenu(event: MouseEvent) {
  const button = event.currentTarget as HTMLElement;
  const rect = button.getBoundingClientRect();

  // Get current theme from document class
  const themeClass = Array.from(document.documentElement.classList)
    .find(c => c.startsWith('theme-')) ?? 'theme-protocol-dark';
  const themeId = themeClass.replace('theme-', '');

  ipcRenderer.send('more-menu:show' as any, {
    screenX:      rect.left + window.screenX,
    screenY:      rect.bottom + window.screenY,
    buttonWidth:  rect.width,
    buttonHeight: rect.height,
    theme:        themeId,
  });
}

/** Handle actions from the more-menu popup window. */
function handleMoreMenuAction(
  _event: Electron.IpcRendererEvent,
  action: string,
  extra: Record<string, unknown> | null,
): void {
  switch (action) {
  case 'newTab':
    openNewBrowserTab();
    break;
  case 'integrations':
    openModeTab('integrations');
    break;
  case 'extensions':
    openModeTab('extensions');
    break;
  case 'secretary':
    openModeTab('secretary');
    break;
  case 'history-entry': {
    if (!extra) break;
    const entry = extra as unknown as HistoryRecord;
    let tab;

    if (entry.type === 'browser' && entry.url && entry.url !== 'about:blank') {
      tab = createTab(entry.url);
    } else {
      tab = createTab('about:blank', { mode: 'chat' as BrowserTabMode });
    }
    router.push(`/Browser/${ tab.id }`);
    break;
  }
  case 'showAllHistory': {
    const tab = createTab('about:blank', { mode: 'history' as BrowserTabMode });

    router.push(`/Browser/${ tab.id }`);
    break;
  }
  }
}

/** The popup requested history entries — fetch and push them back via IPC. */
async function handleMoreMenuFetchHistory(): Promise<void> {
  try {
    const entries = await ipcRenderer.invoke('conversation-history:get-recent' as any, 25);

    ipcRenderer.send('more-menu:push-history' as any, entries ?? []);
  } catch {
    ipcRenderer.send('more-menu:push-history' as any, []);
  }
}

const toggleMobileMenu = () => {
  isMobileMenuOpen.value = !isMobileMenuOpen.value;
};

function openNewBrowserTab() {
  const tab = createTab('about:blank', { mode: 'chat' });

  router.push(`/Browser/${ tab.id }`);
}

// ── Data-driven tab list with drag-and-drop reordering ──

interface HeaderTab {
  id:         string;
  label:      string;
  route:      string;
  isActive:   boolean;
  native?:    boolean;
  favicon?:   string;
  closeable?: boolean;
  browserId?: string;
}

/** Build the unordered set of all tabs from their sources */
const allTabsById = computed(() => {
  const map = new Map<string, HeaderTab>();

  // Extension tabs
  for (const item of extensionMenuItems.value) {
    const id = `ext-${ item.link }`;

    map.set(id, {
      id, label: item.title, route: item.link, isActive: route.path === item.link,
    });
  }

  // Browser tabs — non-browser modes (calendar, integrations, extensions) get pill style
  const pillModes = new Set(['chat', 'calendar', 'integrations', 'extensions', 'vault', 'account']);

  for (const bt of browserTabs) {
    const id = `browser-${ bt.id }`;
    const isPill = pillModes.has(bt.mode);

    map.set(id, {
      id,
      label:     bt.title || 'New Tab',
      route:     `/Browser/${ bt.id }`,
      isActive:  route.path === `/Browser/${ bt.id }`,
      favicon:   bt.favicon,
      closeable: true,
      browserId: bt.id,
      native:    isPill,
    });
  }

  return map;
});

/** Tabs in user-chosen order, with new tabs appended at the end */
const orderedTabs = computed(() => {
  const map = allTabsById.value;
  const seen = new Set<string>();
  const result: HeaderTab[] = [];

  // First, add tabs in the saved order (skip any that no longer exist)
  for (const id of tabOrder.value) {
    const tab = map.get(id);

    if (tab) {
      result.push(tab);
      seen.add(id);
    }
  }

  // Then append any new tabs not yet in the order
  for (const [id, tab] of map) {
    if (!seen.has(id)) {
      result.push(tab);
    }
  }

  return result;
});

// Keep tabOrder in sync when tabs are added/removed
watch(
  () => [...allTabsById.value.keys()],
  (currentIds) => {
    const currentSet = new Set(currentIds);
    // Remove stale IDs
    const filtered = tabOrder.value.filter((id: string) => currentSet.has(id));
    // Append new IDs
    const ordered = new Set(filtered);

    for (const id of currentIds) {
      if (!ordered.has(id)) {
        filtered.push(id);
      }
    }
    tabOrder.value = filtered;
  },
  { immediate: true },
);

// Update chevrons when tabs change
watch(() => orderedTabs.value.length, () => {
  nextTick(updateScrollButtons);
});

// ── Adjacent tab on close (Chrome behavior) ──
// Defined after orderedTabs to avoid temporal dead zone in immediate watchers

function closeBrowserTab(id: string) {
  const isActive = route.path === `/Browser/${ id }`;

  // Snapshot visual position BEFORE closing so we can pick the adjacent tab
  let nextTabRoute: string | null = null;
  if (isActive) {
    const visual = orderedTabs.value;
    const visualIdx = visual.findIndex(t => t.browserId === id);
    // Prefer the tab to the right, then left — Chrome behavior
    const candidate = visual[visualIdx + 1] ?? visual[visualIdx - 1];
    nextTabRoute = candidate?.route ?? null;
  }

  closeTab(id);

  if (isActive) {
    if (nextTabRoute) {
      router.push(nextTabRoute);
    } else {
      // Fallback: closeTab auto-creates a welcome tab when list is empty
      const next = browserTabs[browserTabs.length - 1];
      router.push(`/Browser/${ next.id }`);
    }
  }
}

function closeAnyTab(tab: HeaderTab) {
  if (tab.browserId) {
    closeBrowserTab(tab.browserId);
  }
}

// Agent-opened tabs now come from the main-process TabRegistry directly;
// the activeAssets → tabs sync watcher was removed. See
// pkg/rancher-desktop/main/browserTabs/TabRegistry.ts. The UI will mirror
// main's state through a `tabs:change` IPC subscription.

// ── Phase 5: Pointer-event drag-and-drop ──

interface DragState {
  active:       boolean;
  originIndex:  number;
  currentIndex: number;
  startX:       number;
  pointerId:    number;
  tabEl:        HTMLElement;
}

const dragState = ref<DragState | null>(null);
const DRAG_DEADZONE = 5;

function onPointerDown(e: PointerEvent, index: number) {
  // Only primary button (left click)
  if (e.button !== 0) return;
  // Don't start drag from close button
  if ((e.target as HTMLElement).closest('.tab-close')) return;

  const tabEl = e.currentTarget as HTMLElement;
  tabEl.setPointerCapture(e.pointerId);

  const state: DragState = {
    active:       false,
    originIndex:  index,
    currentIndex: index,
    startX:       e.clientX,
    pointerId:    e.pointerId,
    tabEl,
  };

  dragState.value = state;

  const onMove = (me: PointerEvent) => {
    if (!dragState.value) return;

    const dx = me.clientX - dragState.value.startX;

    // Deadzone: don't activate drag until threshold exceeded
    if (!dragState.value.active) {
      if (Math.abs(dx) < DRAG_DEADZONE) return;
      dragState.value.active = true;
      // Prevent the router-link navigation when dragging
      tabEl.style.pointerEvents = 'none';
    }

    // Calculate which index the pointer is over based on sibling positions
    const container = getScrollEl();
    if (!container) return;

    const children = Array.from(container.children) as HTMLElement[];
    let targetIndex = dragState.value.currentIndex;

    for (let i = 0; i < children.length; i++) {
      const rect = children[i].getBoundingClientRect();
      const center = rect.left + rect.width / 2;

      if (me.clientX < center) {
        targetIndex = i;
        break;
      }
      targetIndex = i;
    }

    // Clamp to valid range
    targetIndex = Math.max(0, Math.min(targetIndex, children.length - 1));

    // Reorder in real-time if target changed
    if (targetIndex !== dragState.value.currentIndex) {
      reorderTabs(dragState.value.currentIndex, targetIndex);
      dragState.value.currentIndex = targetIndex;
    }
  };

  const onUp = () => {
    tabEl.removeEventListener('pointermove', onMove);
    tabEl.removeEventListener('pointerup', onUp);
    tabEl.removeEventListener('pointercancel', onUp);

    const wasDragging = dragState.value?.active ?? false;
    dragState.value = null;
    tabEl.style.pointerEvents = '';

    // If we were dragging, prevent the click/navigation that follows pointerup
    if (wasDragging) {
      const preventClick = (ce: Event) => {
        ce.preventDefault();
        ce.stopImmediatePropagation();
      };
      tabEl.addEventListener('click', preventClick, { capture: true, once: true });
    }
  };

  tabEl.addEventListener('pointermove', onMove);
  tabEl.addEventListener('pointerup', onUp);
  tabEl.addEventListener('pointercancel', onUp);
}

// ── Phase 6: Middle-click to close ──

function onAuxClick(e: MouseEvent, tab: HeaderTab) {
  if (e.button === 1 && tab.closeable) {
    closeAnyTab(tab);
  }
}

// ── Tab context menu (popup window via IPC) ──

function onTabContextMenu(event: MouseEvent, tab: HeaderTab, index: number) {
  // Build the list of menu items for this tab
  const items: string[] = [];

  if (tab.closeable) items.push('close');
  items.push('closeOther', 'closeRight');
  items.push('---');
  items.push('duplicate');
  items.push('---');
  items.push('moveStart', 'moveEnd');
  if (tab.browserId) {
    items.push('---');
    items.push('reload', 'copyUrl');
  }

  ipcRenderer.send('tab-context-menu:show' as any, {
    screenX:  event.screenX,
    screenY:  event.screenY,
    items,
    tabData:  {
      id:        tab.id,
      browserId: tab.browserId || null,
      route:     tab.route,
      closeable: tab.closeable || false,
      index,
    },
  });
}

/** Handle a context-menu action forwarded back from the popup window via IPC. */
function handleTabContextMenuAction(
  _event: Electron.IpcRendererEvent,
  action: string,
  tabData: Record<string, unknown>,
): void {
  const tabId = tabData.id as string;
  const browserId = tabData.browserId as string | null;
  const tabRoute = tabData.route as string;
  const closeable = tabData.closeable as boolean;
  const index = tabData.index as number;

  // Resolve the full HeaderTab from orderedTabs (it may have changed since the menu was opened)
  const headerTab = orderedTabs.value.find(t => t.id === tabId);

  switch (action) {
  case 'close':
    if (headerTab && closeable) closeAnyTab(headerTab);
    break;

  case 'closeOther':
    for (const bt of [...browserTabs]) {
      if (`browser-${ bt.id }` !== tabId) closeBrowserTab(bt.id);
    }
    break;

  case 'closeRight': {
    const tabs = orderedTabs.value;
    for (let i = tabs.length - 1; i > index; i--) {
      if (tabs[i].closeable) closeAnyTab(tabs[i]);
    }
    break;
  }

  case 'duplicate':
    if (browserId) {
      // Look up the source tab's current URL so the duplicate loads the same page
      const srcTab = browserTabs.find((t: { id: string }) => t.id === browserId);
      const dupUrl = srcTab?.url && srcTab.url !== 'about:blank' ? srcTab.url : undefined;
      const newTab = createTab(dupUrl);

      router.push(`/Browser/${ newTab.id }`);
    } else {
      router.push(tabRoute);
    }
    break;

  case 'moveStart': {
    // Use tabId to find position in tabOrder (index from orderedTabs may differ)
    const ids = [...tabOrder.value];
    const orderIdx = ids.indexOf(tabId);

    if (orderIdx <= 0) break;
    const [moved] = ids.splice(orderIdx, 1);

    ids.unshift(moved);
    tabOrder.value = ids;
    break;
  }

  case 'moveEnd': {
    const ids = [...tabOrder.value];
    const orderIdx = ids.indexOf(tabId);

    if (orderIdx < 0 || orderIdx >= ids.length - 1) break;
    const [moved] = ids.splice(orderIdx, 1);

    ids.push(moved);
    tabOrder.value = ids;
    break;
  }

  case 'reload':
    if (browserId) {
      router.push('/Chat').then(() => router.push(tabRoute));
    }
    break;

  case 'copyUrl':
    if (browserId) {
      const bt = browserTabs.find((t: { id: string }) => t.id === browserId);
      if (bt?.url) {
        navigator.clipboard?.writeText(bt.url).catch(() => {
          const ta = document.createElement('textarea');
          ta.value = bt.url;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
        });
      }
    }
    break;
  }
}
</script>

<style>
/* Unscoped styles for drag region - must apply to header element */
.app-titlebar {
  -webkit-app-region: drag;
  app-region: drag;
}

.app-titlebar a,
.app-titlebar button,
.app-titlebar .tab-item,
.app-titlebar input,
.app-titlebar .tab-scroll-wrapper {
  -webkit-app-region: no-drag;
  app-region: no-drag;
}
</style>

<style scoped>
/* Phase 4: Scroll wrapper */
.tab-scroll-wrapper {
  display: flex;
  align-items: stretch;
  flex: 1;
  min-width: 0;
  margin-left: 1rem;
  position: relative;
}

.tab-scroll-container {
  display: flex;
  align-items: flex-end;
  gap: 2px;
  flex: 0 1 auto;
  min-width: 0;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
  -ms-overflow-style: none;
  scroll-behavior: smooth;
  position: relative;
}

.tab-scroll-container::-webkit-scrollbar {
  display: none;
}

.tab-scroll-chevron {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  flex-shrink: 0;
  color: var(--text-secondary);
  background: transparent;
  border: none;
  cursor: pointer;
  transition: color 150ms, background-color 150ms;
  border-radius: 4px;
  z-index: 3;
}

.tab-scroll-chevron:hover {
  color: var(--text-primary);
  background-color: var(--bg-surface-hover);
}

/* Phase 3: Adaptive tab widths */
.tab-item {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.5rem 1rem;
  font-size: 0.75rem;
  font-weight: 600;
  border-radius: 8px;
  border: 1px solid transparent;
  border-bottom: none;
  cursor: pointer;
  transition: color 150ms, background-color 150ms, border-color 150ms;
  position: relative;
  text-decoration: none;
  z-index: 0;
  /* Subtle inactive background — slightly lighter than the title bar */
  background-color: color-mix(in srgb, var(--bg-surface) 25%, transparent);
  /* Adaptive widths */
  flex-shrink: 1;
  flex-grow: 0;
  flex-basis: 240px;
  min-width: 60px;
  max-width: 240px;
}

/* Phase 3: Tab label truncation */
.tab-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

/* Native tabs (Chat, Calendar, Integrations, Extensions): pill style */
.tab-active-native {
  background-color: var(--bg-surface-alt);
  color: var(--text-primary);
  z-index: 2;
  border-radius: 8px;
  border-color: var(--border-default);
}

/* Dynamic tabs (extensions, browser): Chrome-style with bottom scoops */
.tab-active {
  background-color: var(--bg-surface-alt);
  color: var(--text-primary);
  z-index: 2;
  border-radius: 8px 8px 0 0;
  border-color: var(--border-default);
}

.tab-active::before,
.tab-active::after {
  content: '';
  position: absolute;
  bottom: 0;
  width: 8px;
  height: 8px;
  pointer-events: none;
}

.tab-active::before {
  left: -8px;
  background: radial-gradient(circle at 0 0, transparent 4.5px, var(--bg-surface-alt) 8px);
}

.tab-active::after {
  right: -8px;
  background: radial-gradient(circle at 100% 0, transparent 4.5px, var(--bg-surface-alt) 8px);
}

/* Phase 5: Pointer drag styling */
.tab-pointer-dragging {
  opacity: 0.7;
  z-index: 10;
}

.tab-inactive {
  color: var(--text-secondary);
  border-color: color-mix(in srgb, var(--border-default) 50%, transparent);
}

/* Chrome-style separator pipe between inactive tabs */
.tab-inactive::before {
  content: '';
  position: absolute;
  left: 0;
  top: 25%;
  height: 50%;
  width: 1px;
  background: var(--border-default);
  pointer-events: none;
}

/* Hide separator next to active tab or on the first tab */
.tab-active + .tab-inactive::before,
.tab-active-native + .tab-inactive::before,
.tab-item:first-child.tab-inactive::before {
  display: none;
}

/* Hide separator on the tab right before an active one */
.tab-inactive:has(+ .tab-active)::before,
.tab-inactive:has(+ .tab-active-native)::before {
  display: none;
}

.tab-inactive:hover {
  color: var(--text-primary);
  background-color: var(--bg-surface-hover);
  border-color: var(--border-default);
}

/* Native tabs hover as pill */
.tab-native.tab-inactive:hover {
  border-radius: 8px;
}

/* Hide separator on hovered tab and its neighbor */
.tab-inactive:hover::before {
  display: none;
}

.tab-new {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-secondary);
  border-radius: .5rem;
  cursor: pointer;
  transition: color .15s, background-color .15s;
  background: transparent;
  border: none;
  flex-shrink: 0;
  padding: .6rem 1rem;
  margin-left: 2px;
}

.tab-new:hover {
  color: var(--text-primary);
  background-color: var(--bg-surface-hover);
}

.tab-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 1rem;
  height: 1rem;
  border-radius: 0.25rem;
  color: var(--text-muted);
  background: transparent;
  border: none;
  cursor: pointer;
  opacity: 0;
  transition: opacity 150ms, color 150ms, background-color 150ms;
  margin-left: auto;
  flex-shrink: 0;
}

.tab-item:hover .tab-close,
.tab-active .tab-close,
.tab-active-native .tab-close {
  opacity: 1;
}

.tab-close:hover {
  color: var(--text-primary);
  background-color: var(--bg-surface-hover);
}
</style>

<style>
/* Phase 8: Tab animations — unscoped because TransitionGroup generates elements */
.tab-anim-enter-from {
  opacity: 0;
  max-width: 0;
  padding-left: 0;
  padding-right: 0;
  overflow: hidden;
}

.tab-anim-enter-active {
  transition: opacity 200ms ease, max-width 200ms ease, padding 200ms ease;
}

.tab-anim-enter-to {
  opacity: 1;
  max-width: 240px;
}

.tab-anim-leave-from {
  opacity: 1;
  max-width: 240px;
}

.tab-anim-leave-active {
  transition: opacity 150ms ease, max-width 150ms ease, padding 150ms ease;
  position: absolute;
}

.tab-anim-leave-to {
  opacity: 0;
  max-width: 0;
  padding-left: 0;
  padding-right: 0;
  overflow: hidden;
}

.tab-anim-move {
  transition: transform 200ms ease;
}

</style>
