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
    <button
      v-if="needsYouRows.length"
      ref="needsYouButton"
      class="tab-needs-button"
      type="button"
      aria-haspopup="menu"
      :aria-expanded="Boolean(attentionMenuId)"
      @click="openAttentionMenu"
    >
      Needs you
      <span class="tab-needs-count">{{ needsYouRows.length }}</span>
    </button>
    <div
      ref="tabScrollWrapper"
      class="tab-scroll-wrapper"
      :class="{ 'fade-left': canScrollLeft, 'fade-right': canScrollRight }"
    >
      <div
        ref="tabScrollContainer"
        class="tab-scroll-container"
        @wheel.prevent="onTabWheel"
      >
        <template
          v-for="section in tabSections"
          :key="section.id"
        >
          <div
            v-if="section.pinned"
            class="tab-pinned-section"
          >
            <TransitionGroup
              tag="div"
              name="tab-anim"
              class="tab-group-tabs"
            >
              <TabStripTab
                v-for="(tab, localIndex) in section.tabs"
                :key="tab.id"
                :tab="tab"
                :index="section.startIndex + localIndex"
                :pinned-boundary="false"
                :dragging="dragState?.active && dragState.tabHeaderId === tab.id"
                :renaming="renamingTabId === tab.id"
                :rename-draft="renameDraft"
                :activity-labels="ACTIVITY_LABEL"
                @pointerdown="onPointerDown"
                @hover="scheduleTabHover"
                @hover-end="hideTabHover"
                @promote="promoteTab"
                @auxclick="onAuxClick"
                @contextmenu="onTabContextMenu"
                @close="closeAnyTab"
                @update:rename-draft="renameDraft = $event"
                @commit-rename="commitRename"
                @cancel-rename="cancelRename"
                @rename-blur="onRenameBlur"
              />
            </TransitionGroup>
          </div>
          <div
            v-else
            class="tab-group"
            :class="[`tab-group-${section.id}`, { 'tab-group-folded': isGroupFolded(section.id) }]"
          >
            <button
              class="tab-group-label"
              type="button"
              :aria-expanded="!isGroupFolded(section.id)"
              @click="toggleGroup(section.id)"
            >
              <svg
                class="tab-group-icon"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              ><path :d="section.iconPath" /></svg>
              <span>{{ section.label }}</span>
              <span class="tab-group-count">{{ section.tabs.length }}</span>
              <span
                v-if="isGroupFolded(section.id)"
                class="tab-group-dots"
                aria-hidden="true"
              >
                <i
                  v-for="tab in section.tabs.filter(tab => Boolean(groupDotState(tab)))"
                  :key="tab.id"
                  :class="`tab-group-dot-${groupDotState(tab)}`"
                />
              </span>
            </button>
            <TransitionGroup
              v-show="!isGroupFolded(section.id)"
              tag="div"
              name="tab-anim"
              class="tab-group-tabs"
            >
              <TabStripTab
                v-for="(tab, localIndex) in section.tabs"
                :key="tab.id"
                :tab="tab"
                :index="section.startIndex + localIndex"
                :pinned-boundary="section.startIndex + localIndex === pinnedTabCount && pinnedTabCount > 0"
                :dragging="dragState?.active && dragState.tabHeaderId === tab.id"
                :renaming="renamingTabId === tab.id"
                :rename-draft="renameDraft"
                :activity-labels="ACTIVITY_LABEL"
                @pointerdown="onPointerDown"
                @hover="scheduleTabHover"
                @hover-end="hideTabHover"
                @promote="promoteTab"
                @auxclick="onAuxClick"
                @contextmenu="onTabContextMenu"
                @close="closeAnyTab"
                @update:rename-draft="renameDraft = $event"
                @commit-rename="commitRename"
                @cancel-rename="cancelRename"
                @rename-blur="onRenameBlur"
              />
            </TransitionGroup>
          </div>
        </template>
      </div>
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

import TabStripTab from './TabStripTab.vue';
import { isTabCloseable } from './tabStrip';

import { getExtensionService } from '@pkg/agent';
import WindowDragLogo from '@pkg/components/WindowDragLogo.vue';
import { tabContextMenuBridge } from '@pkg/composables/TabContextMenuBridge';
import { TabDragAutoScroll } from '@pkg/composables/TabDragAutoScroll';
import { TabDragClickSuppression } from '@pkg/composables/TabDragClickSuppression';
import { TabGroupModel, type TabGroupId } from '@pkg/composables/TabGroupModel';
import { TabHoverController } from '@pkg/composables/TabHoverController';
import { TabStripLayoutRepository } from '@pkg/composables/TabStripLayoutRepository';
import { TabStripPopupAnchor } from '@pkg/composables/TabStripPopupAnchor';
import { TabTransferPayload, type TabEditorTransferSnapshot } from '@pkg/composables/TabTransferPayload';
import { useBrowserTabs, type BrowserTabMode } from '@pkg/composables/useBrowserTabs';
import { chatActivityStore } from '@pkg/pages/chat/messages/chatActivityStore';
import type { ThreadActivityState } from '@pkg/pages/chat/messages/threadActivity';
import type { TabAttentionRow } from '@pkg/shared/TabStripPopup';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

