// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { reactive } from 'vue';

import type { ChatTabActivity } from '@pkg/shared/chatTabActivity';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

/** Each chat tab's current activity, keyed by browser tab id, for the tab strip's dots. */
export const chatActivityByTab = reactive(new Map<string, ChatTabActivity>());

export function receiveChatActivity(_event: unknown, tabId: string, state: ChatTabActivity | null): void {
  if (state === null) chatActivityByTab.delete(tabId);
  else chatActivityByTab.set(tabId, state);
}

export function publishChatActivity(tabId: string, state: ChatTabActivity | null): void {
  receiveChatActivity(null, tabId, state);
  const search = new URLSearchParams(window.location.search);
  if (search.get('tabHost') === '1' && search.get('tabId') === tabId) {
    ipcRenderer.send('internal-tab-view:chat-activity', tabId, state);
  }
}
