<template>
  <header class="sticky top-0 z-50 flex flex-none items-end justify-between bg-page pl-20 pr-4 pt-1 pb-0 transition duration-500 sm:pr-6 lg:pr-8 app-titlebar">
    <div class="relative flex shrink-0 items-center pb-2">
      <a
        aria-label="Home page"
        href="#/"
      >
        <img
          :src="logoLightUrl"
          alt="Sulla Desktop"
          class="h-5 w-auto dark:hidden"
        >
        <img
          :src="logoDarkUrl"
          alt="Sulla Desktop"
          class="hidden h-5 w-auto dark:block"
        >
      </a>
    </div>
    <div class="hidden lg:flex items-end gap-0.5 self-stretch flex-1 min-w-0 ml-4">
      <router-link
        v-for="(tab, index) in orderedTabs"
        :key="tab.id"
        :to="tab.route"
        class="tab-item"
        :class="{
          'tab-native': tab.native,
          'tab-active': tab.isActive && !tab.native,
          'tab-active-native': tab.isActive && tab.native,
          'tab-inactive': !tab.isActive,
          'tab-dragging': dragIndex === index,
          'tab-drag-over-left': dragOverIndex === index && dragDirection === 'left',
          'tab-drag-over-right': dragOverIndex === index && dragDirection === 'right',
        }"
        draggable="true"
        @dragstart="onDragStart($event, index)"
        @dragover.prevent="onDragOver($event, index)"
        @dragend="onDragEnd"
        @drop.prevent="onDrop(index)"
        @contextmenu.prevent="onTabContextMenu($event, tab, index)"
      >
        <img
          v-if="tab.favicon"
          :src="tab.favicon"
          class="h-3.5 w-3.5 rounded-sm"
          alt=""
        >
        <span :class="tab.closeable ? 'max-w-32 truncate' : ''">{{ tab.label }}</span>
        <button
          v-if="tab.closeable"
          class="tab-close"
          type="button"
          aria-label="Close tab"
          @click.prevent.stop="closeAnyTab(tab)"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" class="h-3 w-3">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </router-link>
      <button
        class="tab-new"
        type="button"
        aria-label="New tab"
        @click="openNewBrowserTab"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" class="h-3.5 w-3.5">
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
      <!-- Three-dot menu -->
      <div class="relative hidden lg:flex">
        <button
          type="button"
          class="flex h-5 w-5 items-center justify-center rounded-lg shadow-md ring-1 shadow-black/5 ring-black/5 cursor-pointer"
          aria-label="More options"
          @click="isMoreMenuOpen = !isMoreMenuOpen"
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            fill="currentColor"
            class="h-3.5 w-3.5 fill-sky-400"
          >
            <circle cx="12" cy="5" r="1.5" />
            <circle cx="12" cy="12" r="1.5" />
            <circle cx="12" cy="19" r="1.5" />
          </svg>
        </button>
        <Teleport to="body">
          <div
            v-if="isMoreMenuOpen"
            class="more-menu-overlay"
            @click="isMoreMenuOpen = false"
          />
          <div
            v-if="isMoreMenuOpen && !isHistorySubmenuOpen"
            class="more-menu"
          >
            <button
              class="more-menu-item"
              @click="openNewBrowserTab(); isMoreMenuOpen = false"
            >
              New Tab
            </button>
            <button
              class="more-menu-item"
              @click="openModeTab('integrations')"
            >
              Integrations
            </button>
            <button
              class="more-menu-item"
              @click="openModeTab('extensions')"
            >
              Extensions
            </button>
            <button
              class="more-menu-item"
              @click="openModeTab('secretary')"
            >
              Secretary Mode
            </button>
            <div class="more-menu-separator" />
            <button
              class="more-menu-item more-menu-item-arrow"
              @click="isHistorySubmenuOpen = true"
            >
              History
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" class="more-menu-arrow-icon">
                <path d="M9 18l6-6-6-6" />
              </svg>
            </button>
          </div>
          <!-- History submenu -->
          <div
            v-if="isMoreMenuOpen && isHistorySubmenuOpen"
            class="more-menu more-menu-history"
          >
            <button
              class="more-menu-item more-menu-item-back"
              @click="isHistorySubmenuOpen = false"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" class="more-menu-arrow-icon">
                <path d="M15 18l-6-6 6-6" />
              </svg>
              History
            </button>
            <div class="more-menu-separator" />
            <div
              v-if="closedTabs.length === 0"
              class="more-menu-empty"
            >
              No closed tabs
            </div>
            <button
              v-for="(entry, idx) in closedTabs"
              :key="idx"
              class="more-menu-item more-menu-history-item"
              :title="entry.url"
              @click="onRestoreClosedTab(idx)"
            >
              <img
                v-if="entry.favicon"
                :src="entry.favicon"
                class="more-menu-favicon"
                alt=""
              >
              <span class="more-menu-history-label">{{ entry.title || entry.url }}</span>
              <span class="more-menu-history-time">{{ formatTimeAgo(entry.closedAt) }}</span>
            </button>
            <template v-if="closedTabs.length > 0">
              <div class="more-menu-separator" />
              <button
                class="more-menu-item more-menu-clear"
                @click="clearClosedTabs(); isHistorySubmenuOpen = false; isMoreMenuOpen = false"
              >
                Clear History
              </button>
            </template>
          </div>
        </Teleport>
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

  <!-- Tab context menu -->
  <Teleport to="body">
    <div
      v-if="ctxMenu.visible"
      class="tab-ctx-overlay"
      @click="closeCtxMenu"
      @contextmenu.prevent="closeCtxMenu"
    />
    <div
      v-if="ctxMenu.visible"
      class="tab-ctx-menu"
      ref="ctxMenuEl"
      :style="ctxMenuStyle"
    >
      <button
        v-if="ctxMenu.tab?.closeable"
        class="tab-ctx-item"
        @click="ctxCloseTab"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" class="tab-ctx-icon">
          <path d="M18 6L6 18M6 6l12 12" />
        </svg>
        Close Tab
      </button>
      <button
        class="tab-ctx-item"
        @click="ctxCloseOtherTabs"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" class="tab-ctx-icon">
          <path d="M9 3H5a2 2 0 0 0-2 2v4" />
          <path d="M15 3h4a2 2 0 0 1 2 2v4" />
          <path d="M9 21H5a2 2 0 0 1-2-2v-4" />
          <path d="M15 21h4a2 2 0 0 0 2-2v-4" />
          <path d="M14 10l-4 4M10 10l4 4" />
        </svg>
        Close Other Tabs
      </button>
      <button
        class="tab-ctx-item"
        @click="ctxCloseTabsToRight"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" class="tab-ctx-icon">
          <path d="M9 18l6-6-6-6" />
          <path d="M18 6L18 18" />
        </svg>
        Close Tabs to the Right
      </button>
      <div class="tab-ctx-separator" />
      <button
        class="tab-ctx-item"
        @click="ctxDuplicateTab"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" class="tab-ctx-icon">
          <rect x="8" y="8" width="13" height="13" rx="2" />
          <path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" />
        </svg>
        Duplicate Tab
      </button>
      <div class="tab-ctx-separator" />
      <button
        class="tab-ctx-item"
        @click="ctxMoveToStart"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" class="tab-ctx-icon">
          <path d="M11 17l-5-5 5-5" />
          <path d="M18 17l-5-5 5-5" />
        </svg>
        Move to Start
      </button>
      <button
        class="tab-ctx-item"
        @click="ctxMoveToEnd"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" class="tab-ctx-icon">
          <path d="M13 7l5 5-5 5" />
          <path d="M6 7l5 5-5 5" />
        </svg>
        Move to End
      </button>
      <template v-if="ctxMenu.tab?.browserId">
        <div class="tab-ctx-separator" />
        <button
          class="tab-ctx-item"
          @click="ctxReloadTab"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" class="tab-ctx-icon">
            <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
            <path d="M3 3v5h5" />
            <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
            <path d="M16 16h5v5" />
          </svg>
          Reload
        </button>
        <button
          class="tab-ctx-item"
          @click="ctxCopyUrl"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" class="tab-ctx-icon">
            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
          </svg>
          Copy URL
        </button>
      </template>
    </div>
  </Teleport>

  <!-- Mobile Menu Dropdown (appears below header) -->
  <div
    v-if="isMobileMenuOpen"
    class="fixed inset-0 z-40 lg:hidden"
  >
    <div
      class="fixed inset-0 bg-black/50 backdrop-blur-sm transition-opacity duration-300 cursor-pointer"
      @click="toggleMobileMenu"
    />
    <div class="fixed top-14 left-0 right-0 bg-page shadow-lg transform transition-transform duration-300 ease-in-out rounded-b-lg">
      <div class="flex justify-end px-4 py-2">
        <button
          type="button"
          class="relative cursor-pointer"
          aria-label="Close navigation"
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
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>
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
import { ref } from 'vue';