const ACTIVITY_LABEL: Record<ThreadActivityState, string> = {
  working: 'Sulla is working',
  waiting: 'Waiting on agents or a schedule',
  you:     'Needs you',
  stalled: 'No progress: an agent has gone quiet',
  quiet:   'Quiet',
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

// More-menu callbacks (separate from the window-owned tab context menu).
let _ipcMountCount = 0;
let _onMoreAction:    ((...args: any[]) => void) | null = null;
let _onMoreFetchHist: ((...args: any[]) => void) | null = null;
function _moreBridge(...args: any[]) { _onMoreAction?.(...args) }
function _moreHistBridge(...args: any[]) { _onMoreFetchHist?.(...args) }

function _mountIpcListeners() {
  if (_ipcMountCount++ === 0) {
    ipcRenderer.on('more-menu:selected' as any, _moreBridge as any);
    ipcRenderer.on('more-menu:fetch-history' as any, _moreHistBridge as any);
  }
}

function _unmountIpcListeners() {
  if (--_ipcMountCount <= 0) {
    _ipcMountCount = 0;
    ipcRenderer.removeListener('more-menu:selected' as any, _moreBridge as any);
    ipcRenderer.removeListener('more-menu:fetch-history' as any, _moreHistBridge as any);
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
const {
  tabs: browserTabs, closedTabs, tabOrder, previewTabId, pinnedTabIds,
  createTab, closeTab, updateTab, getTab, ensureOneTab, restoreClosedTab,
  reorderTabs, promoteTab, isTabPinned, setTabPinned, prunePinnedTabs,
  tabStripLayoutStorageKey,
} = useBrowserTabs();
const tabGroupModel = new TabGroupModel();
const tabLayoutRepository = new TabStripLayoutRepository(localStorage, tabStripLayoutStorageKey);
const foldedGroupIds = tabLayoutRepository.foldedGroups;
defineProps<{
  isDark:         boolean;
  toggleTheme:    () => void;
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

  if (tab && (route.path === '/Chat' || route.path === '/')) {
    router.replace(`/Browser/${ tab.id }`);
  } else if (tab && route.path.startsWith('/Browser/')) {
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

  setGroupFolded(tabGroupModel.groupForMode(mode), false);
  router.push(`/Browser/${ tab.id }`);
  return tab;
}

function openUsageTab(): void {
  const tab = openModeTab('marketplace');
  updateTab(tab.id, { title: 'Usage', studioSection: 'usage' });
}

// ── Phase 7: Keyboard shortcuts ──

function handleKeyboardShortcuts(e: KeyboardEvent): void {
  const strip = getScrollEl();

  if (e.defaultPrevented || !strip || !isStripVisible(strip)) return;
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
    const target = tabGroupModel.shortcutTab(orderedTabs.value, e.key);
    if (target) activateTab(target);
    return;
  }

  // Cmd+Shift+S: open Conversations and start Secretary Mode
  if (meta && e.shiftKey && e.key === 'S') {
    e.preventDefault();
    const tab = openModeTab('conversations');
    window.setTimeout(() => window.dispatchEvent(new CustomEvent('sulla:open-conversations-secretary', { detail: { tabId: tab.id } })), 80);
    return;
  }

  // Cmd+U: provider usage and subscription windows
  if (meta && !e.shiftKey && e.key.toLowerCase() === 'u') {
    e.preventDefault();
    openUsageTab();
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
    const tab = getTab(tabId);
    if (tab && !isTabPinned(`browser-${ tabId }`)) setGroupFolded(tabGroupModel.groupForMode(tab.mode), false);
    router.push(`/Browser/${ tabId }`);
  }
}

// ── Grouped tab strip scrolling ──

const tabScrollContainer = ref<HTMLElement | null>(null);
const tabScrollWrapper = ref<HTMLElement | null>(null);
const canScrollLeft = ref(false);
const canScrollRight = ref(false);
let scrollObserver: ResizeObserver | null = null;

function getScrollEl(): HTMLElement | null {
  return tabScrollContainer.value;
}

function updateScrollButtons() {
  const el = getScrollEl();
  if (!el) return;
  canScrollLeft.value = el.scrollLeft > 1;
  canScrollRight.value = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
}

/** Hidden strips (inactive browser tabs, kept-alive pages) must not drive the shared offset. */
function isStripVisible(el: HTMLElement): boolean {
  return el.clientWidth > 0 && getComputedStyle(el).visibility !== 'hidden';
}

function onTabStripScroll() {
  hideTabHover();
  const el = getScrollEl();
  if (!el) return;
  if (isStripVisible(el)) sharedTabScrollLeft = el.scrollLeft;
  updateScrollButtons();
}

/** Restore the shared offset, then reveal the active tab without resetting the strip. */
function syncTabStrip() {
  const el = getScrollEl();
  if (!el || !isStripVisible(el) || dragState.value?.active) return;

  let left = sharedTabScrollLeft;
  const active = el.querySelector<HTMLElement>('.tab-active, .tab-active-native');
  if (active) {
    const viewport = el.getBoundingClientRect();
    const tab = active.getBoundingClientRect();
    const start = tab.left - viewport.left + el.scrollLeft;
    const end = start + tab.width;
    if (start < left) left = start;
    else if (end > left + el.clientWidth) left = end - el.clientWidth;
  }
  el.scrollTo({ left, behavior: 'instant' });
  sharedTabScrollLeft = el.scrollLeft;
  updateScrollButtons();
}

function onTabWheel(event: WheelEvent) {
  const el = getScrollEl();
  if (!el) return;
  el.scrollLeft += Math.abs(event.deltaY) > Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
  updateScrollButtons();
}

const popupAnchor = new TabStripPopupAnchor(window);
const hover = new TabHoverController(
  window,
  request => ipcRenderer.send('tab-hover:show', request),
  id => ipcRenderer.send('tab-hover:hide', id),
);
const needsYouButton = ref<HTMLButtonElement | null>(null);
const attentionMenuId = ref<string>();
let contextMenuId: string | undefined;

function scheduleTabHover(event: PointerEvent, tab: HeaderTab): void {
  if (dragState.value?.active || contextMenuId || event.pointerType === 'touch') return;
  const anchor = event.currentTarget as HTMLElement;

  hover.schedule(() => {
    if (document.hidden) return undefined;
    const current = orderedTabs.value.find(candidate => candidate.id === tab.id);
    const position = popupAnchor.locate(anchor, getScrollEl() ?? undefined);

    if (!current || !position) return undefined;
    const state = groupDotState(current) ?? 'idle';
    const status = state === 'idle' && current.loading ? 'Loading' : ACTIVITY_LABEL[state];
    const detail = current.statusLine === status ? '' : current.statusLine;

    return {
      ...position,
      id:     crypto.randomUUID(),
      title:  current.label,
      status: current.preview ? `Preview · ${ status }` : status,
      detail,
    };
  });
}

function hideTabHover(): void {
  hover.cancel();
}

function openAttentionMenu(): void {
  if (attentionMenuId.value) {
    hideTabContextMenu();
    return;
  }
  hideTabHover();
  publishAttentionMenu(crypto.randomUUID(), false);
}

function publishAttentionMenu(id: string, update: boolean): void {
  const button = needsYouButton.value;
  const position = button && popupAnchor.locate(button);

  if (!position || !needsYouRows.value.length) {
    hideTabContextMenu();
    return;
  }
  if (!update) {
    claimContextMenu(id, action => {
      if (!action.startsWith('attention:')) return;
      const tabId = action.slice('attention:'.length);

      if (needsYouRows.value.some(row => row.id === tabId)) activateTabById(tabId);
    });
    attentionMenuId.value = id;
  }
  ipcRenderer.send('tab-context-menu:show', {
    requestId: id,
    items:     needsYouRows.value,
    attention: position,
    update,
  });
}

function claimContextMenu(id: string, select: (action: string) => void): void {
  tabContextMenuBridge.open({
    id,
    select,
    onClosed: () => {
      if (contextMenuId === id) contextMenuId = undefined;
      if (attentionMenuId.value === id) attentionMenuId.value = undefined;
    },
  });
  contextMenuId = id;
}

function hideTabContextMenu(): void {
  const id = contextMenuId;

  if (!id) return;
  tabContextMenuBridge.close(id);
  ipcRenderer.send('tab-context-menu:hide', id);
}

function hideStripPopups(): void {
  hideTabHover();
  hideTabContextMenu();
}

function onStripVisibilityChange(): void {
  if (document.hidden) hideStripPopups();
}

onMounted(() => {
  window.addEventListener('keydown', handleKeyboardShortcuts);
  window.addEventListener('blur', hideTabHover);
  document.addEventListener('visibilitychange', onStripVisibilityChange);
  window.addEventListener('sulla:navigate-tab', handleNavigateTab);

  // Point the module-level IPC bridges at THIS instance's handlers.
  // The last-mounted instance wins — which is the currently visible page.
  _onMoreAction = handleMoreMenuAction;
  _onMoreFetchHist = handleMoreMenuFetchHistory;
  _mountIpcListeners();

  // Keep fade edges current as tab widths or the window size change.
  const el = getScrollEl();
  if (el) {
    scrollObserver = new ResizeObserver(() => {
      updateScrollButtons();
    });
    scrollObserver.observe(el);
    if (tabScrollWrapper.value) scrollObserver.observe(tabScrollWrapper.value);
    el.addEventListener('scroll', onTabStripScroll, { passive: true });
    updateScrollButtons();
  }
  nextTick(syncTabStrip);
});
onActivated(() => nextTick(syncTabStrip));
onDeactivated(() => {
  hideStripPopups();
  cancelCurrentDrag();
  suppressDragClick.cancel();
});
onUnmounted(() => {
  cancelCurrentDrag();
  suppressDragClick.cancel();
  hideStripPopups();
  window.removeEventListener('blur', hideTabHover);
  document.removeEventListener('visibilitychange', onStripVisibilityChange);
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
    setGroupFolded(tabGroupModel.groupForMode(tab.mode), false);
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
    setGroupFolded(tabGroupModel.groupForMode(tab.mode), false);
    router.push(`/Browser/${ tab.id }`);
    break;
  }
  case 'showAllHistory': {
    const tab = createTab('about:blank', { mode: 'history' as BrowserTabMode });

    setGroupFolded('tools', false);
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

  setGroupFolded('chats', false);
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
  loading?:   boolean;
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
  welcome:           'M3 12L12 3l9 9M5 10v10a1 1 0 001 1h4v-6h4v6h4a1 1 0 001-1V10',
  browser:           'M12 3a9 9 0 100 18 9 9 0 000-18zM3 12h18M12 3a13.5 13.5 0 010 18M12 3a13.5 13.5 0 000 18',
  chat:              'M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z',
  calendar:          'M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 012 2v14a2 2 0 01-2 2H5a2 2 0 01-2-2V6a2 2 0 012-2z',
  integrations:      'M9 2v6M15 2v6M9 16v6M15 16v6M6 8h12a2 2 0 012 2v4a2 2 0 01-2 2H6a2 2 0 01-2-2v-4a2 2 0 012-2z',
  document:          'M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8zM14 2v6h6M16 13H8M16 17H8M10 9H8',
  secretary:         'M20 7H4a2 2 0 00-2 2v10a2 2 0 002 2h16a2 2 0 002-2V9a2 2 0 00-2-2zM16 21V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v16',
  conversations:     'M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z',
  vault:             'M5 11a2 2 0 012-2h10a2 2 0 012 2v9a2 2 0 01-2 2H7a2 2 0 01-2-2v-9zM8 11V7a4 4 0 118 0v4M12 15v2',
  account:           'M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2M12 11a4 4 0 100-8 4 4 0 000 8z',
  history:           'M12 3a9 9 0 109 9M3 3v6h6M12 7v5l3 2',
  routines:          'M6 3h4v4H6zM14 3h4v4h-4zM6 17h4v4H6zM14 17h4v4h-4zM10 5h4M10 19h4M12 7v10M6 11h12',
  marketplace:       'M3 9h18l-1 10a2 2 0 01-2 2H6a2 2 0 01-2-2L3 9zM3 9l2-5h14l2 5M9 13a3 3 0 006 0',
  labs:              'M3 4h18v16H3zM3 8h18M7 6h.01M10 6h.01M13 6h.01M8 12h8M8 16h5',
  terminal:          'M4 5h16a1 1 0 011 1v12a1 1 0 01-1 1H4a1 1 0 01-1-1V6a1 1 0 011-1zM7 9l3 3-3 3M13 15h4',
  files:             'M3 5h7l2 2h9v12H3zM3 9h18',
  'file-editor':     'M4 20h4l11-11-4-4L4 16v4zM13 7l4 4',
  paper:             'M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8zM14 2v6h6M8 13h8M8 17h8',
  decide:            'M5 12l4 4L19 6',
  preferences:       'M4 6h16M4 12h16M4 18h16M8 4v4M16 10v4M10 16v4',
  docker:            'M3 10h3v3H3zM7 10h3v3H7zM11 10h3v3h-3zM7 6h3v3H7zM11 6h3v3h-3zM15 10h3v3h-3zM2 15h18c-.6 3-2.5 5-6 5H8c-3 0-5-2-6-5z',
  'support-session': 'M4 13v-2a8 8 0 0116 0v2M4 13h3v6H5a2 2 0 01-2-2v-2a2 2 0 012-2zM20 13h-3v6h2a2 2 0 002-2v-2a2 2 0 00-2-2z',
  'capture-studio':  'M4 5h16v14H4zM8 9h8M8 12h8M8 15h5',
};

interface TabStripSection {
  id:         TabGroupId | 'pinned';
  label:      string;
  iconPath:   string;
  tabs:       HeaderTab[];
  pinned:     boolean;
  startIndex: number;
}

const needsYouRows = computed<TabAttentionRow[]>(() => orderedTabs.value.flatMap(tab => {
  const state = tab.activity;

  if (state !== 'you' && state !== 'stalled') return [];
  return [{ id: tab.id, title: tab.label, state, iconPath: tab.iconPath, reason: [ACTIVITY_LABEL[state], tab.statusLine].filter(Boolean).join(' · ') }];
}));

function isGroupFolded(id: TabGroupId): boolean {
  return foldedGroupIds.value.includes(id);
}

function setGroupFolded(id: TabGroupId, folded: boolean): void {
  const next = new Set(foldedGroupIds.value);
  if (folded) next.add(id);
  else next.delete(id);
  if (next.size === foldedGroupIds.value.length && foldedGroupIds.value.every(group => next.has(group))) return;
  tabLayoutRepository.setFoldedGroups([...next]);
}

function toggleGroup(id: TabGroupId): void {
  setGroupFolded(id, !isGroupFolded(id));
}

function groupDotState(tab: HeaderTab): ThreadActivityState | undefined {
  if (tab.activity && tab.activity !== 'idle') return tab.activity;
  if (tab.working) return 'working';
  return undefined;
}

function activateTab(tab: HeaderTab): void {
  if (!tab.pinned) setGroupFolded(tabGroupModel.groupForMode(tab.mode), false);
  router.push(tab.route).then(() => nextTick(() => scrollTabIntoView(tab.id)));
}

function activateTabById(tabId: string): void {
  const tab = orderedTabs.value.find(candidate => candidate.id === tabId);
  if (tab) activateTab(tab);
}

function scrollTabIntoView(tabId: string): void {
  const container = getScrollEl();
  const tab = Array.from(container?.querySelectorAll<HTMLElement>('.tab-item') ?? []).find(element => element.dataset.tabId === tabId);
  tab?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'auto' });
}

const tabSections = computed<TabStripSection[]>(() => {
  const grouped = tabGroupModel.groupTabs(orderedTabs.value);
  const sections: TabStripSection[] = [];
  let startIndex = 0;

  if (grouped.pinned.length) {
    sections.push({ id: 'pinned', label: '', iconPath: '', tabs: grouped.pinned, pinned: true, startIndex });
    startIndex += grouped.pinned.length;
  }
  for (const group of grouped.groups) {
    if (!group.tabs.length) continue;
    const presentation = group.id === 'chats'
      ? { label: 'Chats', iconPath: MODE_ICON_PATHS.chat }
      : group.id === 'browser'
        ? { label: 'Browser', iconPath: MODE_ICON_PATHS.browser }
        : { label: 'Tools', iconPath: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z' };
    sections.push({ id: group.id, ...presentation, tabs: group.tabs, pinned: false, startIndex });
    startIndex += group.tabs.length;
  }

  return sections;
});

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
    const { working, snapshot } = bt.mode === 'chat' ? chatActivityStore.read(bt.id) : { working: false, snapshot: undefined };
    const activity = snapshot?.state ?? (working ? 'working' : undefined);
    const statusLine = bt.mode === 'chat' ? snapshot?.detail ?? '' : bt.url === 'about:blank' ? bt.mode : bt.url;

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
      loading: bt.loading,
      activity,
      statusLine,
    });
  }

  return map;
});

