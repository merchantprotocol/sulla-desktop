<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<template>
  <div class="agent-router-root">
    <div class="agent-router-body" :class="{ 'has-titlebar': hasTitlebar, 'conversations-fullscreen': activeTabMode === 'conversations' }">
      <!--
        Global ModeRail — lives at the window level so it stays visible
        across every tab and every mode (chat, browser, secretary,
        marketplace, my work, library). Clicks dispatch a window event
        that the active BrowserTab listens for.
      -->
      <ModeRail
        v-if="conversationShellPolicy.showsDesktopRail(activeTabMode)"
        class="agent-router-rail"
        :active="activeTabMode"
        :active-sub-tab="activeSubTab"
        :bookmarks-open="bookmarksOpen"
        :chat-files-open="chatFilesOpen"
        :rail-apps="railApps"
        :extensions="railExtensions"
        @set-mode="onModeRailSelect"
        @open-rail-app="openRailApp"
        @open-extension="openExtension"
        @extension-permissions="openExtensionPermissions"
        @remove-extension="removeExtensionFromRail"
        @overlay-change="modeRailOverlayOpen = $event"
        @toggle-bookmarks="toggleBookmarks()"
        @toggle-chat-files="toggleChatFiles()"
      />

      <!--
        Bookmarks pane — window-level (not per tab) so it stays open while
        the bookmarks it opens swap through the preview tab beside it.
      -->
      <BookmarksPane
        v-if="bookmarksOpen"
        :active-tab="activeTabInfo"
        :reveal-id="bookmarkRevealId"
        @close="toggleBookmarks(false)"
      />

      <div class="agent-router-content flex flex-col">
        <AgentHeader v-if="processPerTab && activeTabMode !== 'browser'" class="internal-shell-header" />
        <NoAiConnectedBanner />
        <!--
          Non-browser routes use keep-alive normally.
          Hidden when a browser tab is the active route.
        -->
        <router-view
          v-show="!isBrowserRoute"
          v-slot="{ Component }"
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
        <template v-for="tab in browserTabs" :key="tab.id">
          <div
            v-if="openedTabIds.has(tab.id) && processPerTab && tab.mode !== 'browser'"
            :ref="(element) => setInternalTabElement(tab.id, element)"
            class="browser-tab-layer internal-browser-tab-layer"
          >
            <div v-if="crashedInternalTabIds.has(tab.id)" class="internal-tab-reload" role="alert">
              <span>This tab stopped unexpectedly.</span>
              <button type="button" @click="reloadInternalTab(tab.id)">Reload tab</button>
            </div>
          </div>
          <BrowserTab
            v-else-if="openedTabIds.has(tab.id)"
            class="browser-tab-layer"
            :class="{ 'browser-tab-hidden': route.path !== `/Browser/${tab.id}` }"
            :tab-id="tab.id"
            :is-visible="route.path === `/Browser/${tab.id}`"
          />
        </template>
      </div>
    </div>

    <aside v-if="permissionPrompt" class="extension-permission-prompt" aria-live="polite">
      <div class="prompt-kicker">Extension permission</div>
      <b>{{permissionPrompt.name}} wants to {{permissionPrompt.label.toLowerCase()}}</b>
      <p>Sulla carried on without it. The hook stays skipped until you choose.</p>
      <code>{{permissionPrompt.event.hook}}</code>
      <div><button type="button" @click="answerPermission(false)">Don’t allow</button><button type="button" class="allow" @click="answerPermission(true)">Allow</button></div>
    </aside>

    <!-- Startup progress overlay -->
    <StartupOverlay :mode="shutdownMode ? 'shutdown' : 'startup'" />

    <!-- A locked or not-yet-configured vault blocks every tab and route. -->
    <VaultUnlockScreen v-if="vaultUnlockVisible" />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch, onMounted, onUnmounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { lazyScreen } from './agent/lazyScreen';
const BrowserTab = lazyScreen(() => import('./BrowserTab.vue'), 'BrowserTab');
import ModeRail from './chat/components/chrome/ModeRail.vue';
import StartupOverlay from './agent/StartupOverlay.vue';
import AgentHeader from './agent/AgentHeader.vue';
import VaultUnlockScreen from './agent/VaultUnlockScreen.vue';
import { useStartupProgress } from './agent/useStartupProgress';
import BookmarksPane from './bookmarks/BookmarksPane.vue';
import NoAiConnectedBanner from '@pkg/components/NoAiConnectedBanner.vue';

import { getHumanPresenceTracker } from '@pkg/agent/services/HumanPresenceTracker';
import { isStudioSection, railSubTabFor } from '@pkg/components/routines/studioSections';
import type { WorkspaceTabRequest } from '@pkg/shared/workspaceTabRequest';
import { openDocumentTab, openWorkspaceTab, orderPinnedFirst, useBrowserTabs, getPersistedActiveTabId, persistActiveTabId } from '@pkg/composables/useBrowserTabs';
import type { BrowserTab as BrowserTabDescriptor } from '@pkg/composables/useBrowserTabs';
import { selectTabAfterRemoval } from '@pkg/composables/tabSelection';
import { supportsDocumentEditor } from '@pkg/pages/files/editor/editorTypes';
import { shouldShowVaultUnlockOverlay, useVaultUnlock } from '@pkg/composables/useVaultUnlock';
import { restoreChatFromHistory } from '@pkg/pages/chat/services/historyRestore';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';
import { ConversationShellPolicy } from './conversations/ConversationShellPolicy';

