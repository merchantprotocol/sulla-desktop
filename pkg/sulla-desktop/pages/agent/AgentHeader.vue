<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<template>
  <header
    class="app-titlebar relative flex flex-none items-end justify-between pl-4 lg:pl-22 pr-4 lg:pr-4 pt-3 lg:pt-1 pb-0 z-99"
    style="-webkit-app-region: drag; app-region: drag;"
  >
    <div class="relative flex shrink-0 items-center self-stretch">
      <WindowDragLogo :size="20" />
    </div>
    <!-- Phase 4: Scroll wrapper with chevrons -->
    <div
      class="tab-scroll-wrapper"
      :class="tabDensityClass"
    >
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
        @after-enter="updateActiveIndicator"
        @after-leave="updateActiveIndicator"
      >
        <span
          key="active-tab-indicator"
          class="tab-active-indicator"
          :style="activeIndicatorStyle"
          aria-hidden="true"
        />
        <router-link
          v-for="(tab, index) in orderedTabs"
          :key="tab.id"
          :to="tab.route"
          draggable="false"
          class="tab-item text-sm md:text-base"
          :data-active="tab.isActive ? 'true' : undefined"
          :class="[
            tab.mode ? `tab-mode-${tab.mode}` : '',
            {
              'tab-native': tab.native,
              'tab-active': tab.isActive && !tab.native,
              'tab-active-native': tab.isActive && tab.native,
              'tab-inactive': !tab.isActive,
              'tab-pinned': tab.pinned,
              'tab-pinned-boundary': !tab.pinned && index === pinnedTabCount && pinnedTabCount > 0,
              'tab-working': tab.working,
              'tab-pointer-dragging': dragState !== null && dragState.originIndex === index,
              'tab-preview': tab.preview,
            },
          ]"
          :title="tab.preview ? `${tab.label} — preview (double-click to keep open)` : undefined"
          @pointerdown="onPointerDown($event, index)"
          @dragstart.prevent
          @dblclick="tab.browserId && promoteTab(tab.browserId)"
          @auxclick.prevent="onAuxClick($event, tab)"
          @contextmenu.prevent="onTabContextMenu($event, tab, index)"
          @mouseenter="queueTabPeek($event, tab)"
          @mouseleave="hideTabPeek"
        >
          <span class="tab-accent-bar" />
          <svg
            v-if="tab.pinned"
            class="tab-pin"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            role="img"
            aria-label="Pinned"
          >
            <path d="M15 4.5l-4 4l-4 1.5l-1.5 1.5l7 7l1.5 -1.5l1.5 -4l4 -4" />
            <path d="M9 15l-4.5 4.5" />
            <path d="M14.5 4l5.5 5.5" />
          </svg>
          <span class="tab-icon">
            <img
              v-if="tab.favicon"
              :src="tab.favicon"
              draggable="false"
              class="tab-favicon-img"
              alt=""
            >
            <svg
              v-else-if="tab.iconPath"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              class="tab-favicon-svg"
            >
              <path :d="tab.iconPath" />
            </svg>
            <span
              v-if="tab.activity && tab.activity !== 'idle'"
              class="tab-activity-dot"
              :class="`tab-activity-${tab.activity}`"
              role="img"
              :aria-label="ACTIVITY_LABEL[tab.activity]"
              :title="ACTIVITY_LABEL[tab.activity]"
            />
          </span>
          <input
            v-if="renamingTabId === tab.id"
            ref="renameInput"
            v-model="renameDraft"
            class="tab-rename"
            type="text"
            maxlength="80"
            aria-label="Tab name"
            :placeholder="tab.pageTitle"
            @pointerdown.stop
            @click.stop.prevent
            @dblclick.stop
            @keydown.enter.prevent="commitRename"
            @keydown.esc.prevent="cancelRename"
            @blur="onRenameBlur"
          >
          <span
            v-else
            class="tab-label"
          >{{ tab.label }}</span>
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
          <span
            v-if="tab.working"
            class="tab-working-streak"
            aria-hidden="true"
          />
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
      <div
        v-if="tabPeek"
        class="tab-peek"
        :class="{ 'tab-tooltip': tabPeek.pinned }"
        :style="{ left: `${tabPeek.left}px` }"
      >
        <template v-if="tabPeek.pinned">
          {{ tabPeek.title }} · pinned
        </template>
        <template v-else>
          <span class="tab-peek-title">{{ tabPeek.title }}</span>
          <span class="tab-peek-status">{{ tabPeek.status }}</span>
        </template>
      </div>
    </div>
    <div class="titlebar-controls relative flex shrink-0 justify-end items-center gap-4">
      <div
        v-if="route.path === '/Filesystem'"
        class="flex gap-2"
      >
        <button
          class="titlebar-control cursor-pointer"
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
            class="h-4 w-4"
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
          class="titlebar-control cursor-pointer"
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
          class="titlebar-control cursor-pointer"
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
      <div
        v-if="canToggleMode !== false"
        class="relative z-10"
      >
        <label class="sr-only">Theme</label>
        <button
          class="titlebar-control cursor-pointer"
          type="button"
          :aria-label="isDark ? 'Switch to light mode' : 'Switch to dark mode'"
          @click="toggleTheme"
        >
          <svg v-if="isDark" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="h-4 w-4">
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42" />
          </svg>
          <svg v-else aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="h-4 w-4">
            <path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z" />
          </svg>
        </button>
      </div>
      <!-- Engine status: one dot for the whole app (replaces the chat's ONLINE pill). -->
      <span
        class="engine-status-control"
        role="status"
        :title="`Sulla engine: ${engineStatus.label}`"
        :aria-label="`Sulla engine: ${engineStatus.label}`"
      ><span class="engine-status" :class="engineStatus.tone" /></span>
      <!-- Three-dot menu (rendered in a popup BrowserWindow via IPC — see moreMenuWindow.ts) -->
      <div class="relative hidden lg:flex">
        <button
          type="button"
          class="titlebar-control cursor-pointer"
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
            class="h-5 w-5 stroke-[var(--text-muted)]"
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
      class="fixed inset-0 bg-[var(--bg-overlay)] backdrop-blur-sm transition-opacity duration-300 cursor-pointer"
      @click="toggleMobileMenu"
    />
    <div
      class="fixed top-10 left-0 right-0 bg-page shadow-lg transform transition-transform duration-300 ease-in-out rounded-b-lg"
      style="-webkit-app-region: no-drag; app-region: no-drag;"
    >
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
          to="/Integrations"
          class="block py-3 px-4 text-base font-semibold rounded-lg transition-colors"
          :class="route.path === '/Integrations' ? 'text-content bg-surface' : 'text-content-secondary hover:text-content hover:bg-surface'"
          @click="toggleMobileMenu"
        >
          Integrations
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
import { ref, computed, nextTick, onActivated, onDeactivated, onMounted, onUnmounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { isTabCloseable, measureActiveTabIndicator } from './tabStrip';

import { getExtensionService } from '@pkg/agent';
import WindowDragLogo from '@pkg/components/WindowDragLogo.vue';
import { orderPinnedFirst, useBrowserTabs, type BrowserTabMode } from '@pkg/composables/useBrowserTabs';
import { chatActivityByTab } from '@pkg/pages/chat/messages/chatActivityStore';
import type { ThreadActivityState } from '@pkg/pages/chat/messages/threadActivity';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

const ACTIVITY_LABEL: Record<ThreadActivityState, string> = {
  working: 'Sulla is working',
  waiting: 'Waiting on agents or a schedule',
  you:     'Needs you',
  stalled: 'No progress: an agent has gone quiet',
  idle:    'Idle',
};

// Every page and every browser tab mounts its own AgentHeader, so there is one
// tab strip per page. They share a single scroll offset so switching tabs
// never resets the strip back to the left.
let sharedTabScrollLeft = 0;
</script>

<script setup lang="ts">
// Module-level state: shared across all AgentHeader instances (one per keep-alive'd page)
const knownAssetIds = ref(new Set<string>());

// Module-level IPC listeners — registered once regardless of how many
// AgentHeader instances are mounted (each page has its own instance).
// Action callbacks are set by the active (most recent) instance.
let _ipcMountCount = 0;
let _onTabCtxAction:  ((...args: any[]) => void) | null = null;
let _onMoreAction:    ((...args: any[]) => void) | null = null;
let _onMoreFetchHist: ((...args: any[]) => void) | null = null;
const workingTabIds = ref(new Set<string>());
let _workingMountCount = 0;

function _onChatRunning(event: Event) {
  const { tabId, running } = (event as CustomEvent<{ tabId?: string; running?: boolean }>).detail ?? {};

  if (!tabId) return;
  const next = new Set(workingTabIds.value);

  if (running) next.add(tabId);
  else next.delete(tabId);
  workingTabIds.value = next;
}

function _tabCtxBridge(...args: any[]) { _onTabCtxAction?.(...args) }
function _moreBridge(...args: any[]) { _onMoreAction?.(...args) }
function _moreHistBridge(...args: any[]) { _onMoreFetchHist?.(...args) }

function _mountIpcListeners() {
  if (_ipcMountCount++ === 0) {
    ipcRenderer.on('tab-context-menu:selected' as any, _tabCtxBridge as any);
    ipcRenderer.on('more-menu:selected' as any, _moreBridge as any);
    ipcRenderer.on('more-menu:fetch-history' as any, _moreHistBridge as any);
  }
  if (_workingMountCount++ === 0) window.addEventListener('sulla:chat-running', _onChatRunning);
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
  if (--_workingMountCount <= 0) {
    _workingMountCount = 0;
    window.removeEventListener('sulla:chat-running', _onChatRunning);
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
const {
  tabs: browserTabs, closedTabs, tabOrder, previewTabId, pinnedTabIds,
  createTab, closeTab, updateTab, getTab, ensureOneTab, restoreClosedTab,
  reorderTabs, promoteTab, isTabPinned, setTabPinned, prunePinnedTabs,
} = useBrowserTabs();

defineProps<{
  isDark:         boolean;
  toggleTheme:    () => void;
  canToggleMode?: boolean;
}>();

const emit = defineEmits<{
  'toggle-left-pane':   [];
  'toggle-center-pane': [];
  'toggle-right-pane':  [];
}>();

const extensionMenuItems = computed(() => extensionService.getHeaderMenuItems());

const route = useRoute();
const isMobileMenuOpen = ref(false);
const tabPeek = ref<{ left: number; pinned: boolean; status: string; title: string; tabId: string } | null>(null);
let tabPeekTimer: ReturnType<typeof setTimeout> | null = null;

function hideTabPeek() {
  if (tabPeekTimer) clearTimeout(tabPeekTimer);
  tabPeekTimer = null;
  tabPeek.value = null;
}

function queueTabPeek(event: MouseEvent, tab: HeaderTab) {
  hideTabPeek();
  const target = event.currentTarget as HTMLElement;
  const wrapper = target.closest<HTMLElement>('.tab-scroll-wrapper');
  if (!wrapper) return;
  const targetRect = target.getBoundingClientRect();
  const wrapperRect = wrapper.getBoundingClientRect();
  const width = tab.pinned ? 180 : 240;
  const desiredLeft = targetRect.left - wrapperRect.left + (targetRect.width - width) / 2;
  const left = Math.max(0, Math.min(desiredLeft, wrapperRect.width - width));

  tabPeekTimer = setTimeout(() => {
    tabPeekTimer = null;
    if (!orderedTabs.value.some(candidate => candidate.id === tab.id)) return;
    tabPeek.value = {
      left,
      pinned: tab.pinned,
      status: tab.statusLine,
      title:  tab.label,
      tabId:  tab.id,
    };
    tabPeekTimer = null;
  }, tab.pinned ? 250 : 500);
}

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
    return;
  }

  // Cmd+U: provider usage and subscription windows
  if (meta && !e.shiftKey && e.key.toLowerCase() === 'u') {
    e.preventDefault();
    openModeTab('usage');
    return;
  }

  // Cmd+` (backtick): open a terminal tab (PTY into the Sulla VM)
  if (meta && e.key === '`') {
    e.preventDefault();
    openModeTab('terminal');
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
const activeIndicatorStyle = ref({
  opacity:   '0',
  transform: 'translateX(0px)',
  width:     '0px',
});
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

function updateActiveIndicator() {
  const el = getScrollEl();
  if (!el) return;
  const metrics = measureActiveTabIndicator(el);

  if (!metrics) {
    activeIndicatorStyle.value = { ...activeIndicatorStyle.value, opacity: '0' };
    return;
  }

  activeIndicatorStyle.value = {
    opacity:   '1',
    transform: `translateX(${ metrics.x }px)`,
    width:     `${ metrics.width }px`,
  };
}

/** Hidden strips (inactive browser tabs, kept-alive pages) must not drive the shared offset. */
function isStripVisible(el: HTMLElement): boolean {
  return el.clientWidth > 0 && getComputedStyle(el).visibility !== 'hidden';
}

function onTabStripScroll() {
  const el = getScrollEl();
  if (!el) return;
  if (isStripVisible(el)) sharedTabScrollLeft = el.scrollLeft;
  updateScrollButtons();
  updateActiveIndicator();
}

/**
 * Restore the shared scroll offset on the visible strip, then scroll the
 * minimum needed to fully show the active tab.
 */
function syncTabStrip() {
  const el = getScrollEl();
  if (!el || !isStripVisible(el)) return;

  let left = sharedTabScrollLeft;
  const active = el.querySelector<HTMLElement>('.tab-active, .tab-active-native');

  if (active) {
    const start = active.offsetLeft;
    const end = start + active.offsetWidth;

    if (start < left) {
      left = start;
    } else if (end > left + el.clientWidth) {
      left = end - el.clientWidth;
    }
  }
  el.scrollTo({ left, behavior: 'instant' });
  sharedTabScrollLeft = el.scrollLeft;
  updateScrollButtons();
  updateActiveIndicator();
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
    updateActiveIndicator();
  }
}

// ── Engine status dot ──
const engineState = ref('STOPPED');
const ENGINE_STATUS: Record<string, { label: string; tone: string }> = {
  STARTED:  { label: 'Running', tone: 'ok' },
  DISABLED: { label: 'Running', tone: 'ok' },
  STARTING: { label: 'Starting…', tone: 'busy' },
  STOPPING: { label: 'Shutting down…', tone: 'busy' },
  ERROR:    { label: 'Error', tone: 'error' },
  STOPPED:  { label: 'Stopped', tone: 'error' },
};
const engineStatus = computed(() => ENGINE_STATUS[engineState.value] ?? { label: engineState.value, tone: 'busy' });
function onEngineState(_event: unknown, state: unknown): void {
  engineState.value = String(state);
}

onMounted(() => {
  ipcRenderer.on('k8s-check-state' as any, onEngineState);
  try {
    const initial = ipcRenderer.sendSync('k8s-state' as any) as string | undefined;
    if (initial) engineState.value = initial;
  } catch { /* main not ready; the next state event fills it in */ }
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
    scrollObserver = new ResizeObserver(() => {
      updateScrollButtons();
      updateActiveIndicator();
    });
    scrollObserver.observe(el);
    el.addEventListener('scroll', onTabStripScroll, { passive: true });
    updateScrollButtons();
  }
  nextTick(syncTabStrip);
});
onActivated(() => nextTick(syncTabStrip));
// A kept-alive header that is hidden never gets mouseleave, so its preview would stay on screen.
onDeactivated(hideTabPeek);
onUnmounted(() => {
  ipcRenderer.removeListener('k8s-check-state' as any, onEngineState);
  hideTabPeek();
  window.removeEventListener('keydown', handleKeyboardShortcuts);
  window.removeEventListener('sulla:navigate-tab', handleNavigateTab);
  _unmountIpcListeners();

  if (scrollObserver) {
    scrollObserver.disconnect();
    scrollObserver = null;
  }
  const el = getScrollEl();
  if (el) el.removeEventListener('scroll', onTabStripScroll);
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
  case 'chatHistory':
    // Chat owns its inline history panel; from other tabs show History mode.
    if (orderedTabs.value.find(tab => tab.isActive)?.mode === 'chat') {
      window.dispatchEvent(new CustomEvent('sulla:toggle-chat-history'));
    } else {
      openModeTab('history');
    }
    break;
  case 'integrations':
    openModeTab('integrations');
    break;
  case 'secretary':
    openModeTab('secretary');
    break;
  case 'terminal':
    openModeTab('terminal');
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
  pinned:     boolean;
  working:    boolean;
  /** Chat tabs only: what the thread is doing, for the tab's activity dot. */
  activity?:  ThreadActivityState;
  statusLine: string;
  native?:    boolean;
  favicon?:   string;
  iconPath?:  string;
  mode?:      BrowserTabMode;
  closeable?: boolean;
  browserId?: string;
  /** Bookmark preview tab — replaced by the next bookmark until interacted with. */
  preview?:   boolean;
  /** The page's own title, shown as the placeholder while renaming. */
  pageTitle?: string;
}

/**
 * Inline SVG path data for each tab mode. Used as the favicon when a tab has
 * no real page-favicon (native tabs: chat, calendar, etc.) or as a fallback
 * for browser tabs that haven't loaded one yet. Stroke-based icons rendered
 * inline so they inherit `currentColor` and stay crisp at any DPI.
 */
const MODE_ICON_PATHS: Record<BrowserTabMode, string> = {
  welcome:      'M3 12L12 3l9 9M5 10v10a1 1 0 001 1h4v-6h4v6h4a1 1 0 001-1V10',
  browser:      'M12 3a9 9 0 100 18 9 9 0 000-18zM3 12h18M12 3a13.5 13.5 0 010 18M12 3a13.5 13.5 0 000 18',
  chat:         'M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z',
  calendar:     'M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 012 2v14a2 2 0 01-2 2H5a2 2 0 01-2-2V6a2 2 0 012-2z',
  integrations: 'M9 2v6M15 2v6M9 16v6M15 16v6M6 8h12a2 2 0 012 2v4a2 2 0 01-2 2H6a2 2 0 01-2-2v-4a2 2 0 012-2z',
  document:     'M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8zM14 2v6h6M16 13H8M16 17H8M10 9H8',
  secretary:    'M20 7H4a2 2 0 00-2 2v10a2 2 0 002 2h16a2 2 0 002-2V9a2 2 0 00-2-2zM16 21V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v16',
  vault:        'M5 11a2 2 0 012-2h10a2 2 0 012 2v9a2 2 0 01-2 2H7a2 2 0 01-2-2v-9zM8 11V7a4 4 0 118 0v4M12 15v2',
  account:      'M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2M12 11a4 4 0 100-8 4 4 0 000 8z',
  history:      'M12 3a9 9 0 109 9M3 3v6h6M12 7v5l3 2',
  routines:     'M6 3h4v4H6zM14 3h4v4h-4zM6 17h4v4H6zM14 17h4v4h-4zM10 5h4M10 19h4M12 7v10M6 11h12',
  marketplace:  'M3 9h18l-1 10a2 2 0 01-2 2H6a2 2 0 01-2-2L3 9zM3 9l2-5h14l2 5M9 13a3 3 0 006 0',
  terminal:     'M4 5h16a1 1 0 011 1v12a1 1 0 01-1 1H4a1 1 0 01-1-1V6a1 1 0 011-1zM7 9l3 3-3 3M13 15h4',
  usage:        'M4 19V9M10 19V5M16 19v-7M22 19V3M2 19h20',
};

/** Build the unordered set of all tabs from their sources */
const allTabsById = computed(() => {
  const map = new Map<string, HeaderTab>();

  // Extension tabs
  for (const item of extensionMenuItems.value) {
    const id = `ext-${ item.link }`;

    map.set(id, {
      id,
      label:      item.title,
      route:      item.link,
      isActive:   route.path === item.link,
      pinned:     isTabPinned(id),
      working:    false,
      statusLine: item.link,
    });
  }

  // Browser tabs — non-browser modes (calendar, integrations, marketplace) get pill style
  const pillModes = new Set(['chat', 'calendar', 'integrations', 'vault', 'account', 'routines', 'marketplace', 'usage']);

  for (const bt of browserTabs) {
    const id = `browser-${ bt.id }`;
    const isPill = pillModes.has(bt.mode);
    const pinned = isTabPinned(id);
    const working = bt.mode === 'chat' && workingTabIds.value.has(bt.id);
    const activity = bt.mode === 'chat' ? chatActivityByTab.get(bt.id) : undefined;
    const statusLine = bt.mode === 'chat'
      ? `chat · ${ working ? 'Sulla is working' : 'ready' }`
      : bt.url === 'about:blank' ? bt.mode : bt.url;

    map.set(id, {
      id,
      label:      bt.customTitle || bt.title || 'New Tab',
      pageTitle:  bt.title || 'New Tab',
      route:      `/Browser/${ bt.id }`,
      isActive:   route.path === `/Browser/${ bt.id }`,
      favicon:    bt.favicon,
      iconPath:   MODE_ICON_PATHS[bt.mode],
      mode:       bt.mode,
      closeable:  isTabCloseable(pinned),
      browserId:  bt.id,
      native:     isPill,
      preview:    previewTabId.value === bt.id,
      pinned,
      working,
      activity,
      statusLine: previewTabId.value === bt.id ? `preview · ${ statusLine }` : statusLine,
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

  const orderedIds = orderPinnedFirst(result.map(tab => tab.id), pinnedTabIds.value);

  return orderedIds.map(id => map.get(id)!).filter(Boolean);
});

const pinnedTabCount = computed(() => orderedTabs.value.filter(tab => tab.pinned).length);
const tabDensityClass = computed(() => orderedTabs.value.length >= 12 ? 'tabs-compact' : orderedTabs.value.length >= 8 ? 'tabs-tight' : 'tabs-normal');

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
    tabOrder.value = orderPinnedFirst(filtered, pinnedTabIds.value);
    prunePinnedTabs(currentIds);
  },
  { immediate: true },
);

// Update chevrons when tabs change
watch(() => orderedTabs.value.length, () => {
  nextTick(() => {
    updateScrollButtons();
    updateActiveIndicator();
  });
});

watch(
  () => orderedTabs.value.map(tab => `${ tab.id }:${ tab.isActive }:${ tab.pinned }`).join('|'),
  () => nextTick(updateActiveIndicator),
  { flush: 'post' },
);

// The newly active tab's strip becomes visible after the parent re-renders;
// carry the scroll offset over and keep the focused tab in view.
watch(() => route.path, () => nextTick(syncTabStrip), { flush: 'post' });
// Sulla closes idle agent tabs by itself; a preview for a tab that disappeared under the
// pointer never received mouseleave and floated over the page (2026-11-14). Also drop it
// when the page changes.
watch(() => orderedTabs.value.map(tab => tab.id), ids => {
  if (tabPeek.value && !ids.includes(tabPeek.value.tabId)) hideTabPeek();
});
watch(() => route.path, hideTabPeek);

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
// pkg/sulla-desktop/main/browserTabs/TabRegistry.ts. The UI will mirror
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
  // Do NOT call setPointerCapture — it conflicts with Electron's native
  // window-drag region on the header and can leave the tab bar frozen after
  // a drop. Window-level listeners cover everything we need.

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
    if (me.pointerId !== dragState.value?.pointerId) return;

    const dx = me.clientX - dragState.value.startX;

    // Deadzone: don't activate drag until threshold exceeded
    if (!dragState.value.active) {
      if (Math.abs(dx) < DRAG_DEADZONE) return;
      dragState.value.active = true;
      // Prevent the router-link navigation when dragging
      tabEl.style.pointerEvents = 'none';
    }

    const container = getScrollEl();
    if (!container) return;

    const children = Array.from(container.querySelectorAll<HTMLElement>('.tab-item'));

    // Find the dragged element's CURRENT index in the DOM after any previous
    // reorders — don't trust the stored currentIndex which can be stale when
    // multiple pointermove events fire before Vue flushes a re-render.
    const fromIndex = children.indexOf(dragState.value.tabEl);
    if (fromIndex === -1) return;

    // Use offsetLeft (layout position) rather than getBoundingClientRect so
    // hit-testing is stable during TransitionGroup FLIP animations, which
    // temporarily offset elements via CSS transform and would otherwise
    // cause rapid-fire phantom reorders after each swap.
    const containerLeft = container.getBoundingClientRect().left;
    const pointerX = me.clientX - containerLeft + container.scrollLeft;

    let targetIndex = children.length - 1;
    for (let i = 0; i < children.length; i++) {
      const center = children[i].offsetLeft + children[i].offsetWidth / 2;
      if (pointerX < center) {
        targetIndex = i;
        break;
      }
    }

    // Clamp to valid range
    targetIndex = Math.max(0, Math.min(targetIndex, children.length - 1));

    // Reorder in real-time if target changed
    if (targetIndex !== fromIndex) {
      reorderTabs(fromIndex, targetIndex);
      dragState.value.currentIndex = targetIndex;
    }
  };

  const onUp = (ue: PointerEvent) => {
    if (ue.pointerId !== state.pointerId) return;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);

    const wasDragging = dragState.value?.active ?? false;
    const draggedEl = dragState.value?.tabEl ?? tabEl;
    dragState.value = null;
    // Always clear both references — belt-and-suspenders so a stale
    // pointerEvents:none never leaves the bar frozen.
    draggedEl.style.pointerEvents = '';
    tabEl.style.pointerEvents = '';

    // If we were dragging, prevent the click/navigation that follows pointerup
    if (wasDragging) {
      const preventClick = (ce: Event) => {
        ce.preventDefault();
        ce.stopImmediatePropagation();
      };
      draggedEl.addEventListener('click', preventClick, { capture: true, once: true });
    }
  };

  // Window-level listeners receive events regardless of where the pointer moves.
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
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
  const items: string[] = [tab.pinned ? 'unpin' : 'pin'];

  if (tab.browserId) items.push('rename');
  items.push('---');

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
      pinned:    tab.pinned,
      index,
    },
  });
}