// Module-level state: shared across all AgentHeader instances (one per keep-alive'd page)
const tabOrder = ref<string[]>([]);
const knownAssetIds = ref(new Set<string>());
</script>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { getExtensionService } from '@pkg/agent';
import { getAgentPersonaRegistry } from '@pkg/agent/database/registry/AgentPersonaRegistry';
import { useBrowserTabs, type BrowserTabMode } from '@pkg/composables/useBrowserTabs';

const extensionService = getExtensionService();
const router = useRouter();
const { tabs: browserTabs, closedTabs, createTab, closeTab, updateTab, getTab, ensureOneTab, restoreClosedTab, clearClosedTabs } = useBrowserTabs();

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
const isMoreMenuOpen = ref(false);
const isHistorySubmenuOpen = ref(false);

// Reset submenu when main menu closes
watch(isMoreMenuOpen, (open) => {
  if (!open) isHistorySubmenuOpen.value = false;
});
const logoLightUrl = new URL('../../../../resources/icons/logo-sulla-desktop-nobg.png', import.meta.url).toString();
const logoDarkUrl = new URL('../../../../resources/icons/logo-sulla-desktop-dark-nobg.png', import.meta.url).toString();

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
  isMoreMenuOpen.value = false;
  const tab = createTab('about:blank', { mode });

  router.push(`/Browser/${ tab.id }`);
}