/** Saved order is reconciled and sorted into visual order by the group model. */
const orderedTabs = computed(() => tabGroupModel.orderTabs([...allTabsById.value.values()], tabOrder.value));

watch(() => attentionMenuId.value ? JSON.stringify(needsYouRows.value) : null, (rows, previous) => {
  if (attentionMenuId.value && previous !== null && rows !== null) publishAttentionMenu(attentionMenuId.value, true);
}, { flush: 'post' });
watch(() => route.path, hideStripPopups, { flush: 'sync' });
watch(() => orderedTabs.value.find(tab => tab.isActive)?.mode, hideStripPopups, { flush: 'sync' });
watch(foldedGroupIds, hideTabHover);
watch(() => orderedTabs.value.map(tab => `${ tab.id }:${ tab.mode }`).join('\0'), hideTabHover);

const visibleTabs = computed(() => orderedTabs.value.filter(tab => tab.pinned || !isGroupFolded(tabGroupModel.groupForMode(tab.mode))));

const pinnedTabCount = computed(() => orderedTabs.value.filter(tab => tab.pinned).length);

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
    tabOrder.value = tabGroupModel.orderTabs([...allTabsById.value.values()], filtered).map(tab => tab.id);
    prunePinnedTabs(currentIds);
  },
  { immediate: true },
);