// ── Rename (right-click → Rename Tab) ──
// The tab label turns into a text field. Enter or clicking away saves, Esc
// cancels, and an empty name goes back to the page's own title.
const renamingTabId = ref<string | null>(null);
const renameDraft = ref('');
let renameOriginal = '';
const renameInput = ref<HTMLInputElement[] | HTMLInputElement | null>(null);

function startRename(tab: HeaderTab): void {
  renamingTabId.value = tab.id;
  renameDraft.value = tab.label;
  renameOriginal = tab.label;
  void nextTick(() => {
    const input = Array.isArray(renameInput.value) ? renameInput.value[0] : renameInput.value;
    // Every page keeps its own header; only the visible one edits, or a hidden
    // copy would take the keyboard focus.
    const box = input?.getBoundingClientRect();
    const onTop = box && box.width > 0 && document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2) === input;
    if (!input || !onTop) {
      renamingTabId.value = null;
      return;
    }
    input.focus();
    input.select();
  });
}

function commitRename(): void {
  const id = renamingTabId.value;
  if (!id) return;
  renamingTabId.value = null;
  const draft = renameDraft.value.trim();
  // An untouched name must not be saved: it would freeze the page's live title.
  if (draft === renameOriginal) return;
  const browserId = orderedTabs.value.find(t => t.id === id)?.browserId;
  if (browserId) updateTab(browserId, { customTitle: draft || undefined });
}