const hookPromptLabels:Record<string,string>={on_user_message:'Read your messages',after_model_response:'Read Sulla’s replies',after_tool_call:'See tool results',on_memory_write:'See what Sulla saves to memory',on_workflow_node_start:'See workflow steps start',on_workflow_node_finish:'See workflow steps finish',on_agent_job_start:'See agents start',on_agent_job_finish:'See agents finish',before_tool_call:'Check tool calls before they run',before_model_call:'Check what Sulla sends to the AI model'};
const permissionPrompt=ref<{event:{extensionId:string;hook:any};name:string;label:string}>();
const modeRailOverlayOpen = ref(false);
const noAiBannerVisible = ref(false);
function onNoAiBannerChange(event: Event) { noAiBannerVisible.value = !!(event as CustomEvent<boolean>).detail; }
window.addEventListener('sulla:no-ai-banner', onNoAiBannerChange);
async function onPermissionNeeded(_event:unknown,event:{extensionId:string;hook:any}){if(permissionPrompt.value)return;const extensions=await ipcRenderer.invoke('extension-permissions:list').catch((err:unknown)=>{console.warn('[AgentRouter] extension permissions load failed:',err);return null});if(!extensions)return;const ext=extensions.find(item=>item.extensionId===event.extensionId);if(ext&&typeof ext.grants?.[event.hook]==='boolean')return;// already decided: never re-ask
  permissionPrompt.value={event,name:ext?.name||event.extensionId,label:hookPromptLabels[event.hook]||event.hook}}
async function answerPermission(granted:boolean){const prompt=permissionPrompt.value;if(!prompt)return;await ipcRenderer.invoke('extension-permissions:set-hook',{extensionId:prompt.event.extensionId,hook:prompt.event.hook,granted});permissionPrompt.value=undefined}

const route = useRoute();
const router = useRouter();
const { tabs: browserTabs, tabOrder, pinnedTabIds, createTab, ensureOneTab, restoreClosedTab, updateTab, adoptTab, releaseTab } = useBrowserTabs();
const { tryAutoLogin, invalidateStatus, statusResolved: vaultStatusResolved, loggedIn: vaultLoggedIn, waitingOnUnlock } = useVaultUnlock();
const vaultUnlockVisible = computed(() => shouldShowVaultUnlockOverlay({
  statusResolved: vaultStatusResolved.value,
  loggedIn: vaultLoggedIn.value,
  waitingOnUnlock: waitingOnUnlock.value,
}));
watch(vaultUnlockVisible, (visible) => {
  if (visible) void ipcRenderer.invoke('vault:unlock-required' as any).catch(() => undefined);
}, { immediate: true });
const { systemReady, showOverlay: startupOverlayVisible } = useStartupProgress();

watch(systemReady, (ready) => {
  if (!ready) {
    invalidateStatus();

    return;
  }
  void tryAutoLogin();
}, { immediate: true });

// Close the side panel while the startup overlay is active.
const sidePanelBlocked = computed(() => startupOverlayVisible.value);
watch(sidePanelBlocked, (blocked) => {
  if (blocked) {
    ipcRenderer.invoke('chrome-api:sidePanel:close' as any, { all: true });
  }
});