// Update scroll fades and active visibility when order or status changes.
watch(
  () => orderedTabs.value.map(tab => `${ tab.id }:${ tab.isActive }:${ tab.pinned }:${ tab.working }:${ tab.activity || '' }`).join('|'),
  () => {
    nextTick(() => {
      updateScrollButtons();
      const dragging = dragState.value;
      const container = getScrollEl();

      if (dragging?.active && !dragging.detached && dragging.tabEl.isConnected && container) {
        positionDraggedTab(dragging, container);
      } else {
        syncTabStrip();
      }
    });
  },
  { flush: 'post' },
);

// The newly active tab's strip becomes visible after the parent re-renders;
// carry the scroll offset over and keep the focused tab in view.
watch(() => route.path, () => nextTick(syncTabStrip), { flush: 'post' });
// ── Adjacent tab on close (Chrome behavior) ──
// Defined after orderedTabs to avoid temporal dead zone in immediate watchers

async function closeBrowserTab(id: string) {
  const isActive = route.path === `/Browser/${ id }`;

  // Snapshot visual position BEFORE closing so we can pick the adjacent tab
  let nextTabRoute: string | null = null;
  let nextTab: HeaderTab | null = null;
  if (isActive) {
    const visual = orderedTabs.value;
    const visibleIds = new Set(visibleTabs.value.map(tab => tab.id));
    const visualIdx = visual.findIndex(tab => tab.browserId === id);
    const candidate = visual.slice(visualIdx + 1).find(tab => visibleIds.has(tab.id)) ??
      visual.slice(0, visualIdx).reverse().find(tab => visibleIds.has(tab.id));
    nextTab = candidate ?? null;
    nextTabRoute = candidate?.route ?? null;
  }

  const closed = await closeTab(id);
  if (!closed) return;

  if (isActive) {
    if (nextTabRoute) {
      if (nextTab) activateTab(nextTab);
      else router.push(nextTabRoute);
    } else {
      // Fallback: closeTab auto-creates a welcome tab when list is empty
      const next = browserTabs[browserTabs.length - 1];
      setGroupFolded(tabGroupModel.groupForMode(next.mode), false);
      router.push(`/Browser/${ next.id }`);
    }
  }
}