/** Clicking elsewhere in the app saves; the window itself losing focus (menu closing, app switch) does not. */
function onRenameBlur(): void {
  if (document.hasFocus()) commitRename();
}

function cancelRename(): void {
  renamingTabId.value = null;
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

  // Resolve the full HeaderTab from orderedTabs (it may have changed since the menu was opened)
  const headerTab = orderedTabs.value.find(t => t.id === tabId);
  const index = orderedTabs.value.findIndex(t => t.id === tabId);

  switch (action) {
  case 'pin':
    setTabPinned(tabId, true);
    break;

  case 'unpin':
    setTabPinned(tabId, false);
    break;

  case 'rename':
    if (headerTab?.browserId) startRename(headerTab);
    break;

  case 'close':
    if (headerTab?.closeable) closeAnyTab(headerTab);
    break;

  case 'closeOther':
    for (const bt of [...browserTabs]) {
      const id = `browser-${ bt.id }`;

      if (id !== tabId && !isTabPinned(id)) closeBrowserTab(bt.id);
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
    if (!headerTab || index < 0) break;
    reorderTabs(index, headerTab.pinned ? 0 : pinnedTabCount.value);
    break;
  }

  case 'moveEnd': {
    if (!headerTab || index < 0) break;
    const target = headerTab.pinned ? pinnedTabCount.value - 1 : orderedTabs.value.length - 1;

    reorderTabs(index, target);
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
          // eslint-disable-next-line @typescript-eslint/no-deprecated -- Electron fallback when Clipboard API is unavailable.
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
/* Unscoped styles for drag region - must apply to header element.
 * The whole header is draggable except interactive elements. Empty space
 * (between logo, tabs, and controls) moves the window. Tabs and buttons are
 * no-drag so clicks, pointer-based tab reorder and wheel scrolling reach JS.
 * Keep the scroll wrapper/container draggable: a no-drag container would
 * blanket the empty strip and make it unable to move the window. */
.app-titlebar {
  -webkit-app-region: drag;
  app-region: drag;
}

.app-titlebar a,
.app-titlebar button,
.app-titlebar .tab-item,
.app-titlebar .tab-item *,
.app-titlebar input,
.app-titlebar select,
.app-titlebar textarea {
  -webkit-app-region: no-drag;
  app-region: no-drag;
}
</style>

<style scoped>
.tab-activity-dot {
  position: absolute;
  top: -2px;
  right: -3px;
  width: 7px;
  height: 7px;
  margin: 0;
  flex: none;
  border-radius: 50%;
}
.tab-activity-working { background: var(--accent); animation: tab-activity-breathe 1.6s cubic-bezier(.22, 1, .36, 1) infinite; }
.tab-activity-waiting { background: color-mix(in srgb, var(--accent) 55%, var(--text-muted)); }
.tab-activity-you { background: var(--status-warning); }
.tab-activity-stalled { background: var(--status-error); }
@keyframes tab-activity-breathe {
  0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 50%, transparent); }
  70% { box-shadow: 0 0 0 5px transparent; }
  100% { box-shadow: 0 0 0 0 transparent; }
}
@media (prefers-reduced-motion: reduce) { .tab-activity-working { animation: none; } }
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

/*
  Tab geometry + baseline styling.

  Width: content-sized (flex-basis:auto) with a sensible cap so a page
  titled "Extremely Long Article About Quantum Cryptography..." can't
  hog the strip, and a small min so a blank "New Tab" still reads as a
  tab. Previously every tab was pinned to 240px which made titles feel
  forced and hid short labels behind padding.

  --tab-bg + --tab-bg-hover are per-mode overrides set below. They give
  each kind of tab the option to blend into the page beneath it instead
  of every active tab using the same surface-alt tone.
*/
.tab-item {
  --tab-bg: var(--bg-surface-alt);
  --tab-bg-hover: color-mix(in srgb, var(--bg-surface-alt) 55%, transparent);
  --tab-accent: var(--accent);

  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.875rem;
  font-family: var(--type-tabs-font, inherit);
  font-size: 0.8125rem;
  font-weight: 500;
  line-height: 1;
  border: 1px solid transparent;
  border-bottom: none;
  border-radius: 10px 10px 0 0;
  cursor: pointer;
  text-decoration: none;
  position: relative;
  z-index: 0;
  color: var(--text-secondary);
  background-color: transparent;
  transition: color 160ms, background-color 160ms, border-color 160ms, transform 160ms;
  user-select: none;

  flex: 0 1 auto;
  min-width: 120px;
  max-width: 220px;
}

.tab-label {
  /* Size lives on the label: the tab itself carries Tailwind text-size utilities that win over .tab-item. */
  font-size: var(--type-tabs-size, inherit);
  color: var(--type-tabs-color, inherit);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
  letter-spacing: 0.01em;
}

/* Bookmark preview tab (VS Code-style): italic until the user interacts */
.tab-preview .tab-label {
  font-style: italic;
  opacity: 0.85;
}

/* Icon well — consistent size across favicons (raster) and inline SVG fallbacks */
.tab-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  color: currentColor;
  opacity: 0.85;
}

