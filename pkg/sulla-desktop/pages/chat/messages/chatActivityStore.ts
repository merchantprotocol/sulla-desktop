// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { reactive } from 'vue';

import type { ChatTabActivity } from '@pkg/shared/chatTabActivity';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

export class ChatActivityStore {
  /** Each chat tab's current activity, keyed by browser tab id, for the tab strip's dots. */
  readonly byTab = reactive(new Map<string, ChatTabActivity>());

  receive(_event: unknown, tabId: string, state: ChatTabActivity | null): void {
    if (state === null) this.byTab.delete(tabId);
    else this.byTab.set(tabId, state);
  }

  publish(tabId: string, state: ChatTabActivity | null): void {
    this.receive(null, tabId, state);
    const search = new URLSearchParams(window.location.search);
    if (search.get('tabHost') === '1' && search.get('tabId') === tabId) {
      ipcRenderer.send('internal-tab-view:chat-activity', tabId, state);
    }
  }
}

export const chatActivityStore = new ChatActivityStore();
export const chatActivityByTab = chatActivityStore.byTab;
export const receiveChatActivity = (event: unknown, tabId: string, state: ChatTabActivity | null) => chatActivityStore.receive(event, tabId, state);
export const publishChatActivity = (tabId: string, state: ChatTabActivity | null) => chatActivityStore.publish(tabId, state);
