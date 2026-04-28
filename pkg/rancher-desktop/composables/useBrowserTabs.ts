import { reactive, readonly, ref, watch } from 'vue';

import { ipcRenderer } from '@pkg/utils/ipcRenderer';

export type BrowserTabMode = 'welcome' | 'browser' | 'chat' | 'calendar' | 'integrations' | 'document' | 'secretary' | 'vault' | 'account' | 'history' | 'routines' | 'marketplace' | 'labs';

export interface BrowserTab {
  id:       string;
  url:      string;
  title:    string;
  favicon:  string;
  loading:  boolean;
  mode:     BrowserTabMode;
  assetId?: string;
  /** Raw HTML content for document-mode tabs (rendered in Shadow DOM) */
  content?: string;
  /**
   * Last time something touched this tab (create, updateTab, URL/title/content
   * change from backend). Used for idle-close of agent tabs. Only populated
   * on tabs created after this field was added.
   */
  lastAccessedAt?: number;
}

export interface ClosedTab {
  id:       string;
  url:      string;
  title:    string;
  favicon:  string;
  mode:     BrowserTabMode;
  closedAt: number;
}

const STORAGE_KEY = 'sulla:browser-tabs';
const HISTORY_KEY = 'sulla:closed-tabs';
const ORDER_KEY = 'sulla:tab-order';
const MAX_HISTORY = 25;
// Cap the restored-tab count to stop a runaway agent from creating hundreds
// of tabs, persisting them, and blacking out the main chat window on next
// launch (each restored tab spawns a WebContentsView and loads its page —
// hundreds of concurrent page loads saturate the event loop). Dedupe on
// load too — if an upsert loop snuck past the backend dedupe, we still
// collapse same-URL+same-mode entries here.
const MAX_RESTORED_TABS = 20;

function loadPersistedTabs(): BrowserTab[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Dedupe by (url + mode) so a runaway "open same URL 500 times" loop
    // collapses to a single entry on restore.
    const seen = new Set<string>();
    const deduped: any[] = [];
    for (const t of parsed) {
      const key = `${ t?.mode || '' }|${ t?.url || '' }`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(t);
    }
    // Keep only the most recent MAX_RESTORED_TABS entries (from the end).
    const capped = deduped.length > MAX_RESTORED_TABS
      ? deduped.slice(deduped.length - MAX_RESTORED_TABS)
      : deduped;
    if (capped.length < parsed.length) {
      console.warn(`[useBrowserTabs] Restored ${ capped.length } tab(s) after dedupe+cap (was ${ parsed.length } in storage)`);
    }
    // Rehydrate: reset loading state
    return capped.map((t: any) => ({ ...t, loading: false }));
  } catch {
    return [];
  }
}

function persistTabs(tabList: BrowserTab[]): void {
  try {
    // Agent-origin tabs (created by the `browser/tab` tool — they carry an
    // `assetId`) are ephemeral. They should not survive app restart: the
    // agent can always reopen what it needs on the next run, and persisting
    // them is exactly how we end up restoring hundreds of WebContentsViews
    // and blacking out the main chat window. Only user-initiated tabs
    // (no assetId) persist.
    const userTabs = tabList.filter(t => !t.assetId);
    // Strip large HTML content + enforce the cap on write too, so a live
    // runaway can't balloon localStorage between app launches.
    const capped = userTabs.length > MAX_RESTORED_TABS
      ? userTabs.slice(userTabs.length - MAX_RESTORED_TABS)
      : userTabs;
    const toStore = capped.map((t) => {
      if (t.content && t.content.length > 50_000) {
        return { ...t, content: undefined };
      }
      return t;
    });
    localStorage.setItem(STORAGE_KEY, JSON.stringify(toStore));
  } catch { /* best-effort */ }
}

// Hard cap on concurrent agent-origin tabs (those with assetId). When an
// agent opens many distinct URLs in one session we keep the 10 most-recent
// and evict the oldest so RAM stays bounded regardless of how busy the agent
// gets. User-opened tabs (no assetId) are never evicted by this.
const MAX_AGENT_TABS = 10;