.tab-favicon-img {
  width: 14px;
  height: 14px;
  border-radius: 3px;
  object-fit: contain;
}

.tab-favicon-svg {
  width: 14px;
  height: 14px;
}

.tab-item:hover .tab-icon,
.tab-active .tab-icon,
.tab-active-native .tab-icon {
  opacity: 1;
}

/* Accent bar — painted only on the active tab. Sits flush with the top
   edge and matches the tab's radius on the outer two corners so it
   reads as part of the tab, not a separate line. */
.tab-accent-bar {
  position: absolute;
  top: 0;
  left: 1px;
  right: 1px;
  height: 2px;
  background: var(--tab-accent);
  border-radius: 2px 2px 0 0;
  opacity: 0;
  pointer-events: none;
  transition: opacity 180ms;
}

.tab-active .tab-accent-bar,
.tab-active-native .tab-accent-bar {
  opacity: 1;
}

.tab-active-native .tab-accent-bar {
  left: 10%;
  right: 10%;
  border-radius: 0 0 2px 2px;
  top: 0;
}

/* Native / pill tabs: app-shortcut style, rounded all corners */
.tab-native {
  border-radius: 999px;
}

.tab-active-native {
  background-color: var(--tab-bg);
  color: var(--text-primary);
  border-color: var(--border-default);
  border-bottom: 1px solid var(--border-default);
  border-radius: 999px;
  font-weight: 600;
  z-index: 2;
}

