import { reactive, readonly, watch } from 'vue';

export type BrowserTabMode = 'welcome' | 'browser' | 'chat' | 'calendar' | 'integrations' | 'extensions' | 'document';

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
const MAX_HISTORY = 25;

function loadPersistedTabs(): BrowserTab[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Rehydrate: reset loading state
    return parsed.map((t: any) => ({ ...t, loading: false }));
  } catch {
    return [];
  }
}

function persistTabs(tabList: BrowserTab[]): void {
  try {
    // Strip large HTML content to avoid blowing localStorage limits
    const toStore = tabList.map((t) => {
      if (t.content && t.content.length > 50_000) {
        return { ...t, content: undefined };
      }
      return t;
    });
    localStorage.setItem(STORAGE_KEY, JSON.stringify(toStore));
  } catch { /* best-effort */ }
}

const restoredTabs = loadPersistedTabs();
const tabs = reactive<BrowserTab[]>(restoredTabs);

// Persist tab state on every change
watch(tabs, (current) => {
  persistTabs([...current]);
}, { deep: true });

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

function generateId(): string {
  return `tab_${ Date.now().toString(36) }_${ Math.random().toString(36).slice(2, 8) }`;
}

export function useBrowserTabs() {
  function createTab(url = 'about:blank', opts?: { mode?: BrowserTabMode }): BrowserTab {
    const mode: BrowserTabMode = opts?.mode ?? (url === 'about:blank' ? 'welcome' : 'browser');
    const tab: BrowserTab = {
      id:      generateId(),
      url,
      title:   mode === 'chat' ? 'New Chat' : 'New Tab',
      favicon: '',
      loading: false,
      mode,
    };

    tabs.push(tab);

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
      Object.assign(tab, updates);
    }
  }

  function getTab(id: string): BrowserTab | undefined {
    return tabs.find(t => t.id === id);
  }

  return {
    tabs:      readonly(tabs),
    closedTabs: readonly(closedTabs),
    createTab,
    closeTab,
    updateTab,
    getTab,
    ensureOneTab,
    restoreClosedTab,
    clearClosedTabs,
  };
}