async function closeAnyTab(tab: HeaderTab) {
  if (tab.browserId) {
    await closeBrowserTab(tab.browserId);
  }
}

// Agent-opened tabs now come from the main-process TabRegistry directly;
// the activeAssets → tabs sync watcher was removed. See
// pkg/sulla-desktop/main/browserTabs/TabRegistry.ts. The UI will mirror
// main's state through a `tabs:change` IPC subscription.

// ── Phase 5: Pointer-event drag-and-drop ──

interface DragState {
  active:       boolean;
  startX:       number;
  startY:       number;
  pointerId:    number;
  grabOffsetX:  number;
  grabOffsetY:  number;
  lastClientX:  number;
  tabEl:        HTMLElement;
  tabId:        string;
  tabHeaderId:  string;
  detached:     boolean;
  initialOrder: string[];
}

const dragState = ref<DragState | null>(null);
let currentDragCancel: (() => void) | null = null;
const transferPayload = new TabTransferPayload();
const suppressDragClick = new TabDragClickSuppression(window);
const dragEdgeScroll = new TabDragAutoScroll(window);

function captureTransferState(tabId: string) {
  let snapshot: TabEditorTransferSnapshot | undefined;
  const collect = (event: Event) => {
    const detail = (event as CustomEvent<TabEditorTransferSnapshot>).detail;

    if (detail?.tabId === tabId && detail.fileEditor) snapshot = detail;
  };

  window.addEventListener('sulla:tab-transfer-state', collect);
  try {
    window.dispatchEvent(new CustomEvent('sulla:tab-transfer-request', { detail: { tabId } }));
  } finally {
    window.removeEventListener('sulla:tab-transfer-state', collect);
  }
  return transferPayload.transient(snapshot, isTabPinned(`browser-${ tabId }`));
}