// Global hotkey: Cmd+Shift+S → open Secretary Mode tab
function handleSecretaryShortcut(e: KeyboardEvent): void {
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'S') {
    e.preventDefault();
    openModeTab('secretary');
  }
}

onMounted(() => {
  window.addEventListener('keydown', handleSecretaryShortcut);
});
onUnmounted(() => {
  window.removeEventListener('keydown', handleSecretaryShortcut);
});

function onRestoreClosedTab(index: number) {
  const tab = restoreClosedTab(index);

  isMoreMenuOpen.value = false;
  if (tab) {
    router.push(`/Browser/${ tab.id }`);
  }
}

function formatTimeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60_000);

  if (mins < 1) return 'just now';
  if (mins < 60) return `${ mins }m ago`;
  const hrs = Math.floor(mins / 60);

  if (hrs < 24) return `${ hrs }h ago`;
  const days = Math.floor(hrs / 24);

  return `${ days }d ago`;
}

const toggleMobileMenu = () => {
  isMobileMenuOpen.value = !isMobileMenuOpen.value;
};

function openNewBrowserTab() {
  const tab = createTab('about:blank', { mode: 'chat' });

  router.push(`/Browser/${ tab.id }`);
}

function closeBrowserTab(id: string) {
  const isActive = route.path === `/Browser/${ id }`;

  closeTab(id);
  if (isActive) {
    // closeTab auto-creates a new tab if it was the last one,
    // so there's always at least one tab to navigate to.
    const next = browserTabs[browserTabs.length - 1];

    router.push(`/Browser/${ next.id }`);
  }
}