const isBrowserRoute = computed(() => route.path.startsWith('/Browser/'));
const shutdownMode = ref(false);
const onAppShuttingDown = () => { shutdownMode.value = true; };
const chromePainted = ref(false);
let tabViewsRevealed = false;
const onChromeReady = () => { chromePainted.value = true; };
watch([chromePainted, systemReady, startupOverlayVisible, vaultUnlockVisible, shutdownMode], ([painted, ready, startupVisible, vaultVisible, shuttingDown]) => {
  if (!painted || !ready || startupVisible || vaultVisible || shuttingDown || tabViewsRevealed) return;
  tabViewsRevealed = true;
  void ipcRenderer.invoke('internal-tab-view:chrome-ready' as any).catch(error => {
    console.warn('[AgentRouter] unable to signal tab view readiness', error);
  });
}, { immediate: true });
// Keep a tab's page tree unmounted until the user first opens it. Once opened,
// retain its existing renderer-local state while switching between tabs.
const openedTabIds = reactive(new Set<string>());
// The process isolation kill switch can be flipped in localStorage without a
// rebuild: localStorage.setItem('tabs.processPerTab', 'false'). Defaults on.
const processPerTab = localStorage.getItem('tabs.processPerTab') !== 'false';
const internalTabElements = new Map<string, HTMLElement>();
const internalTabObservers = new Map<string, ResizeObserver>();
const crashedInternalTabIds = reactive(new Set<string>());
function onInternalTabCrashed(_event: unknown, tabId: string) { crashedInternalTabIds.add(tabId); }
function onInternalTabUpdated(_event: unknown, tabId: string, descriptor: BrowserTabDescriptor) {
  if (descriptor?.id === tabId) updateTab(tabId, descriptor);
}
function onWorkspaceTabRequested(_event: unknown, request: WorkspaceTabRequest) {
  void openWorkspaceTab(request).catch(error => console.error('[AgentRouter] Could not open workspace tab', error));
}
function refreshInternalTabBounds(tabId: string): void {
  const element = internalTabElements.get(tabId);
  if (!element || !internalTabRoute(tabId)) return;
  requestAnimationFrame(() => {
    if (internalTabElements.get(tabId) !== element || !internalTabRoute(tabId)) return;
    void ipcRenderer.invoke('internal-tab-view:bounds' as any, tabId, internalTabBounds(element)).catch(() => undefined);
  });
}
function onInternalTabLoaded(_event: unknown, tabId: string) { refreshInternalTabBounds(tabId); }
function onInternalTabsWindowResize() {
  for (const tabId of internalTabElements.keys()) refreshInternalTabBounds(tabId);
}
function reloadInternalTab(tabId: string) {
  crashedInternalTabIds.delete(tabId);
  void ipcRenderer.invoke('internal-tab-view:reload' as any, tabId).catch(() => undefined);
}
const internalTabRoute = (id: string) => route.path === `/Browser/${ id }` && browserTabs.some(tab => tab.id === id && tab.mode !== 'browser');
// Sent with activation so a new tab's renderer knows its tab before the tab list is saved.
function internalTabDescriptor(id: string): unknown {
  const tab = browserTabs.find(candidate => candidate.id === id);
  try { return tab ? JSON.parse(JSON.stringify(tab)) : null } catch { return null }
}
function internalTabBounds(element: HTMLElement) {
  const rect = element.getBoundingClientRect();
  return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.max(1, Math.round(rect.width)), height: Math.max(1, Math.round(rect.height)) };
}
function setInternalTabElement(id: string, value: Element | null): void {
  internalTabObservers.get(id)?.disconnect();
  internalTabObservers.delete(id);
  if (!(value instanceof HTMLElement)) { internalTabElements.delete(id); return; }
  internalTabElements.set(id, value);
  const update = () => {
    if (internalTabRoute(id)) void ipcRenderer.invoke('internal-tab-view:bounds' as any, id, internalTabBounds(value)).catch(() => undefined);
  };
  const observer = new ResizeObserver(update);
  observer.observe(value);
  internalTabObservers.set(id, observer);
  // The ref callback can run before shell layout settles; ResizeObserver only
  // notices size changes, so also remeasure after the initial layout frame.
  requestAnimationFrame(update);
}
watch(() => route.path, async(path, previous) => {
  if (!processPerTab) return;
  const previousId = /^\/Browser\/(.+)$/.exec(previous || '')?.[1];
  if (previousId) void ipcRenderer.invoke('internal-tab-view:visible' as any, previousId, false).catch(() => undefined);
  const id = /^\/Browser\/(.+)$/.exec(path)?.[1];
  if (!id) return;
  openedTabIds.add(id);
  await nextTick();
  const element = internalTabElements.get(id);
  if (element) void ipcRenderer.invoke('internal-tab-view:activate' as any, id, new URLSearchParams(window.location.search).get('windowKey') || 'main', internalTabBounds(element), internalTabDescriptor(id)).catch(() => undefined);
}, { immediate: true });
watch(() => browserTabs.map(tab => tab.id).join(','), (joined, old) => {
  if (!processPerTab) return;
  const active = new Set(joined ? joined.split(',') : []);
  for (const id of old ? old.split(',') : []) if (!active.has(id)) {
    internalTabObservers.get(id)?.disconnect();
    internalTabObservers.delete(id);
    internalTabElements.delete(id);
    void ipcRenderer.invoke('internal-tab-view:close' as any, id).catch(() => undefined);
  }
});
watch(() => route.path, (path) => {
  const match = /^\/Browser\/(.+)$/.exec(path);
  if (match) openedTabIds.add(match[1]);
}, { immediate: true });
// Only the browser tab and these named pages render AgentHeader. Defaulting
// unknown/full-screen routes to false avoids relying on kept-alive DOM nodes.
const hasTitlebar = computed(() => isBrowserRoute.value || [
  'AgentCalendar',
  'AgentIntegrations',
  'AgentIntegrationDetail',
  'ExtensionView',
].includes(String(route.name)));

// Persist active tab ID whenever the route changes so restarts can resume it
watch(() => route.path, (path) => {
  const match = path.match(/^\/Browser\/(.+)$/);
  if (match) persistActiveTabId(match[1]);
});

// ── Active-tab guard ──
// The `/Browser/:id` route IS the active tab. Every removal path (user close,
// agent tab closed by main, job ending, tab cap eviction) splices the tab list
// without knowing about the route. If the active id disappears we re-point
// the route at a neighbour, or open a fresh chat tab when none remain, so the
// view never points at a missing tab (the blank-screen bug). One guard here
// covers every path.
function currentVisualTabOrder(): string[] {
  const ids = browserTabs.map(t => t.id);
  const saved = tabOrder.value.filter(id => ids.includes(id));
  const rest = ids.filter(id => !saved.includes(id));

  return orderPinnedFirst([...saved, ...rest], pinnedTabIds.value);
}

let knownTabOrder: string[] = currentVisualTabOrder();
const visualTabOrderKey = computed(() => JSON.stringify(currentVisualTabOrder()));

watch(visualTabOrderKey, () => {
  const previousOrder = knownTabOrder;
  knownTabOrder = currentVisualTabOrder();

  const match = /^\/Browser\/(.+)$/.exec(route.path);
  if (!match) return;

  const activeId = match[1];
  const remainingIds = browserTabs.map(t => t.id);
  if (remainingIds.includes(activeId)) return;

  if (remainingIds.length === 0) {
    const fresh = createTab('about:blank', { mode: 'chat' });
    router.replace(`/Browser/${ fresh.id }`);

    return;
  }

  const nextId = selectTabAfterRemoval(previousOrder, activeId, remainingIds) ?? remainingIds[0];
  router.replace(`/Browser/${ nextId }`);
});

