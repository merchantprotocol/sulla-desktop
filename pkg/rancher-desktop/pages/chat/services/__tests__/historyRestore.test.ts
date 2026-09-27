import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.unstable_mockModule('@pkg/utils/ipcRenderer', () => ({
  ipcRenderer: {
    invoke: jest.fn(() => Promise.resolve({ success: true })),
    send:   jest.fn(),
    on:     jest.fn(),
  },
}));

const restoreHistoryTab = jest.fn((id: string, title: string) => ({ id, title, mode: 'chat' }));

jest.unstable_mockModule('@pkg/composables/useBrowserTabs', () => ({
  useBrowserTabs: () => ({ restoreHistoryTab }),
}));

const { resolveHistoryChatTabId, restoreChatFromHistory } = await import('../historyRestore');

describe('historyRestore', () => {
  beforeEach(() => {
    localStorage.clear();
    restoreHistoryTab.mockClear();
  });

  it('reopens a chat row in its original tab, not a fresh one', () => {
    localStorage.setItem('chat:tab:tab_1', 't_1');

    const tab = restoreChatFromHistory({ id: 'tab_1', type: 'chat', tab_id: 'tab_1', title: 'pip' });

    expect(restoreHistoryTab).toHaveBeenCalledWith('tab_1', 'pip');
    expect(tab.id).toBe('tab_1');
  });

  it('re-seeds a lost tab→thread pointer from the durable History link', () => {
    const tabId = resolveHistoryChatTabId({ id: 'tab_2', type: 'chat', tab_id: 'tab_2', thread_id: 't_2' });

    expect(tabId).toBe('tab_2');
    expect(localStorage.getItem('chat:tab:tab_2')).toBe('t_2');
  });

  it('never overwrites an existing pointer', () => {
    localStorage.setItem('chat:tab:tab_3', 't_current');

    resolveHistoryChatTabId({ id: 'tab_3', type: 'chat', tab_id: 'tab_3', thread_id: 't_old' });

    expect(localStorage.getItem('chat:tab:tab_3')).toBe('t_current');
  });

  it('maps a backend graph row to the tab whose persona owns that thread', () => {
    localStorage.setItem('chat_threadId_sulla-desktop_tab_4', 'thread_99_x');

    const tabId = resolveHistoryChatTabId({ id: 'thread_99_x', type: 'graph', thread_id: 'thread_99_x' });

    expect(tabId).toBe('tab_4');
    // A graph thread id is not a chat thread id — must not be written as the chat pointer.
    expect(localStorage.getItem('chat:tab:tab_4')).toBeNull();
  });
});