/* Chrome-style browser tabs: rounded top, outward bottom scoops that
   merge seamlessly into the browser toolbar beneath (which paints
   --bg-surface-alt). */
.tab-active {
  background-color: var(--tab-bg);
  color: var(--text-primary);
  border-color: var(--border-default);
  border-radius: 10px 10px 0 0;
  font-weight: 600;
  z-index: 2;
}

.tab-active::before,
.tab-active::after {
  content: '';
  position: absolute;
  bottom: -1px;
  width: 10px;
  height: 10px;
  pointer-events: none;
}

.tab-active::before {
  left: -10px;
  background: radial-gradient(circle at 0 0, transparent 5.5px, var(--tab-bg) 10px);
}

.tab-active::after {
  right: -10px;
  background: radial-gradient(circle at 100% 0, transparent 5.5px, var(--tab-bg) 10px);
}

.tab-pointer-dragging {
  opacity: 0.7;
  z-index: 10;
  transform: translateY(-1px);
}

/* Inactive: quiet by default, subtle lift on hover */
.tab-inactive {
  color: var(--text-secondary);
}

.tab-inactive:hover {
  color: var(--text-primary);
  background-color: var(--tab-bg-hover);
  border-color: color-mix(in srgb, var(--border-default) 60%, transparent);
}

