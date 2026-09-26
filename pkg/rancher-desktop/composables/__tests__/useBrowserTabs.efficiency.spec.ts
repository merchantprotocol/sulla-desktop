import { afterEach, describe, expect, it, jest } from '@jest/globals';

const mockSend = jest.fn();

jest.unstable_mockModule('@pkg/utils/ipcRenderer', () => ({
  ipcRenderer: {
    send:   mockSend,
    invoke: jest.fn(() => Promise.resolve([])),
    on:     jest.fn(),
  },
}));

async function load() {
  jest.resetModules();
  localStorage.clear();

  return import('../useBrowserTabs');
}

const historyRecords = () => mockSend.mock.calls.filter(call => call[0] === 'conversation-history:record');

describe('useBrowserTabs efficiency', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it('ignores updates that do not change anything (no history write, no persist)', async() => {
    const { useBrowserTabs } = await load();
    const { createTab, updateTab, getTab } = useBrowserTabs();
    const tab = createTab('https://example.com/');
    const before = getTab(tab.id)!.lastAccessedAt;
    mockSend.mockClear();

    for (let i = 0; i < 5; i++) updateTab(tab.id, { url: 'https://example.com/', title: getTab(tab.id)!.title });

    expect(historyRecords()).toHaveLength(0);
    expect(getTab(tab.id)!.lastAccessedAt).toBe(before);
  });

  it('records history once per real navigation', async() => {
    const { useBrowserTabs } = await load();
    const { createTab, updateTab } = useBrowserTabs();
    const tab = createTab('https://example.com/');
    mockSend.mockClear();

    updateTab(tab.id, { url: 'https://example.com/next', title: 'Next' });
    updateTab(tab.id, { url: 'https://example.com/next', title: 'Next' });

    expect(historyRecords()).toHaveLength(1);
  });

  it('debounces tab persistence into a single localStorage write', async() => {
    jest.useFakeTimers();
    const { useBrowserTabs } = await load();
    const { createTab, updateTab } = useBrowserTabs();
    const setItem = jest.spyOn(Storage.prototype, 'setItem');
    const tab = createTab('https://example.com/');

    for (let i = 0; i < 10; i++) {
      updateTab(tab.id, { title: `Loading ${ i }` });
      await Promise.resolve();
    }
    const writes = () => setItem.mock.calls.filter(call => call[0] === 'sulla:browser-tabs').length;
    expect(writes()).toBe(0);

    jest.advanceTimersByTime(300);
    expect(writes()).toBe(1);
    expect(JSON.parse(localStorage.getItem('sulla:browser-tabs')!).some((t: any) => t.title === 'Loading 9')).toBe(true);
    setItem.mockRestore();
  });
});