// Idle-close timeout for agent-origin tabs. Tabs that haven't been touched
// (created, updated, navigated) in this long get auto-closed. User tabs are
// never touched by this timer. Check runs every CHECK_INTERVAL_MS.
const AGENT_TAB_IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const AGENT_TAB_CHECK_INTERVAL_MS = 60 * 1000;    // 1 minute

const restoredTabs = loadPersistedTabs();
const tabs = reactive<BrowserTab[]>(restoredTabs);

// Enforce the agent-tab cap. Called synchronously from the write paths that
// can push the count over the limit (createTab + updateTab with a new
// assetId). Previously this ran as a `watch(tabs, deep: true)`, but because
// it mutates the same array it watches, any other deep write on tabs
// (e.g. lastAccessedAt updates from state-update IPC) re-triggered the
// watcher and a feedback loop could spin the renderer. Inline is
// deterministic and non-reactive — no self-triggering possible.
function enforceAgentTabCap(): void {
  const agentIndexes: number[] = [];
  for (let i = 0; i < tabs.length; i++) {
    if (tabs[i].assetId) agentIndexes.push(i);
  }
  const overflow = agentIndexes.length - MAX_AGENT_TABS;
  if (overflow <= 0) return;
  // Splice in reverse so earlier indexes stay valid as we remove.
  const toRemove = agentIndexes.slice(0, overflow).reverse();
  for (const idx of toRemove) tabs.splice(idx, 1);
  console.warn(`[useBrowserTabs] Evicted ${ overflow } agent tab(s) over cap (${ MAX_AGENT_TABS })`);
}

// Run once on startup in case persisted state had >MAX_AGENT_TABS agent tabs.
enforceAgentTabCap();

// Persist tab state on every change (user-origin tabs only — see persistTabs)
watch(tabs, (current) => {
  persistTabs([...current]);
}, { deep: true });

// ── Main-process tab mirror ─────────────────────────────────────────
// Main owns the list of agent-opened tabs (TabRegistry). When it changes,
// ensure each one has a matching local tab so the UI can render chrome for
// it. User-opened tabs continue to live entirely in this composable.
//
// We do NOT push local changes back up — main is the authority for
// agent tabs. This one-way flow replaces the previous bidirectional
// activeAssets ↔ tabs sync that deadlocked the renderer.
interface MainTabRecord {
  assetId: string;
  title:   string;
  url:     string;
  origin:  'user' | 'agent';
}

function mirrorMainTabs(mainTabs: MainTabRecord[]): void {
  const mainByAsset = new Map(mainTabs.filter(t => t.origin === 'agent').map(t => [t.assetId, t]));

  // Remove local agent tabs that no longer exist in main.
  for (let i = tabs.length - 1; i >= 0; i--) {
    const tab = tabs[i];
    if (tab.assetId && !mainByAsset.has(tab.assetId)) {
      tabs.splice(i, 1);
    }
  }

  // Add / update local tabs for each main agent tab.
  for (const mt of mainByAsset.values()) {
    const existing = tabs.find(t => t.assetId === mt.assetId);
    if (existing) {
      existing.title = mt.title;
      existing.url = mt.url;
    } else {
      tabs.push({
        id:             mt.assetId,
        url:            mt.url,
        title:          mt.title,
        favicon:        '',
        loading:        false,
        mode:           'browser',
        assetId:        mt.assetId,
        lastAccessedAt: Date.now(),
      });
    }
  }
}

try {
  (ipcRenderer as any).invoke('tabs:list').then((initial: MainTabRecord[]) => {
    if (Array.isArray(initial)) mirrorMainTabs(initial);
  }).catch(() => {});

  (ipcRenderer as any).on('tabs:change', (_e: unknown, mainTabs: MainTabRecord[]) => {
    mirrorMainTabs(mainTabs);
  });
} catch {
  // Non-Electron context (tests) — skip.
}