watch(() => visibleTabs.value.map(tab => tab.id).join('\0'), () => {
  const dragging = dragState.value;

  if (dragging && !visibleTabs.value.some(tab => tab.id === dragging.tabHeaderId)) cancelCurrentDrag();
}, { flush: 'post' });
watch(() => route.path, cancelCurrentDrag, { flush: 'sync' });

const DRAG_DEADZONE = 5;

function offsetLeftWithin(element: HTMLElement, ancestor: HTMLElement): number {
  let left = 0;
  let current: HTMLElement | null = element;
  while (current && current !== ancestor) {
    left += current.offsetLeft;
    current = current.offsetParent as HTMLElement | null;
  }
  return left;
}

function positionDraggedTab(state: DragState, container: HTMLElement): void {
  const containerLeft = container.getBoundingClientRect().left;
  const scope = state.tabEl.closest<HTMLElement>('.tab-group, .tab-pinned-section') ?? container;
  const groupTabs = Array.from(scope.querySelectorAll<HTMLElement>('.tab-item'))
    .filter(element => element.offsetWidth > 0 && element.offsetHeight > 0);
  if (!groupTabs.length) {
    state.tabEl.style.setProperty('--tab-drag-x', '0px');
    return;
  }
  const positions = groupTabs.map(element => offsetLeftWithin(element, container));
  const groupStart = Math.min(...positions);
  const groupEnd = Math.max(...groupTabs.map((element, index) => positions[index] + element.offsetWidth));
  const width = state.tabEl.offsetWidth;
  const visualLeft = state.lastClientX - state.grabOffsetX;
  const minLeft = containerLeft + groupStart - container.scrollLeft;
  const maxLeft = Math.max(minLeft, containerLeft + groupEnd - container.scrollLeft - width);
  const clampedLeft = Math.max(minLeft, Math.min(visualLeft, maxLeft));
  const layoutLeft = containerLeft + offsetLeftWithin(state.tabEl, container) - container.scrollLeft;
  state.tabEl.style.setProperty('--tab-drag-x', `${ clampedLeft - layoutLeft }px`);
}

