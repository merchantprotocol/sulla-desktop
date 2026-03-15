import { reactive, readonly } from 'vue';

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

const tabs = reactive<BrowserTab[]>([]);
let nextId = 1;

function generateId(): string {
  return `browser-${ nextId++ }`;
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

  function closeTab(id: string) {
    const idx = tabs.findIndex(t => t.id === id);

    if (idx !== -1) {
      tabs.splice(idx, 1);
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
  };
}