// ── Global ModeRail wiring ──
// The rail lives here (outside the per-tab BrowserTab) so it stays
// visible across every mode and tab. We derive the highlighted icon
// from the active tab's mode, and broadcast clicks as a window event
// the active BrowserTab listens for.
const activeTabMode = computed(() => {
  const match = route.path.match(/^\/Browser\/(.+)$/);
  if (!match) return undefined;
  const active = browserTabs.find(t => t.id === match[1]);

  return active?.mode === 'secretary' ? 'conversations' : active?.mode;
});
const conversationShellPolicy = new ConversationShellPolicy();

// Which ModeRail icon a Workflows / Use Cases tab lights up, from the
// Studio sidebar page it is showing.
const activeSubTab = computed(() => {
  const match = route.path.match(/^\/Browser\/(.+)$/);
  const active = match ? browserTabs.find(t => t.id === match[1]) : undefined;
  if (active?.mode !== 'routines' && active?.mode !== 'marketplace') return undefined;

  return railSubTabFor(active.studioSection ?? (active.mode === 'routines' ? 'workflows' : 'browse'));
});

interface RecipeRailApp {
  slug: string; label: string; icon: string; url: string;
  level: 'ok' | 'warn' | 'bad' | 'unknown'; summary: string;
}
interface ExtensionRailItem { extensionId:string; id:string; label:string; icon?:string; component:string; tooltip?:string }
const railExtensions = ref<ExtensionRailItem[]>([]);
async function refreshRailExtensions(){
  const [items, permissions] = await Promise.all([ipcRenderer.invoke('extensions-ui:list','sidebar_entry'), ipcRenderer.invoke('extension-permissions:list')]);
  const rows = permissions ?? []; // null while the database is starting; reloads on database:available
  const hidden = new Set(rows.filter(item=>item.hiddenFromRail).map(item=>item.extensionId));
  const extensionNames = Object.fromEntries(rows.map(item=>[item.extensionId,item.name]));
  railExtensions.value = items.filter(item=>!hidden.has(item.extensionId)).map(item=>({...item,tooltip:`${item.label} · ${extensionNames[item.extensionId]||item.extensionId}`}));
}
// Permissions come back empty while the database is starting; reload when it is up.
function onDatabaseAvailable(){ void refreshRailExtensions().catch(err => console.warn('[AgentRouter] extension rail load failed:', err)); }
function openExtension(item:ExtensionRailItem){ window.dispatchEvent(new CustomEvent('sulla:open-extension-ui',{detail:item})); }
function openExtensionPermissions(){ openSingleTab('preferences','extensions'); }
async function removeExtensionFromRail(item:ExtensionRailItem){
  await ipcRenderer.invoke('extension-permissions:set-rail-hidden',{extensionId:item.extensionId,hidden:true});
  railExtensions.value=railExtensions.value.filter(candidate=>candidate.extensionId!==item.extensionId);
}

const railApps = ref<RecipeRailApp[]>([]);

function setRailApps(_event: unknown, next: RecipeRailApp[]) {
  if (Array.isArray(next)) railApps.value = next;
}

function openRailApp(slug: string) {
  const app = railApps.value.find(candidate => candidate.slug === slug);
  if (!app) return;
  const existing = browserTabs.find(tab => tab.recipeAppSlug === slug);
  const tab = existing ?? createTab(app.url, { mode: 'browser', title: app.label, recipeAppSlug: slug });
  if (existing && existing.url !== app.url) {
    updateTab(existing.id, { url: app.url, title: app.label });
    window.dispatchEvent(new CustomEvent('sulla:tab-navigate', { detail: { tabId: existing.id, url: app.url } }));
  }

  router.push(`/Browser/${ tab.id }`);
}

// ── Bookmarks pane ──
const BOOKMARKS_OPEN_KEY = 'sulla:bookmarks-pane-open';
const bookmarksOpen = ref(localStorage.getItem(BOOKMARKS_OPEN_KEY) === '1');
const shellOverlayVisible = computed(() => vaultUnlockVisible.value || startupOverlayVisible.value || bookmarksOpen.value || !!permissionPrompt.value || modeRailOverlayOpen.value || noAiBannerVisible.value);
watch(shellOverlayVisible, (visible) => {
  const id = /^\/Browser\/(.+)$/.exec(route.path)?.[1];
  if (!id || !internalTabRoute(id)) return;
  void ipcRenderer.invoke('internal-tab-view:visible' as any, id, !visible).catch(() => undefined);
}, { immediate: true });

const bookmarkRevealId = ref<string | null>(null);
const chatFilesOpen = ref(false);

watch(bookmarksOpen, (open) => {
  try {
    localStorage.setItem(BOOKMARKS_OPEN_KEY, open ? '1' : '0');
  } catch { /* best-effort */ }
});

const activeTabInfo = computed(() => {
  const match = /^\/Browser\/(.+)$/.exec(route.path);
  const tab = match ? browserTabs.find(t => t.id === match[1]) : undefined;

  return tab ? { id: tab.id, url: tab.url, title: tab.title, mode: tab.mode } : undefined;
});

function toggleBookmarks(open = !bookmarksOpen.value) {
  bookmarksOpen.value = open;
}