function onPointerDown(event: PointerEvent, index: number): void {
  if (event.button !== 0 || (event.target as HTMLElement).closest('.tab-close, input')) return;
  cancelCurrentDrag();
  const tabEl = event.currentTarget as HTMLElement;
  const tab = orderedTabs.value.find(item => item.id === tabEl.dataset.tabId) ?? orderedTabs.value[index];

  if (!tab) return;
  const bounds = tabEl.getBoundingClientRect();

  dragState.value = {
    active:      false,
    startX:      event.clientX,
    startY:      event.clientY,
    pointerId:   event.pointerId,
    grabOffsetX: Math.max(0, Math.min(event.clientX - bounds.left, bounds.width)),
    grabOffsetY: Math.max(0, Math.min(event.clientY - bounds.top, bounds.height)),
    lastClientX: event.clientX,
    tabEl,
    tabId:       tab.browserId || '',
    tabHeaderId: tab.id,
    detached:    false,
    initialOrder: orderedTabs.value.map(item => item.id),
  };
  // Ref object values are proxied: keep identity checks on the same object.
  const state = dragState.value;

  if (!state) return;
  let finished = false;
  const removeListeners = () => {
    dragEdgeScroll.stop();
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    window.removeEventListener('keydown', onEscape);
  };
  const resetVisuals = () => {
    tabEl.style.pointerEvents = '';
    tabEl.style.removeProperty('--tab-drag-x');
    document.documentElement.classList.remove('tab-pointer-dragging');
    if (dragState.value === state) dragState.value = null;
    currentDragCancel = null;
  };
  const cancel = (waitForGestureClick: boolean) => {
    if (finished) return;
    finished = true;
    removeListeners();
    if (state.active) tabOrder.value = tabGroupModel.orderTabs([...allTabsById.value.values()], state.initialOrder).map(item => item.id);
    if (state.detached) ipcRenderer.send('tabs:drag-cancel', { tabId: state.tabId });
    resetVisuals();
    if (waitForGestureClick && state.active) suppressDragClick.arm(tabEl, state.pointerId, true);
  };
  const stillPresent = () => tabEl.isConnected && tabEl.offsetWidth > 0 && visibleTabs.value.some(tab => tab.id === state.tabHeaderId);
  const commit = (upEvent: PointerEvent) => {
    if (finished) return;
    if (!stillPresent()) {
      cancel(false);
      return;
    }
    finished = true;
    removeListeners();
    if (state.detached) {
      ipcRenderer.send('tabs:drag-end', {
        tabId:     state.tabId,
        screenX:   upEvent.screenX,
        screenY:   upEvent.screenY,
        transient: captureTransferState(state.tabId),
      });
    }
    resetVisuals();
    if (state.active) suppressDragClick.arm(tabEl, state.pointerId);
  };

  const reposition = (container: HTMLElement, rect: DOMRect) => {
    const peers = Array.from(container.querySelectorAll<HTMLElement>('.tab-item'))
      .filter(element => element.offsetWidth > 0 && element.offsetHeight > 0);
    const fromIndex = orderedTabs.value.findIndex(item => item.id === state.tabHeaderId);
    const pointerX = state.lastClientX - rect.left + container.scrollLeft;
    const target = peers.find(element => pointerX < offsetLeftWithin(element, container) + element.offsetWidth / 2) ?? peers.at(-1);
    const targetIndex = Number(target?.dataset.tabIndex);

    if (fromIndex >= 0 && Number.isFinite(targetIndex) && targetIndex !== fromIndex) {
      reorderTabs(fromIndex, targetIndex);
      nextTick(() => {
        if (dragState.value === state && state.active && !state.detached) positionDraggedTab(state, container);
      });
    }
    positionDraggedTab(state, container);
  };
  const scrollAtEdge = () => {
    if (!stillPresent()) {
      cancel(false);
      return false;
    }
    const container = getScrollEl();

    if (!container || state.detached) return false;
    const rect = container.getBoundingClientRect();
    const direction = state.lastClientX > rect.right - 30 ? 1 : state.lastClientX < rect.left + 30 ? -1 : 0;
    const before = container.scrollLeft;

    if (!direction) return false;
    container.scrollLeft += direction * 8;
    if (container.scrollLeft === before) return false;
    updateScrollButtons();
    reposition(container, rect);
    return true;
  };

  const onMove = (moveEvent: PointerEvent): void => {
    if (moveEvent.pointerId !== state.pointerId || dragState.value !== state) return;
    if (!stillPresent()) {
      cancel(false);
      return;
    }
    const dx = moveEvent.clientX - state.startX;
    const dy = moveEvent.clientY - state.startY;

    if (!state.active) {
      if (Math.hypot(dx, dy) < DRAG_DEADZONE) return;
      state.active = true;
      tabEl.style.pointerEvents = 'none';
      document.documentElement.classList.add('tab-pointer-dragging');
      hideStripPopups();
    }
    state.lastClientX = moveEvent.clientX;

    const detached = moveEvent.clientY < -30 || moveEvent.clientY > window.innerHeight + 30 ||
      moveEvent.clientX < 0 || moveEvent.clientX > window.innerWidth || Math.abs(dy) > 30;

    if (detached && !state.detached && state.tabId) {
      const descriptor = getTab(state.tabId);

      if (descriptor) {
        state.detached = true;
        dragEdgeScroll.stop();
        ipcRenderer.send('tabs:drag-start', {
          tabId:       descriptor.id,
          descriptor:  transferPayload.descriptor(descriptor),
          title:       descriptor.customTitle || descriptor.title,
          favicon:     descriptor.favicon,
          tabCount:    browserTabs.length,
          screenX:     moveEvent.screenX,
          screenY:     moveEvent.screenY,
          grabOffsetX: state.grabOffsetX,
          grabOffsetY: state.grabOffsetY,
        });
      }
    }
    if (state.detached) return;
    const container = getScrollEl();

    if (container) {
      reposition(container, container.getBoundingClientRect());
      dragEdgeScroll.start(scrollAtEdge);
    }
  };

  const onEscape = (keyEvent: KeyboardEvent): void => {
    if (keyEvent.key !== 'Escape' || !state.active) return;
    keyEvent.preventDefault();
    cancel(true);
  };

  const onUp = (upEvent: PointerEvent): void => {
    if (upEvent.pointerId !== state.pointerId) return;
    if (upEvent.type === 'pointercancel') cancel(false);
    else commit(upEvent);
  };

  currentDragCancel = () => cancel(false);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
  window.addEventListener('keydown', onEscape);
}