function closeAnyTab(tab: HeaderTab) {
  if (tab.browserId) {
    closeBrowserTab(tab.browserId);
  }
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
  const pillModes = new Set(['chat', 'calendar', 'integrations', 'extensions']);

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
    const filtered = tabOrder.value.filter(id => currentSet.has(id));
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

// Auto-open a browser tab when the agent registers a new active asset

watch(
  () => persona.activeAssets.filter(a => a.active).map(a => ({ id: a.id, url: a.url, title: a.title, type: a.type, content: a.content })),
  (currentAssets) => {
    const currentIds = currentAssets.map(a => a.id);

    for (const asset of currentAssets) {
      if (knownAssetIds.value.has(asset.id)) {
        // Update content for existing document tabs (agent may upsert with new content)
        if (asset.type === 'document' && asset.content) {
          const existingTab = browserTabs.find((t: any) => t.assetId === asset.id);
          if (existingTab) {
            updateTab(existingTab.id, { content: asset.content });
          }
        }
        continue;
      }

      if (asset.type === 'document' && asset.content) {
        // Document asset with raw HTML content — open as Shadow DOM tab
        knownAssetIds.value.add(asset.id);
        const tab = createTab('about:blank', { mode: 'document' });
        updateTab(tab.id, { title: asset.title || 'Document', assetId: asset.id, content: asset.content });
      } else if (asset.url) {
        // Standard iframe asset
        knownAssetIds.value.add(asset.id);
        const tab = createTab(asset.url);
        updateTab(tab.id, { title: asset.title || 'Website', assetId: asset.id });
      }
    }
    // Clean up removed assets
    for (const id of knownAssetIds.value) {
      if (!currentIds.includes(id)) {
        knownAssetIds.value.delete(id);
      }
    }
  },
  { immediate: true },
);

// ── Drag-and-drop ──

const dragIndex = ref<number | null>(null);
const dragOverIndex = ref<number | null>(null);
const dragDirection = ref<'left' | 'right' | null>(null);

function onDragStart(event: DragEvent, index: number) {
  dragIndex.value = index;
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', String(index));
  }
}

function onDragOver(_event: DragEvent, index: number) {
  if (dragIndex.value === null || dragIndex.value === index) {
    dragOverIndex.value = null;
    dragDirection.value = null;

    return;
  }
  dragOverIndex.value = index;
  dragDirection.value = index < dragIndex.value ? 'left' : 'right';
}

function onDrop(targetIndex: number) {
  if (dragIndex.value === null || dragIndex.value === targetIndex) {
    onDragEnd();

    return;
  }

  // Reorder the tabOrder array
  const ids = [...tabOrder.value];
  const [moved] = ids.splice(dragIndex.value, 1);

  ids.splice(targetIndex, 0, moved);
  tabOrder.value = ids;

  onDragEnd();
}

function onDragEnd() {
  dragIndex.value = null;
  dragOverIndex.value = null;
  dragDirection.value = null;
}

// ── Tab context menu ──

const ctxMenuEl = ref<HTMLElement | null>(null);
const ctxMenuPos = ref<{ x: number; y: number }>({ x: 0, y: 0 });

const ctxMenu = ref<{ visible: boolean; x: number; y: number; tab: HeaderTab | null; index: number }>({
  visible: false, x: 0, y: 0, tab: null, index: -1,
});

const ctxMenuStyle = computed(() => ({
  top:  `${ ctxMenuPos.value.y }px`,
  left: `${ ctxMenuPos.value.x }px`,
}));

function onTabContextMenu(event: MouseEvent, tab: HeaderTab, index: number) {
  ctxMenu.value = { visible: true, x: event.clientX, y: event.clientY, tab, index };
  // Start at click position, then adjust after render
  ctxMenuPos.value = { x: event.clientX, y: event.clientY };
  nextTick(() => {
    if (!ctxMenuEl.value) return;
    const rect = ctxMenuEl.value.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let { x, y } = ctxMenuPos.value;

    // Flip left if overflowing right edge
    if (x + rect.width > vw) {
      x = Math.max(0, x - rect.width);
    }
    // Flip up if overflowing bottom edge
    if (y + rect.height > vh) {
      y = Math.max(0, y - rect.height);
    }
    ctxMenuPos.value = { x, y };
  });
}