function toggleChatFiles():void {
  window.dispatchEvent(new CustomEvent('sulla:toggle-chat-files'));
}

function onChatFilesStateChanged(event:Event):void {
  const open = (event as CustomEvent<{ open?:boolean }>).detail?.open;
  if (typeof open === 'boolean') chatFilesOpen.value = open;
}

// The browser toolbar star opens the pane on the bookmark it just saved.
function onRevealBookmark(event: Event) {
  const id = (event as CustomEvent<{ id: string }>).detail?.id;
  if (!id) return;
  bookmarkRevealId.value = null;
  bookmarksOpen.value = true;
  nextTick(() => {
    bookmarkRevealId.value = id;
  });
}

function onBookmarksShortcut(event: KeyboardEvent) {
  if ((event.metaKey || event.ctrlKey) && event.shiftKey && (event.key === 'b' || event.key === 'B')) {
    event.preventDefault();
    toggleBookmarks();
  }
}

/** Lets banners elsewhere in the window open a mode tab, e.g. the Password Vault to unlock it. */
function onOpenMode(event: CustomEvent<{ mode?: string }>) {
  if (event.detail?.mode === 'vault') onModeRailSelect('vault');
}

function onConversationsExit(): void {
  const back = (router.options.history.state as { back?: string | null }).back;
  conversationShellPolicy.exit(typeof back === 'string' && !!back, () => router.back(), () => onModeRailSelect('chat'));
}

function onModeRailSelect(mode: string, subTab?: string) {
  // Always spawn a new tab for the clicked mode instead of mutating the
  // active one — rail clicks should behave like "open a new <mode> tab".
  const url = mode === 'browser' ? 'https://www.google.com' : 'about:blank';
  const studioSection = isStudioSection(subTab) ? subTab : undefined;
  const tab = createTab(url, { mode: (mode === 'secretary' ? 'conversations' : mode) as any, studioSection });

  router.push(`/Browser/${ tab.id }`);
}

function onRoute(_event: any, args: any) {
  if (args?.path) {
    router.push(args.path);
  }
}

// Preferences and Docker each get one tab. Opening one again focuses it and
// moves it to the requested section.
function openSingleTab(mode: 'preferences' | 'docker', section?: unknown) {
  const target = typeof section === 'string' && section ? section : undefined;
  const existing = browserTabs.find(t => t.mode === mode);
  const tab = existing ?? createTab('about:blank', { mode, section: target });

  if (existing && target) updateTab(existing.id, { section: target });
  router.push(`/Browser/${ tab.id }`);
}