function cancelCurrentDrag(): void {
  currentDragCancel?.();
}

// ── Phase 6: Middle-click to close ──

function onAuxClick(e: MouseEvent, tab: HeaderTab) {
  if (e.button === 1 && tab.closeable) {
    closeAnyTab(tab);
  }
}

// ── Tab context menu (popup window via IPC) ──

function onTabContextMenu(event: MouseEvent, tab: HeaderTab) {
  hideStripPopups();
  // Build the list of menu items for this tab
  const items: string[] = [tab.pinned ? 'unpin' : 'pin'];

  if (tab.browserId) items.push('rename');
  items.push('---');

  if (tab.closeable) items.push('close');
  items.push('closeOther', 'closeRight');
  items.push('---');
  items.push('duplicate');
  items.push('moveNewWindow');
  items.push('---');
  items.push('moveStart', 'moveEnd');
  if (tab.browserId) {
    items.push('---');
    items.push('reload', 'copyUrl');
  }

  const requestId = crypto.randomUUID();

  claimContextMenu(requestId, action => handleTabContextMenuAction(action, tab.id));
  ipcRenderer.send('tab-context-menu:show', {
    requestId,
    screenX: event.screenX,
    screenY: event.screenY,
    items,
  });
}

// ── Rename (right-click → Rename Tab) ──
// The tab label turns into a text field. Enter or clicking away saves, Esc
// cancels, and an empty name goes back to the page's own title.
const renamingTabId = ref<string | null>(null);
const renameDraft = ref('');
let renameOriginal = '';

function startRename(tab: HeaderTab): void {
  renamingTabId.value = tab.id;
  renameDraft.value = tab.label;
  renameOriginal = tab.label;
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
function handleTabContextMenuAction(action: string, tabId: string): void {
  // Resolve the full HeaderTab from orderedTabs (it may have changed since the menu was opened)
  const headerTab = orderedTabs.value.find(t => t.id === tabId);
  const index = orderedTabs.value.findIndex(t => t.id === tabId);
  const browserId = headerTab?.browserId;
  const tabRoute = headerTab?.route;

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

      setGroupFolded(tabGroupModel.groupForMode(newTab.mode), false);
      router.push(`/Browser/${ newTab.id }`);
    } else {
      if (headerTab) activateTab(headerTab);
    }
    break;

  case 'moveNewWindow': {
    const descriptor = browserId ? getTab(browserId) : undefined;
    if (descriptor) {
      ipcRenderer.send('tabs:move-to-new-window', {
        tabId:      descriptor.id,
        descriptor: transferPayload.descriptor(descriptor),
        tabCount:   browserTabs.length,
        transient:  captureTransferState(descriptor.id),
      });
    }
    break;
  }

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
    if (browserId && tabRoute) {
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
.app-titlebar .tab-scroll-wrapper,
.app-titlebar .tab-scroll-container {
  -webkit-app-region: drag;
  app-region: drag;
}
</style>

<style scoped>
.app-titlebar .tab-working .tab-icon::after { display: none; }
.tab-status { width: 12px; height: 14px; flex: 0 0 12px; display: inline-flex; align-items: center; justify-content: center; }
.tab-status svg { display: block; width: 12px; height: 12px; }
/* While a chat is working the meter takes the icon slot; icon and dot return when it stops. */
.tab-icon-meter { width: 100%; height: 100%; flex: none; }
.tab-icon-meter svg { width: 14px; height: 14px; }
.tab-status-working { color: var(--accent); }
.tab-status-working path {
  transform-box: fill-box;
  transform-origin: center bottom;
  animation: tab-activity-bars 1s ease-in-out infinite;
}
.tab-status-working path:nth-child(2) { animation-delay: -0.65s; }
.tab-status-working path:nth-child(3) { animation-delay: -0.3s; }
@keyframes tab-activity-bars {
  0%, 100% { transform: scaleY(0.4); opacity: 0.6; }
  50% { transform: scaleY(1); opacity: 1; }
}
@media (prefers-reduced-motion: reduce) {
  .tab-status-working path { animation: none; }
}
.tab-status-waiting { color: var(--text-muted); }
.tab-status-you { color: var(--status-warning); }
.tab-status-stalled { color: var(--status-error); }
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
@keyframes tab-working-streak { from { transform: translateX(-100%); } to { transform: translateX(260%); } }

</style>

<style>
/* Keep the normal pointer cursor on hover; use a closed hand only while pressed. */
html.tab-pointer-dragging,
html.tab-pointer-dragging * { cursor: grabbing !important; }

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

<style src="./tabStripGrouped.css"></style>
