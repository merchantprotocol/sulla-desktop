import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { nextTick } from 'vue';

jest.unstable_mockModule('@pkg/utils/ipcRenderer', () => ({
  ipcRenderer: {
    send:   jest.fn(),
    invoke: jest.fn(() => Promise.resolve([])),
    on:     jest.fn(),
  },
}));

async function load() {
  jest.resetModules();

  return import('../useBrowserTabs');
}

describe('useBrowserTabs pinned tabs', () => {
  afterEach(() => {
    localStorage.clear();
    jest.clearAllMocks();
  });

  it('persists pin and unpin while keeping pinned ids first', async() => {
    localStorage.setItem('sulla:tab-order', JSON.stringify(['browser-a', 'browser-b', 'browser-c']));
    const { useBrowserTabs } = await load();
    const { pinnedTabIds, setTabPinned, tabOrder } = useBrowserTabs();

    setTabPinned('browser-c', true);
    await nextTick();

    expect(pinnedTabIds.value).toEqual(['browser-c']);
    expect(tabOrder.value).toEqual(['browser-c', 'browser-a', 'browser-b']);
    expect(JSON.parse(localStorage.getItem('sulla:pinned-tabs')!)).toEqual(['browser-c']);

    setTabPinned('browser-c', false);
    await nextTick();

    expect(pinnedTabIds.value).toEqual([]);
    expect(tabOrder.value).toEqual(['browser-c', 'browser-a', 'browser-b']);
    expect(JSON.parse(localStorage.getItem('sulla:pinned-tabs')!)).toEqual([]);
  });

  it('keeps drag reordering inside the pinned or normal group', async() => {
    localStorage.setItem('sulla:tab-order', JSON.stringify(['browser-a', 'browser-b', 'browser-c']));
    localStorage.setItem('sulla:pinned-tabs', JSON.stringify(['browser-a']));
    const { useBrowserTabs } = await load();
    const { reorderTabs, tabOrder } = useBrowserTabs();

    reorderTabs(0, 2);
    expect(tabOrder.value).toEqual(['browser-a', 'browser-b', 'browser-c']);

    reorderTabs(2, 0);
    expect(tabOrder.value).toEqual(['browser-a', 'browser-c', 'browser-b']);
  });
});