// ── Closed-tab history ──

function loadClosedTabs(): ClosedTab[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch {
    return [];
  }
}

function persistClosedTabs(list: ClosedTab[]): void {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, MAX_HISTORY)));
  } catch { /* best-effort */ }
}

const closedTabs = reactive<ClosedTab[]>(loadClosedTabs());

watch(closedTabs, (current) => {
  persistClosedTabs([...current]);
}, { deep: true });

// ── Tab order persistence ──

function loadTabOrder(): string[] {
  try {
    const raw = localStorage.getItem(ORDER_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persistTabOrder(order: string[]): void {
  try {
    localStorage.setItem(ORDER_KEY, JSON.stringify(order));
  } catch { /* best-effort */ }
}

const tabOrder = ref<string[]>(loadTabOrder());

watch(tabOrder, (current) => {
  persistTabOrder([...current]);
}, { deep: true });

function generateId(): string {
  return `tab_${ Date.now().toString(36) }_${ Math.random().toString(36).slice(2, 8) }`;
}

// ── Conversation history IPC helpers ──

function recordTabToHistory(tab: BrowserTab): void {
  try {
    const historyType = tab.mode === 'chat' ? 'chat' : 'browser';

    // Skip welcome/blank tabs that aren't chat
    if (tab.mode === 'welcome' || (tab.url === 'about:blank' && tab.mode !== 'chat')) return;

    ipcRenderer.send('conversation-history:record', {
      id:      tab.id,
      type:    historyType,
      title:   tab.title,
      url:     tab.url,
      favicon: tab.favicon,
      tab_id:  tab.id,
      status:  'active',
    });
  } catch {
    // IPC may not be available in non-Electron contexts
  }
}

function closeTabInHistory(tabId: string): void {
  try {
    ipcRenderer.send('conversation-history:close', tabId);
  } catch {
    // Best-effort
  }
}

export function useBrowserTabs() {
  const MODE_TITLES: Record<BrowserTabMode, string> = {
    welcome:      'New Tab',
    browser:      'New Tab',
    chat:         'New Chat',
    calendar:     'Calendar',
    integrations: 'Integrations',
    document:     'Document',
    secretary:    'Secretary',
    vault:        'Password Manager',
    account:      'My Account',
    history:      'History',
    routines:     'Routines',
    marketplace:  'Sulla Studio',
    labs:         'Labs',
  };

  function createTab(url = 'about:blank', opts?: { mode?: BrowserTabMode }): BrowserTab {
    const mode: BrowserTabMode = opts?.mode ?? (url === 'about:blank' ? 'welcome' : 'browser');
    const tab: BrowserTab = {
      id:             generateId(),
      url,
      title:          MODE_TITLES[mode] || 'New Tab',
      favicon:        '',
      loading:        false,
      mode,
      lastAccessedAt: Date.now(),
    };

    tabs.push(tab);

    // Record to conversation history
    recordTabToHistory(tab);

    return tab;
  }

  /**
   * Ensure at least one chat tab exists.
   * Returns the existing or newly created tab.
   */
  function ensureOneTab(): BrowserTab {
    if (tabs.length > 0) {
      return tabs[0];
    }

    return createTab('about:blank', { mode: 'chat' });
  }

  function closeTab(id: string) {
    const idx = tabs.findIndex(t => t.id === id);

    if (idx !== -1) {
      // Record closure in conversation history
      closeTabInHistory(id);
      const removed = tabs[idx];

      // Save to closed-tab history (skip blank/welcome tabs)
      if (removed.url !== 'about:blank' || removed.mode === 'chat') {
        closedTabs.unshift({
          id:       removed.id,
          url:      removed.url,
          title:    removed.title,
          favicon:  removed.favicon,
          mode:     removed.mode,
          closedAt: Date.now(),
        });
        // Trim to max
        if (closedTabs.length > MAX_HISTORY) {
          closedTabs.splice(MAX_HISTORY);
        }
      }

      tabs.splice(idx, 1);
    }

    // Always keep at least one tab open
    if (tabs.length === 0) {
      createTab('about:blank', { mode: 'chat' });
    }
  }

  function restoreClosedTab(index: number): BrowserTab | null {
    if (index < 0 || index >= closedTabs.length) return null;

    const entry = closedTabs[index];
    closedTabs.splice(index, 1);

    // Re-create the tab with its original ID so localStorage-keyed
    // thread state (messages, threadId) is automatically restored.
    const tab: BrowserTab = {
      id:      entry.id,
      url:     entry.url,
      title:   entry.title,
      favicon: entry.favicon,
      loading: false,
      mode:    entry.mode,
    };

    tabs.push(tab);

    return tab;
  }

  function clearClosedTabs() {
    closedTabs.splice(0, closedTabs.length);
  }

  function updateTab(id: string, updates: Partial<Omit<BrowserTab, 'id'>>) {
    const tab = tabs.find(t => t.id === id);

    if (tab) {
      // Track whether this update turns a user tab into an agent tab, so we
      // only run the cap check when it's meaningful.
      const becameAgentTab = !tab.assetId && !!updates.assetId;

      Object.assign(tab, updates);
      tab.lastAccessedAt = Date.now();

      // Re-record when URL or title changes (navigation event)
      if (updates.url || updates.title) {
        recordTabToHistory(tab);
      }

      if (becameAgentTab) enforceAgentTabCap();
    }
  }

  function getTab(id: string): BrowserTab | undefined {
    return tabs.find(t => t.id === id);
  }

  function reorderTabs(fromIndex: number, toIndex: number): void {
    const ids = [...tabOrder.value];
    if (fromIndex < 0 || fromIndex >= ids.length || toIndex < 0 || toIndex >= ids.length) return;
    const [moved] = ids.splice(fromIndex, 1);
    ids.splice(toIndex, 0, moved);
    tabOrder.value = ids;
  }

  return {
    tabs:       readonly(tabs),
    closedTabs: readonly(closedTabs),
    tabOrder,
    createTab,
    closeTab,
    updateTab,
    getTab,
    ensureOneTab,
    restoreClosedTab,
    clearClosedTabs,
    reorderTabs,
  };
}

/**
 * Close a browser tab by its assetId (the bridge/tool identifier).
 * Standalone function (not inside the composable) so it can be called
 * from non-Vue code like HostBridgeIpcRenderer.
 *
 * Returns true if a tab was found and closed.
 */
export function closeTabByAssetId(assetId: string): boolean {
  const tab = tabs.find(t => t.assetId === assetId);
  if (!tab) return false;

  const idx = tabs.findIndex(t => t.id === tab.id);
  if (idx === -1) return false;

  // Record closure in conversation history
  closeTabInHistory(tab.id);

  // Save to closed-tab history
  if (tab.url !== 'about:blank' || tab.mode === 'chat') {
    closedTabs.unshift({
      id:       tab.id,
      url:      tab.url,
      title:    tab.title,
      favicon:  tab.favicon,
      mode:     tab.mode,
      closedAt: Date.now(),
    });
    if (closedTabs.length > MAX_HISTORY) {
      closedTabs.splice(MAX_HISTORY);
    }
  }

  tabs.splice(idx, 1);

  // Always keep at least one tab — create a new chat tab and
  // dispatch a custom event so AgentHeader can navigate the router
  if (tabs.length === 0) {
    const newTab = {
      id:      `tab_${ Date.now().toString(36) }_${ Math.random().toString(36).slice(2, 8) }`,
      url:     'about:blank',
      title:   'New Chat',
      favicon: '',
      loading: false,
      mode:    'chat' as BrowserTabMode,
    };
    tabs.push(newTab);

    // Notify the UI to navigate to the new tab
    try {
      window.dispatchEvent(new CustomEvent('sulla:navigate-tab', { detail: { tabId: newTab.id } }));
    } catch { /* non-browser context */ }
  }

  return true;
}
