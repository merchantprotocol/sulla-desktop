// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { reactive } from 'vue';

import type { ChatTabActivity } from '@pkg/shared/chatTabActivity';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

/** Each chat tab's activity, keyed by browser tab id, for the tab strip's dots. */
export class ChatTabActivityStore {
  readonly activityByTab = reactive(new Map<string, ChatTabActivity>());

  readonly receive = (_event: unknown, tabId: string, state: ChatTabActivity | null): void => {
    if (state === null) this.activityByTab.delete(tabId);
    else this.activityByTab.set(tabId, state);
  };

  readonly publish = (tabId: string, state: ChatTabActivity | null): void => {
    this.receive(null, tabId, state);
    const search = new URLSearchParams(window.location.search);
    if (search.get('tabHost') === '1' && search.get('tabId') === tabId) {
      ipcRenderer.send('internal-tab-view:chat-activity', tabId, state);
    }
  };
}

const store = new ChatTabActivityStore();

export const chatActivityByTab = store.activityByTab;
export const receiveChatActivity = store.receive;
export const publishChatActivity = store.publish;
