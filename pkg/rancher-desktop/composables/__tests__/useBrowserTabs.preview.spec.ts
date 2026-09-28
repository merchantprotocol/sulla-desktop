import { afterEach, describe, expect, it, jest } from '@jest/globals';

jest.unstable_mockModule('@pkg/utils/ipcRenderer', () => ({
  ipcRenderer: {
    send:   jest.fn(),
    invoke: jest.fn(() => Promise.resolve([])),
    on:     jest.fn(),
  },
}));

async function load() {
  jest.resetModules();
  localStorage.clear();

  return import('../useBrowserTabs');
}

function captureNavigations() {
  const seen: { tabId: string; url: string }[] = [];
  const listener = (e: Event) => seen.push((e as CustomEvent).detail);
  window.addEventListener('sulla:tab-navigate', listener);

  return { seen, stop: () => window.removeEventListener('sulla:tab-navigate', listener) };
}

describe('useBrowserTabs bookmark preview tab', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('reuses one preview tab while clicking through bookmarks', async() => {
    const { useBrowserTabs } = await load();
    const { tabs, openInPreviewTab, previewTabId } = useBrowserTabs();
    const nav = captureNavigations();

    const first = openInPreviewTab('https://a.test/', 'A');
    const second = openInPreviewTab('https://b.test/', 'B');
    const third = openInPreviewTab('https://c.test/', 'C');
    nav.stop();

    expect(tabs).toHaveLength(1);
    expect(second.id).toBe(first.id);
    expect(third.id).toBe(first.id);
    expect(previewTabId.value).toBe(first.id);
    expect(tabs[0].mode).toBe('browser');
    expect(tabs[0].title).toBe('C');
    expect(tabs[0].url).toBe('https://c.test/');
    // The first bookmark creates the tab with its URL; later ones re-navigate it.
    expect(nav.seen).toEqual([
      { tabId: first.id, url: 'https://b.test/' },
      { tabId: first.id, url: 'https://c.test/' },
    ]);
  });

  it('opens a fresh preview tab once the previous one was interacted with', async() => {
    const { useBrowserTabs } = await load();
    const { tabs, openInPreviewTab, promoteTab, previewTabId } = useBrowserTabs();

    const kept = openInPreviewTab('https://a.test/');
    promoteTab(kept.id);
    expect(previewTabId.value).toBeNull();

    const next = openInPreviewTab('https://b.test/');

    expect(next.id).not.toBe(kept.id);
    expect(tabs).toHaveLength(2);
    expect(tabs.find(t => t.id === kept.id)!.url).toBe('https://a.test/');
    expect(previewTabId.value).toBe(next.id);
  });

  it('promoting some other tab leaves the preview alone', async() => {
    const { useBrowserTabs } = await load();
    const { createTab, openInPreviewTab, promoteTab, previewTabId } = useBrowserTabs();
    const other = createTab('https://other.test/');
    const preview = openInPreviewTab('https://a.test/');

    promoteTab(other.id);

    expect(previewTabId.value).toBe(preview.id);
  });

  it('forgets the preview tab when it is closed', async() => {
    const { useBrowserTabs } = await load();
    const { tabs, createTab, closeTab, openInPreviewTab, previewTabId } = useBrowserTabs();
    createTab('about:blank', { mode: 'chat' });
    const preview = openInPreviewTab('https://a.test/');

    closeTab(preview.id);
    expect(previewTabId.value).toBeNull();

    const next = openInPreviewTab('https://b.test/');
    expect(next.id).not.toBe(preview.id);
    expect(tabs.map(t => t.id)).toContain(next.id);
  });
});