function closeCtxMenu() {
  ctxMenu.value = { visible: false, x: 0, y: 0, tab: null, index: -1 };
}

function ctxCloseTab() {
  const tab = ctxMenu.value.tab;

  closeCtxMenu();
  if (tab) {
    closeAnyTab(tab);
  }
}

function ctxCloseOtherTabs() {
  const keepId = ctxMenu.value.tab?.id;

  closeCtxMenu();
  if (!keepId) return;

  // Close all closeable browser tabs except the one we right-clicked
  for (const bt of [...browserTabs]) {
    const tabId = `browser-${ bt.id }`;

    if (tabId !== keepId) {
      closeBrowserTab(bt.id);
    }
  }

}

function ctxCloseTabsToRight() {
  const idx = ctxMenu.value.index;

  closeCtxMenu();
  const tabs = orderedTabs.value;

  // Close all closeable tabs to the right of the clicked index
  for (let i = tabs.length - 1; i > idx; i--) {
    const t = tabs[i];

    if (t.closeable) {
      closeAnyTab(t);
    }
  }
}

function ctxDuplicateTab() {
  const tab = ctxMenu.value.tab;

  closeCtxMenu();
  if (!tab) return;

  if (tab.browserId) {
    // Duplicate browser tab: open a new browser tab (it starts at about:blank)
    const newTab = createTab();

    router.push(`/Browser/${ newTab.id }`);
  } else {
    // For static/extension tabs, just navigate (can't truly "duplicate")
    router.push(tab.route);
  }
}

function ctxMoveToStart() {
  const idx = ctxMenu.value.index;

  closeCtxMenu();
  if (idx <= 0) return;

  const ids = [...tabOrder.value];
  const [moved] = ids.splice(idx, 1);

  ids.unshift(moved);
  tabOrder.value = ids;
}

function ctxMoveToEnd() {
  const idx = ctxMenu.value.index;

  closeCtxMenu();
  if (idx < 0 || idx >= tabOrder.value.length - 1) return;

  const ids = [...tabOrder.value];
  const [moved] = ids.splice(idx, 1);

  ids.push(moved);
  tabOrder.value = ids;
}

function ctxReloadTab() {
  const tab = ctxMenu.value.tab;

  closeCtxMenu();
  if (!tab?.browserId) return;

  // Navigate away and back to force iframe reload
  const currentRoute = tab.route;

  router.push('/Chat').then(() => {
    router.push(currentRoute);
  });
}

async function ctxCopyUrl() {
  const tab = ctxMenu.value.tab;

  closeCtxMenu();
  if (!tab?.browserId) return;

  const bt = browserTabs.find((t: { id: string }) => t.id === tab.browserId);

  if (bt?.url) {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(bt.url);
    } else {
      const ta = document.createElement('textarea');
      ta.value = bt.url;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
  }
}
</script>

<style scoped>
.tab-item {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.5rem 1rem;
  font-size: 0.75rem;
  font-weight: 600;
  border-radius: 8px 8px 0 0;
  border: none;
  cursor: pointer;
  transition: color 150ms, background-color 150ms;
  position: relative;
  white-space: nowrap;
  text-decoration: none;
  z-index: 0;
}

/* Native tabs (Chat, Calendar, Integrations, Extensions): pill style */
.tab-active-native {
  background-color: var(--bg-surface-alt);
  color: var(--text-primary);
  z-index: 2;
  border-radius: 8px;
}

