import { reactive, readonly } from 'vue';

export interface BrowserTab {
  id:       string;
  url:      string;
  title:    string;
  favicon:  string;
  loading:  boolean;
}

const tabs = reactive<BrowserTab[]>([]);
let nextId = 1;

function generateId(): string {
  return `browser-${ nextId++ }`;
}

export function useBrowserTabs() {
  function createTab(url = 'about:blank'): BrowserTab {
    const tab: BrowserTab = {
      id:      generateId(),
      url,
      title:   'New Tab',
      favicon: '',
      loading: false,
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
