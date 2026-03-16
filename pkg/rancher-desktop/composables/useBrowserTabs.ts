import { reactive, readonly, watch } from 'vue';

export type BrowserTabMode = 'welcome' | 'browser' | 'chat' | 'calendar' | 'integrations' | 'extensions';

export interface BrowserTab {
  id:       string;
  url:      string;
  title:    string;
  favicon:  string;
  loading:  boolean;
  mode:     BrowserTabMode;
  assetId?: string;
}

const STORAGE_KEY = 'sulla:browser-tabs';

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
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tabList));
  } catch { /* best-effort */ }
}

const restoredTabs = loadPersistedTabs();
const tabs = reactive<BrowserTab[]>(restoredTabs);

// Persist tab state on every change
watch(tabs, (current) => {
  persistTabs([...current]);
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
      tabs.splice(idx, 1);
    }

    // Always keep at least one tab open
    if (tabs.length === 0) {
      createTab('about:blank', { mode: 'chat' });
    }
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
    createTab,
    closeTab,
    updateTab,
    getTab,
    ensureOneTab,
  };
}