/* Dynamic tabs (extensions, browser): Chrome-style with bottom scoops */
.tab-active {
  background-color: var(--bg-surface-alt);
  color: var(--text-primary);
  z-index: 2;
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

.tab-dragging {
  opacity: 0.4;
}

.tab-drag-over-left {
  box-shadow: inset 2px 0 0 0 var(--accent-primary);
}

.tab-drag-over-right {
  box-shadow: inset -2px 0 0 0 var(--accent-primary);
}

.tab-inactive {
  color: var(--text-secondary);
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
  margin-left: 0.25rem;
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
/* Context menu — unscoped because it's teleported to body */
@keyframes tabCtxFadeIn {
  from { opacity: 0; transform: scale(0.96); }
  to   { opacity: 1; transform: scale(1); }
}

.tab-ctx-overlay {
  position: fixed;
  inset: 0;
  z-index: 9999;
}

.tab-ctx-menu {
  position: fixed;
  z-index: 10000;
  min-width: 240px;
  background: #161b22;
  border: 1px solid #30363d;
  border-radius: 8px;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.6), 0 0 1px rgba(63, 185, 80, 0.15);
  padding: 6px 0;
  animation: tabCtxFadeIn 0.15s ease-out;
  font-family: var(--ifm-font-family-monospace, ui-monospace, SFMono-Regular, Menlo, monospace);
}

.tab-ctx-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 7px 14px;
  border: none;
  background: transparent;
  color: #e6edf3;
  font-size: 13px;
  font-family: inherit;
  cursor: pointer;
  text-align: left;
  transition: background 0.1s;
}

.tab-ctx-item:hover {
  background: rgba(63, 185, 80, 0.1);
  color: #3fb950;
}

.tab-ctx-item:hover .tab-ctx-icon {
  opacity: 1;
  stroke: #3fb950;
}

.tab-ctx-icon {
  width: 14px;
  height: 14px;
  opacity: 0.6;
  flex-shrink: 0;
}

.tab-ctx-separator {
  height: 1px;
  background: #21262d;
  margin: 4px 0;
}

/* More menu (three-dot) — unscoped because it's teleported to body */
.more-menu-overlay {
  position: fixed;
  inset: 0;
  z-index: 9999;
}

.more-menu {
  position: fixed;
  top: 40px;
  right: 12px;
  z-index: 10000;
  min-width: 180px;
  background: var(--bg-surface-alt);
  border: 1px solid var(--border-default);
  border-radius: 8px;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.6), 0 0 1px color-mix(in srgb, var(--accent-primary) 15%, transparent);
  padding: 6px 0;
  animation: tabCtxFadeIn 0.15s ease-out;
  font-family: var(--ifm-font-family-monospace, ui-monospace, SFMono-Regular, Menlo, monospace);
}

.more-menu-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 7px 14px;
  border: none;
  background: transparent;
  color: var(--text-primary);
  font-size: 13px;
  font-family: inherit;
  cursor: pointer;
  text-align: left;
  transition: background 0.1s;
}

.more-menu-item:hover {
  background: color-mix(in srgb, var(--accent-primary) 10%, transparent);
  color: var(--accent-primary);
}

.more-menu-item-arrow,
.more-menu-item-back {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.more-menu-item-back {
  gap: 6px;
  justify-content: flex-start;
  font-weight: 600;
}

.more-menu-arrow-icon {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
}

.more-menu-separator {
  height: 1px;
  background: #21262d;
  margin: 4px 0;
}

.more-menu-history {
  max-height: 400px;
  max-width: min(360px, calc(100vw - 24px));
  overflow-y: auto;
}

.more-menu-history-item {
  display: flex;
  align-items: center;
  gap: 8px;
}

.more-menu-favicon {
  width: 14px;
  height: 14px;
  border-radius: 2px;
  flex-shrink: 0;
}

.more-menu-history-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.more-menu-history-time {
  font-size: 11px;
  color: #8b949e;
  flex-shrink: 0;
  margin-left: auto;
}

.more-menu-empty {
  padding: 7px 14px;
  color: #8b949e;
  font-size: 13px;
  font-style: italic;
}

.more-menu-clear {
  color: #f85149 !important;
}

.more-menu-clear:hover {
  background: rgba(248, 81, 73, 0.1) !important;
  color: #f85149 !important;
}
</style>