.tab-native.tab-inactive:hover {
  border-radius: 999px;
}

/* Chrome-style separator pipes between inactive tabs */
.tab-inactive::before {
  content: '';
  position: absolute;
  left: 0;
  top: 28%;
  height: 44%;
  width: 1px;
  background: var(--bg-surface-hover);
  pointer-events: none;
}

.tab-active + .tab-inactive::before,
.tab-active-native + .tab-inactive::before,
.tab-item:first-child.tab-inactive::before {
  display: none;
}

.tab-inactive:has(+ .tab-active)::before,
.tab-inactive:has(+ .tab-active-native)::before,
.tab-inactive:hover::before {
  display: none;
}

/*
  Per-mode tab blending. Each mode can set its own --tab-bg so the
  active tab tint matches the page below it. Modes that live on the
  routines/marketplace dark-steel gradient get a deeper, more saturated
  fill; the rest stay on surface-alt (which already matches the
  browser toolbar chrome).
*/
.tab-mode-routines,
.tab-mode-marketplace {
  --tab-bg: var(--bg-page);
  --tab-bg-hover: color-mix(in srgb, var(--accent) 12%, transparent);
  --tab-accent: var(--accent-hover);
}

.tab-mode-chat {
  --tab-bg: var(--bg-surface-alt);
  --tab-accent: var(--accent);
}

.tab-mode-vault {
  --tab-bg: var(--bg-surface-alt);
  --tab-accent: var(--status-warning);
}

.tab-mode-calendar {
  --tab-accent: var(--accent-hover);
}

.tab-mode-integrations {
  --tab-accent: var(--status-success);
}

.tab-mode-account {
  --tab-accent: var(--status-warning);
}

.tab-mode-secretary {
  --tab-accent: var(--accent);
}

