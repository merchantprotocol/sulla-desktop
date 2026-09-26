/*
  historyRestore — the one path every History surface (History tab, app
  menu, in-chat history rail) uses to reopen a past conversation.

  A chat conversation is displayed by a tab: ChatPage looks up the tab's
  thread via the chat:tab:<tabId> pointer, and the persona reuses the tab's
  backend thread id, so reopening means restoring the ORIGINAL tab id —
  never minting a fresh tab, which is what showed a blank "new chat" page.
*/

import { LocalStoragePersister } from './LocalStoragePersister';
import { asThreadId } from '../types/chat';

import { useBrowserTabs, type BrowserTab } from '@pkg/composables/useBrowserTabs';

export interface HistoryChatEntry {
  id:         string;
  type?:      string;
  title?:     string;
  tab_id?:    string;
  thread_id?: string;
}

/**
 * Resolve which tab displays `entry`, re-seeding the tab→thread pointer from
 * the durable History link when this renderer lost it.
 */
export function resolveHistoryChatTabId(entry: HistoryChatEntry, persister = new LocalStoragePersister()): string {
  // Chat rows carry their tab id. Graph rows (backend conversations) don't —
  // map their backend thread id back to the tab whose persona owns it.
  const tabId = entry.tab_id ||
    persister.findTabForThread(entry.thread_id || entry.id) ||
    entry.id;

  // Only chat rows link to a chat_messages thread; a graph row's thread_id is
  // the backend graph id and must not be written into the chat pointer.
  if (entry.type === 'chat' && entry.thread_id && !persister.getTabThread(tabId)) {
    persister.setTabThread(tabId, asThreadId(entry.thread_id));
  }

  return tabId;
}

/** Reopen a chat conversation from History in its original tab. */
export function restoreChatFromHistory(entry: HistoryChatEntry): BrowserTab {
  const { restoreHistoryTab } = useBrowserTabs();

  return restoreHistoryTab(resolveHistoryChatTabId(entry), entry.title || '');
}