function onAgentCommand(_event: any, args: any) {
  if (!args?.command) return;

  switch (args.command) {
  case 'find-chat': {
    // Menu bar Find Chat (⌘P): the visible chat tab toggles its find palette.
    window.dispatchEvent(new CustomEvent('sulla:find-chat'));
    break;
  }
  case 'open-agent-chat-tab': {
    const threadId = typeof args.threadId === 'string' ? args.threadId.trim() : '';
    const agentId = typeof args.agentId === 'string' ? args.agentId.trim() : '';
    const contractId = typeof args.contractId === 'string' ? args.contractId.trim() : '';
    if (!threadId || !agentId || !contractId) break;

    const existing = browserTabs.find(t => t.mode === 'chat' && t.agentChat?.contractId === contractId);
    const tab = existing ?? createTab('about:blank', {
      mode: 'chat',
      title: typeof args.title === 'string' && args.title.trim() ? args.title.trim() : (args.agentName || agentId),
      agentChat: {
        threadId,
        agentId,
        agentName: String(args.agentName || agentId),
        parentThreadId: String(args.parentThreadId || ''),
        parentAgentId: String(args.parentAgentId || ''),
        parentAgentName: String(args.parentAgentName || args.parentAgentId || 'parent agent'),
        contractId,
        depth: Number(args.depth || 1),
      },
    });

    localStorage.setItem(`chat_threadId_sulla-desktop_${ tab.id }`, threadId);
    if (args.focus === true) router.push(`/Browser/${ tab.id }`);
    break;
  }
  case 'vault-integration-saved': {
    // The vault saved a new integration account; the visible tab confirms it and opens its edit screen.
    window.dispatchEvent(new CustomEvent('sulla:vault-integration-saved', {
      detail: { integrationId: String(args.integrationId || ''), accountId: String(args.accountId || '') },
    }));
    break;
  }
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
    const tab = createTab('about:blank', { mode: 'conversations' });

    router.push(`/Browser/${ tab.id }`);
    // Show Secretary inside Conversations, but don't start listening.
    setTimeout(() => window.dispatchEvent(new CustomEvent('sulla:open-conversations-secretary', { detail: { tabId: tab.id, start: false } })), 80);
    break;
  }
  case 'start-secretary': {
    // Focus an existing secretary tab if we have one; otherwise open a
    // fresh one. Either way, fire a window event after the tab has
    // mounted so SecretaryMode.vue's listener can trigger startSession()
    // without the user clicking START. See agent/tools/secretary/start.ts.
    const existing = browserTabs.find(t => t.mode === 'conversations' || t.mode === 'secretary');
    const targetTab = existing ?? createTab('about:blank', { mode: 'conversations' });

    router.push(`/Browser/${ targetTab.id }`);
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent('sulla:open-conversations-secretary', {
        detail: { tabId: targetTab.id, start: true },
      }));
    }, existing ? 0 : 80);
    break;
  }
  case 'stop-secretary': {
    // Fire-and-forget — the active SecretaryMode component listens and
    // calls its own endSession(). If no session is active, the event is
    // a no-op.
    window.dispatchEvent(new CustomEvent('sulla:secretary-stop'));
    break;
  }
  case 'open-tab': {
    // `packages` is the user-facing name of the `marketplace` view.
    const requestedMode = args.mode === 'packages' ? 'marketplace' : args.mode;
    const mode = requestedMode === 'secretary' ? 'conversations' : requestedMode;
    // My Account moved into Preferences › Account & Cloud.
    if (mode === 'account') {
      openSingleTab('preferences', 'account');
      break;
    }
    if (mode === 'capture-studio') {
      const existing = browserTabs.find(tab => tab.mode === 'capture-studio');
      const target = existing ?? createTab('about:blank', { mode: 'capture-studio' });
      router.push(`/Browser/${ target.id }`);
      break;
    }
    if (mode === 'preferences' || mode === 'docker') {
      openSingleTab(mode, args.section);
      break;
    }
    if (mode === 'files' && args.fileId && args.path && supportsDocumentEditor(args.path)) {
      openDocumentTab({ fileId: args.fileId, path: args.path, collectionId: args.collectionId });
      break;
    }
    const filesNavigation = mode === 'files' && (args.fileId || args.path || args.section)
      ? { fileId: args.fileId, path: args.path, section: args.section, collectionId: args.collectionId }
      : undefined;
    const studioSection = isStudioSection(args.studioSection) ? args.studioSection : undefined;
    const tab = createTab('about:blank', { mode: mode || 'welcome', filesNavigation, studioSection });

    router.push(`/Browser/${ tab.id }`);
    if (requestedMode === 'secretary') setTimeout(() => window.dispatchEvent(new CustomEvent('sulla:open-conversations-secretary', { detail: { tabId: tab.id, start: false } })), 80);
    break;
  }
  case 'open-files-item': {
    const reply = (value:Record<string, unknown>) => ipcRenderer.send(`agent-command-result:${ args.requestId }` as any, value);
    if (!args.requestId || !args.path || (args.kind !== 'folder' && !args.fileId)) {
      reply({ error: 'The resolved Files item is incomplete.' });
      break;
    }
    if (args.kind === 'file' && args.mode !== 'view' && supportsDocumentEditor(args.path)) {
      const tab = openDocumentTab({ fileId: args.fileId, path: args.path, collectionId: args.collectionId }, args.focus !== false);
      reply({ opened: true, tabId: tab.id, path: args.path, how: 'document-editor' });
      break;
    }
    // File Manager owns viewer selection for every other type. Feeding its
    // normal navigation input reaches the same navigateTo -> selectEntry/openPath
    // path used by a click and keeps viewer behavior in one place.
    const filesNavigation = args.kind === 'folder'
      ? { path: args.path, collectionId: args.collectionId, openRequestId: args.requestId, openKind: 'folder' as const }
      : { fileId: args.fileId, path: args.path, collectionId: args.collectionId, openRequestId: args.requestId, openKind: 'file' as const };
    const existing = browserTabs.find(tab => tab.mode === 'files');
    const tab = existing ?? createTab('about:blank', { mode: 'files', title: 'File Manager', filesNavigation });
    if (existing) updateTab(existing.id, { filesNavigation });
    if (args.focus !== false) router.push(`/Browser/${ tab.id }`);
    break;
  }
  case 'open-url': {
    const url = args.url || 'about:blank';
    const tab = createTab(url);

    router.push(`/Browser/${ tab.id }`);
    break;
  }
  case 'support:open-session': {
    const sessionId = args.sessionId;
    if (!sessionId) break;
    const existing = browserTabs.find(t => t.mode === 'support-session' && t.supportSession?.sessionId === sessionId);
    const targetTab = existing ?? createTab('about:blank', { mode: 'support-session', title: 'Support session', supportSession: { sessionId } });
    router.push(`/Browser/${ targetTab.id }`);
    break;
  }
  case 'marketplace:open-detail': {
    // Fired by the main-process deep-link handler when the user clicks
    // "Open in Sulla Desktop" on sulladesktop.com (sulla://marketplace/
    // install?id=<id>). Focus an existing marketplace tab if we have
    // one; otherwise spin up a fresh one. Either way, broadcast a
    // window event so the mounted MarketplaceTab can auto-load the
    // detail view for the requested template.
    const templateId = args.templateId;
    if (!templateId) break;

    const existing = browserTabs.find(t => t.mode === 'marketplace');
    const targetTab = existing ?? createTab('about:blank', { mode: 'marketplace' });

    router.push(`/Browser/${ targetTab.id }`);

    // MarketplaceTab listens for this; we fire after a tick so the
    // component has a chance to mount on a fresh tab.
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent('sulla:marketplace-open-detail', {
        detail: { id: templateId },
      }));
    }, 50);
    break;
  }
  case 'routines:import': {
    // Fire IPC. On success the routines tab scanner picks up the new
    // folder on its next refresh — we open the tab to trigger that.
    (ipcRenderer.invoke as any)('routines-import').then((result: any) => {
      if (result?.canceled) return;
      if (result?.error) {
        console.warn('[Routines] Import failed:', result.error);
        window.alert(`Import failed: ${ result.error }`);

        return;
      }
      // Surface the new template by switching to the routines tab.
      const tab = createTab('about:blank', { mode: 'routines' } as any);

      router.push(`/Browser/${ tab.id }`);
    }).catch((err: unknown) => {
      console.error('[Routines] Import IPC error:', err);
      window.alert(`Import failed: ${ err instanceof Error ? err.message : String(err) }`);
    });
    break;
  }
  case 'routines:export': {
    const id = args.id;
    if (!id) break;
    (ipcRenderer.invoke as any)('routines-export', id).then((result: any) => {
      if (result?.error) {
        console.warn('[Routines] Export failed:', result.error);
        window.alert(`Export failed: ${ result.error }`);
      }
    }).catch((err: unknown) => {
      console.error('[Routines] Export IPC error:', err);
      window.alert(`Export failed: ${ err instanceof Error ? err.message : String(err) }`);
    });
    break;
  }
  case 'routines:export-template': {
    const slug = args.slug;
    if (!slug) break;
    (ipcRenderer.invoke as any)('routines-export-template', slug).then((result: any) => {
      if (result?.error) {
        console.warn('[Routines] Template export failed:', result.error);
        window.alert(`Export failed: ${ result.error }`);
      }
    }).catch((err: unknown) => {
      console.error('[Routines] Template export IPC error:', err);
      window.alert(`Export failed: ${ err instanceof Error ? err.message : String(err) }`);
    });
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

function onNavigateTab(ev: Event) {
  const tabId = (ev as CustomEvent<{ tabId: string }>).detail?.tabId;
  if (tabId) router.push(`/Browser/${ tabId }`);
}

function onNavigateAgentParent(ev: Event) {
  const parentThreadId = (ev as CustomEvent<{ parentThreadId: string }>).detail?.parentThreadId;
  if (!parentThreadId) return;
  const parent = browserTabs.find(tab =>
    tab.mode === 'chat' && localStorage.getItem(`chat_threadId_sulla-desktop_${ tab.id }`) === parentThreadId,
  );
  if (parent) router.push(`/Browser/${ parent.id }`);
}

function onHistoryNavigate(_event: any, ...args: any[]) {
  const entry = args[0] as { id: string; type: string; url?: string; title?: string; tab_id?: string; thread_id?: string };
  if (!entry) return;
  if (entry.type === 'browser' && entry.url && entry.url !== 'about:blank') {
    const tab = createTab(entry.url);

    router.push(`/Browser/${ tab.id }`);
  } else {
    // Reopen the conversation in its original tab — a fresh tab has no
    // thread and always rendered a blank new chat.
    const tab = restoreChatFromHistory(entry);

    router.push(`/Browser/${ tab.id }`);
  }
}

const presenceTracker = getHumanPresenceTracker();


onMounted(async() => {
  window.addEventListener('sulla:chrome-ready', onChromeReady, { once: true });
  ipcRenderer.on('app:shutting-down' as any, onAppShuttingDown as any);
  ipcRenderer.on('internal-tab-view:crashed' as any, onInternalTabCrashed as any);
  ipcRenderer.on('internal-tab-view:updated' as any, onInternalTabUpdated as any);
  ipcRenderer.on('internal-tab-view:loaded' as any, onInternalTabLoaded as any);
  window.addEventListener('resize', onInternalTabsWindowResize);
  ipcRenderer.on('extension-permission-needed', onPermissionNeeded);
  ipcRenderer.on('database:available', onDatabaseAvailable);
  void refreshRailExtensions().catch(err => console.warn('[AgentRouter] extension rail load failed:', err));
  ipcRenderer.on('recipe-rail-apps-changed' as any, setRailApps);
  ipcRenderer.invoke('recipe-rail-apps' as any).then(next => setRailApps(undefined, next as RecipeRailApp[])).catch(() => undefined);

  // Register sub-tab change listener
  window.addEventListener('sulla:navigate-tab', onNavigateTab as EventListener);
  window.addEventListener('sulla:open-mode', onOpenMode as EventListener);
  window.addEventListener('sulla:conversations-exit', onConversationsExit);
  window.addEventListener('sulla:navigate-agent-parent', onNavigateAgentParent as EventListener);
  window.addEventListener('sulla:bookmarks-reveal', onRevealBookmark as EventListener);
  window.addEventListener('sulla:chat-files-state-changed', onChatFilesStateChanged as EventListener);
  window.addEventListener('keydown', onBookmarksShortcut);

  // Ensure at least one tab exists, then navigate to the last-active tab from
  // the previous session if it's still in the restored list, falling back to
  // tabs[0] if the persisted ID no longer exists.
  ensureOneTab();
  if (!route.path.startsWith('/Browser/')) {
    const persistedId = getPersistedActiveTabId();
    const target = (persistedId && browserTabs.find(t => t.id === persistedId)) || browserTabs[0];
    if (target) router.replace(`/Browser/${ target.id }`);
  }

  // Start human presence tracker — top-level shell ensures presence is tracked
  // whenever the app is open, regardless of which tab/pane is active
  presenceTracker.setCurrentView('Sulla Desktop');
  presenceTracker.setActiveChannel('sulla-desktop');
  presenceTracker.start();

  ipcRenderer.on('route' as any, onRoute);
  ipcRenderer.on('agent-command' as any, onAgentCommand);
  ipcRenderer.on('internal-tab-view:open-workspace-tab', onWorkspaceTabRequested);
  ipcRenderer.on('conversation-history:show-all' as any, onHistoryShowAll);
  ipcRenderer.on('conversation-history:restore-last-closed' as any, onHistoryRestoreLastClosed);
  ipcRenderer.on('conversation-history:navigate' as any, onHistoryNavigate);
  // vault:logged-in / vault:logged-out are handled globally in useVaultUnlock composable
});

onUnmounted(() => {
  window.removeEventListener('sulla:chrome-ready', onChromeReady);
  ipcRenderer.removeListener('app:shutting-down' as any, onAppShuttingDown as any);
  window.removeEventListener('sulla:no-ai-banner', onNoAiBannerChange);
  ipcRenderer.removeListener('internal-tab-view:crashed' as any, onInternalTabCrashed as any);
  ipcRenderer.removeListener('internal-tab-view:updated' as any, onInternalTabUpdated as any);
  ipcRenderer.removeListener('internal-tab-view:loaded' as any, onInternalTabLoaded as any);
  window.removeEventListener('resize', onInternalTabsWindowResize);
  ipcRenderer.removeListener('extension-permission-needed', onPermissionNeeded);
  ipcRenderer.removeListener('database:available', onDatabaseAvailable);
  ipcRenderer.removeListener('recipe-rail-apps-changed' as any, setRailApps);
  presenceTracker.stop();
  window.removeEventListener('sulla:navigate-tab', onNavigateTab as EventListener);
  window.removeEventListener('sulla:open-mode', onOpenMode as EventListener);
  window.removeEventListener('sulla:conversations-exit', onConversationsExit);
  window.removeEventListener('sulla:navigate-agent-parent', onNavigateAgentParent as EventListener);
  window.removeEventListener('sulla:bookmarks-reveal', onRevealBookmark as EventListener);
  window.removeEventListener('sulla:chat-files-state-changed', onChatFilesStateChanged as EventListener);
  window.removeEventListener('keydown', onBookmarksShortcut);
  ipcRenderer.removeListener('route' as any, onRoute);
  ipcRenderer.removeListener('agent-command' as any, onAgentCommand);
  ipcRenderer.removeListener('internal-tab-view:open-workspace-tab', onWorkspaceTabRequested);
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
  /* The window's uncovered traffic-light corner is part of the titlebar chrome. */
  background: var(--bg-surface-alt);
}

/*
 * Body = horizontal row: global rail on the left, content area on the
 * right. The body fills the window height, with the rail starting below
 * the native titlebar when present.
 */
.agent-router-body {
  --rail-width: 64px;
  display: flex;
  flex-direction: row;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.agent-router-body.conversations-fullscreen { --rail-width: 0px; }
.agent-router-body.conversations-fullscreen.has-titlebar::before { display: none; }

.agent-router-body:has(.agent-router-rail.expanded) {
  --rail-width: 212px;
}

.agent-router-rail {
  flex-shrink: 0;
}

.agent-router-body.has-titlebar .agent-router-rail {
  margin-top: 44px;
  height: calc(100% - 44px);
}

/* Carry the titlebar's bottom line under the traffic-light corner so it runs
   the full window width, as in the approved header design. */
.agent-router-body.has-titlebar {
  position: relative;
}
.agent-router-body.has-titlebar::before {
  content: '';
  position: absolute;
  top: 43px;
  left: 0;
  width: var(--rail-width);
  height: 1px;
  background: var(--border-default);
  z-index: 1;
  pointer-events: none;
  transition: width var(--dur-move) var(--spring);
}

.agent-router-content {
  position: relative;
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: visible;
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

.internal-shell-header {
  position: relative;
  z-index: 3;
}
/* Match the 44px AgentHeader titlebar; 56px left a visible 12px strip. */
.internal-browser-tab-layer {
  top: 44px;
}

.internal-tab-reload {
  position: absolute;
  inset: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  background: var(--bg-surface);
}

.browser-tab-hidden {
  visibility: hidden;
  pointer-events: none;
  z-index: 0;
}

/*
 * visibility:hidden (unlike display:none) does not stop CSS animations, so
 * every parked tab kept ticking its spinners, pulses and backdrop glows on
 * every frame. Freeze them until the tab is shown again; they resume where
 * they stopped. Vue <Transition> has its own timeout fallback, so a leave
 * transition in a hidden tab still completes.
 */
.browser-tab-hidden,
.browser-tab-hidden :deep(*),
.browser-tab-hidden :deep(*::before),
.browser-tab-hidden :deep(*::after) {
  animation-play-state: paused !important;
}
</style>

<style scoped>
.extension-permission-prompt{position:fixed;z-index:9500;right:24px;bottom:44px;width:390px;padding:17px 19px;background:var(--bg-surface);border:1px solid var(--accent-border);border-radius:12px;box-shadow:0 18px 55px rgba(0,0,0,.45)}.extension-permission-prompt .prompt-kicker{text-transform:uppercase;letter-spacing:.13em;font-size:10px;color:var(--accent);margin-bottom:8px}.extension-permission-prompt p{color:var(--text-muted);font-size:13px;line-height:1.45}.extension-permission-prompt code{display:block;color:var(--text-dim);margin:8px 0 14px}.extension-permission-prompt>div:last-child{display:flex;justify-content:flex-end;gap:8px}.extension-permission-prompt button{border:1px solid var(--border-default);border-radius:7px;background:transparent;color:var(--text-primary);padding:7px 12px}.extension-permission-prompt button.allow{background:var(--accent);color:white;border-color:var(--accent)}
</style>