.tab-mode-history {
  --tab-accent: var(--text-muted);
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

.tab-active-indicator,
.tab-working-streak,
.tab-peek {
  display: none;
}

/* Pinned tabs keep their title (shortened) and show a pin plus an accent
   underline, so they read as pinned instead of collapsing to a bare icon. */
.tab-pinned {
  min-width: 0;
  max-width: 150px;
  flex: 0 0 auto;
  gap: 6px;
  box-shadow: inset 0 -2px 0 var(--accent);
}

.tab-pin {
  width: 13px;
  height: 13px;
  flex: none;
  color: var(--accent);
}

.tab-pinned-boundary {
  margin-left: 10px;
}

.tab-pinned-boundary::before {
  content: '';
  position: absolute;
  left: -6px;
  top: 25%;
  width: 1px;
  height: 50%;
  background: var(--bg-surface-hover);
  pointer-events: none;
}

.tab-active-indicator + .tab-item.tab-inactive::before {
  display: none;
}

.tab-rename {
  flex: 1;
  min-width: 0;
  height: 22px;
  padding: 0 6px;
  border: 1px solid var(--accent);
  border-radius: 6px;
  outline: none;
  color: var(--text-primary);
  background: var(--bg-page, var(--bg-surface));
  font: inherit;
}

.app-titlebar .tab-scroll-chevron {
  width: 24px;
  color: var(--read-3, var(--text-secondary));
  border-radius: 12px;
}

.app-titlebar .tab-scroll-chevron:hover {
  color: var(--read-1, var(--text-primary));
  background: color-mix(in srgb, var(--accent) 10%, transparent);
}

.app-titlebar .tab-peek {
  position: absolute;
  display: block;
  top: 46px;
  width: 240px;
  padding: 12px;
  border: 1px solid var(--border-strong);
  border-radius: 14px;
  color: var(--read-1, var(--text-primary));
  background: var(--bg-elevated);
  box-shadow: 0 14px 40px var(--elev-float);
  pointer-events: none;
  z-index: 20;
  animation: tab-peek-in .4s var(--tab-spring) both;
}

.app-titlebar .tab-peek {
  background: color-mix(in srgb, var(--bg-surface) 97%, transparent);
  box-shadow: var(--elev-raised);
}

.app-titlebar .tab-peek-title,
.app-titlebar .tab-peek-status {
  display: block;
}

.app-titlebar .tab-peek-title {
  margin-bottom: 4px;
  font-size: 12.5px;
  font-weight: 600;
}

.app-titlebar .tab-peek-status {
  overflow: hidden;
  color: var(--read-4, var(--text-muted));
  font-family: var(--mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 10.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.app-titlebar .tab-tooltip {
  width: auto;
  max-width: 240px;
  padding: 6px 10px;
  border-radius: 8px;
  font-family: var(--mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 11px;
  letter-spacing: .08em;
  white-space: nowrap;
}

@keyframes tab-peek-in {
  from { opacity: 0; transform: translateY(-4px) scale(.97); }
  to { opacity: 1; transform: none; }
}

@media (prefers-reduced-motion: reduce) {
  .app-titlebar .tab-active-indicator,
  .app-titlebar .tab-item,
  .app-titlebar .tab-close,
  .app-titlebar .tab-new,
  .app-titlebar .tab-new svg,
  .app-titlebar .tab-peek {
    animation: none;
    transition-duration: 0s;
  }

  .app-titlebar .tab-working .tab-icon::after,
  .app-titlebar .tab-working-streak::after {
    animation: none;
  }
}
/* Approved full-width titlebar treatment. */
.app-titlebar {
  position: relative;
  z-index: 20;
  width: calc(100% + var(--rail-width, 64px));
  margin-left: calc(-1 * var(--rail-width, 64px));
  transition: width var(--dur-move) var(--spring), margin-left var(--dur-move) var(--spring);
  min-height: 44px;
  height: 44px;
  padding-top: 0;
  padding-bottom: 0;
  align-items: center;
  box-sizing: border-box;
  background: var(--bg-surface-alt);
  border-bottom: 1px solid var(--border-default);
}
.app-titlebar > div:first-child { height: 44px; }
.app-titlebar .window-drag-logo { padding: 0; margin-left: 0; }
.app-titlebar .tab-scroll-wrapper { margin-left: 14px; height: 44px; padding: 0; align-items: center; }
.app-titlebar .tab-scroll-container { gap: var(--tab-gap, 8px); height: 44px; align-items: flex-end; overflow-x: auto; overflow-y: hidden; }
.app-titlebar .tab-item {
  position: relative;
  height: 34px;
  min-width: 64px;
  max-width: none;
  flex: 0 1 var(--tab-basis, 190px);
  gap: var(--tab-gap, 8px);
  padding: 0 var(--tab-padding, 12px);
  border: 0;
  border-radius: 9px 9px 0 0;
  background: transparent;
  box-shadow: none;
  color: var(--text-muted, var(--text-secondary));
  overflow: visible;
}
.app-titlebar .tab-label { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.app-titlebar .tab-icon { position: relative; flex: 0 0 16px; width: 16px; height: 16px; }
.app-titlebar .tab-activity-dot { z-index: 2; box-shadow: none; }
.app-titlebar .tab-active .tab-activity-dot,
.app-titlebar .tab-active-native .tab-activity-dot { box-shadow: 0 0 0 2px var(--bg-chrome-active); }
.app-titlebar .tab-inactive .tab-activity-dot { box-shadow: none; }
.app-titlebar .tab-item:hover { color: var(--text-primary); background: var(--bg-surface-hover, color-mix(in srgb, var(--text-primary) 7%, transparent)); }
.app-titlebar .tab-active,
.app-titlebar .tab-active-native {
  z-index: 2;
  min-width: 120px;
  margin-bottom: -1px;
  border: 1px solid var(--border-default);
  border-bottom: 0;
  border-radius: 9px 9px 0 0;
  background: var(--bg-chrome-active);
  box-shadow: none;
  color: var(--text-primary);
  font-weight: 600;
  overflow: visible;
}
.app-titlebar .tab-active {
  border: 1px solid var(--border-default);
  border-bottom: 0;
  background: var(--bg-chrome-active);
  box-sizing: border-box;
}
.app-titlebar .tab-accent-bar {
  display: block;
  top: -1px;
  left: 8px;
  right: 8px;
  height: 2px;
  background: var(--accent);
  border-radius: 0 0 2px 2px;
  opacity: 0;
}
.app-titlebar .tab-active .tab-accent-bar,
.app-titlebar .tab-active-native .tab-accent-bar { opacity: 1; }
.app-titlebar .tab-active .tab-icon,
.app-titlebar .tab-active-native .tab-icon { color: var(--accent); opacity: 1; }
.app-titlebar .tab-active::before,
.app-titlebar .tab-active::after {
  content: '';
  position: absolute;
  bottom: 0;
  width: 10px;
  height: 10px;
  pointer-events: none;
  background: radial-gradient(circle at 0 0, transparent 9.5px, var(--border-default) 9.5px, var(--border-default) 10.5px, var(--bg-chrome-active) 10.5px);
  display: block;
}
.app-titlebar .tab-active::before { left: -10px; }
.app-titlebar .tab-active::after { right: -10px; transform: scaleX(-1); }
.app-titlebar .tab-inactive + .tab-inactive::before {
  display: block;
  top: 9px;
  bottom: 9px;
  height: auto;
  background: color-mix(in srgb, var(--border-default) 55%, transparent);
}
.app-titlebar .tab-active-indicator { display: none; }
.app-titlebar .tab-pinned { min-width: 64px; max-width: none; flex: 0 1 var(--tab-basis, 190px); border-radius: 9px 9px 0 0; box-shadow: none; padding: 0 var(--tab-padding, 12px); }
.app-titlebar .tab-pinned.tab-active { box-shadow: none; }
.app-titlebar .tab-scroll-chevron { width: 22px; height: 28px; flex: 0 0 22px; }
.app-titlebar .tab-new { width: 28px; height: 28px; flex: 0 0 28px; margin: 0; border-radius: 7px; }
.app-titlebar .tab-scroll-wrapper > button.tab-new { margin-left: 4px; }
.app-titlebar .tab-new,
.app-titlebar .titlebar-control { width: 28px; height: 28px; flex: 0 0 28px; margin: 0; padding: 0; border: 0; border-radius: 7px; display: grid; place-items: center; color: var(--text-muted); background: transparent; box-shadow: none; }
.app-titlebar .titlebar-control:hover,
.app-titlebar .tab-new:hover { background: var(--bg-surface-hover); }
.app-titlebar .titlebar-control svg,
.app-titlebar .tab-new svg { width: 16px; height: 16px; }
.app-titlebar .titlebar-controls { gap: 4px; height: 44px; padding: 0; }
.app-titlebar .titlebar-controls button { width: 28px !important; height: 28px !important; flex: 0 0 28px; margin: 0; padding: 0; border: 0; border-radius: 7px; background: transparent; box-shadow: none; }
.app-titlebar .engine-status-control { width: 28px; height: 28px; flex: 0 0 28px; display: grid; place-items: center; border-radius: 7px; }
.app-titlebar .engine-status { width: 9px; height: 9px; display: block; flex: none; border-radius: 50%; background: var(--status-warning); box-shadow: none; }
.app-titlebar .engine-status.ok { background: var(--status-success); }
.app-titlebar .engine-status.error { background: var(--status-error); }
.app-titlebar .tab-working .tab-icon::after { z-index: 0; }
.app-titlebar .tab-item:not(.tab-working) .tab-icon::after { content: none; }
.app-titlebar .titlebar-controls > .relative { display: flex; align-items: center; justify-content: center; }

.app-titlebar .tab-scroll-container { scrollbar-width: none; }
.app-titlebar .tab-scroll-container::-webkit-scrollbar { display: none; }
.app-titlebar .tab-scroll-wrapper.tabs-normal { --tab-basis: 190px; --tab-padding: 12px; --tab-gap: 8px; }
.app-titlebar .tab-scroll-wrapper.tabs-tight { --tab-basis: 150px; --tab-padding: 9px; --tab-gap: 6px; }
.app-titlebar .tab-scroll-wrapper.tabs-compact { --tab-basis: 96px; --tab-padding: 6px; --tab-gap: 5px; }
/* Preserve titlebar-only affordances while keeping geometry in the approved tab treatment. */
.app-titlebar .tab-pinned-boundary { margin-left: 18px; }
.app-titlebar .tab-pinned-boundary::before {
  content: '';
  display: block;
  position: absolute;
  left: -10px;
  top: 8px;
  width: 1px;
  height: 18px;
  background: var(--border-strong, var(--border-default));
  pointer-events: none;
}
.app-titlebar .tab-preview { box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--border-strong) 75%, transparent); }
.app-titlebar .tab-working .tab-icon::after {
  content: '';
  position: absolute;
  inset: -4px;
  border-radius: 50%;
  background: conic-gradient(from 0deg, transparent 0 55%, var(--accent-hover) 85%, transparent);
  mask: radial-gradient(farthest-side, transparent calc(100% - 1.6px), currentColor calc(100% - 1.5px));
  animation: tab-working-spin 1s linear infinite;
}
.app-titlebar .tab-working-streak {
  position: absolute;
  display: block;
  left: 14px;
  right: 14px;
  bottom: 3px;
  height: 2px;
  border-radius: 2px;
  overflow: hidden;
  pointer-events: none;
}
.app-titlebar .tab-working-streak::after {
  content: '';
  position: absolute;
  inset: 0;
  width: 40%;
  background: linear-gradient(90deg, transparent, var(--accent-hover), transparent);
  animation: tab-working-streak 1.4s cubic-bezier(.22, 1, .36, 1) infinite;
}
@keyframes tab-working-spin { to { transform: rotate(1turn); } }
@keyframes tab-working-streak { from { transform: translateX(-100%); } to { transform: translateX(260%); } }

</style>

<style>
/* Phase 8: Tab animations — unscoped because TransitionGroup generates elements */
.tab-anim-enter-from {
  opacity: 0;
  width: 0;
  min-width: 0;
  max-width: 0;
  padding-left: 0;
  padding-right: 0;
  overflow: hidden;
}

.tab-anim-enter-active {
  overflow: hidden;
  transition: opacity .3s, width .58s var(--tab-spring), min-width .58s var(--tab-spring), max-width .58s var(--tab-spring), padding .58s var(--tab-spring);
}

.tab-anim-enter-to {
  opacity: 1;
  width: 136px;
  max-width: 176px;
}

.tab-anim-leave-from {
  opacity: 1;
  width: 136px;
  max-width: 176px;
}

.tab-anim-leave-active {
  overflow: hidden;
  transition: opacity .3s, width .58s var(--tab-spring), min-width .58s var(--tab-spring), max-width .58s var(--tab-spring), padding .58s var(--tab-spring);
}

.tab-anim-leave-to {
  opacity: 0;
  width: 0;
  min-width: 0;
  max-width: 0;
  padding-left: 0;
  padding-right: 0;
  overflow: hidden;
}

.tab-anim-move {
  transition: transform .58s var(--tab-spring);
}

@media (prefers-reduced-motion: reduce) {
  .tab-anim-enter-active,
  .tab-anim-leave-active,
  .tab-anim-move {
    transition-duration: 0s;
  }
}


</style>
